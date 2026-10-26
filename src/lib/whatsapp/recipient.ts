/**
 * Who a WhatsApp message is addressed to: a phone number (`to`) or, for a user who hides their number, the BSUID
 * (`recipient`). Meta's contract: set `recipient` to the BSUID and omit `to`; if both are sent, `to` wins — so exactly
 * one of them is ever produced here.
 *
 * Phone contacts keep every existing behaviour (digits-only `to`, trunk-prefix retries, healing of `contacts.phone`).
 * A BSUID is sent once, as is: no prefix variants, and `contacts.phone` is never modified because of it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { hasMinRole, isAccountRole } from '@/lib/auth/roles'
import { isValidE164, phoneVariants, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils'
import { isBsuidPilotEnabledWithScopes } from '@/lib/whatsapp/bsuid-pilot'
import { bsuidFlowSendCheck, getDbPilotScopes, type FlowSendModality } from '@/lib/whatsapp/bsuid-flow-auth'

/** Argument accepted by every send function: a digits-only phone (as before) or `{ bsuid }`. */
export type WaTarget = string | { bsuid: string }

export function recipientFields(target: WaTarget): { to: string } | { recipient: string } {
  return typeof target === 'string' ? { to: target } : { recipient: target.bsuid }
}

export type ResolvedTarget = { kind: 'phone'; phone: string } | { kind: 'bsuid'; bsuid: string }

/** The addresses to try, in order: prefix variants for a phone, exactly one attempt for a BSUID. */
export function targetAttempts(target: ResolvedTarget): WaTarget[] {
  return target.kind === 'phone' ? phoneVariants(target.phone) : [{ bsuid: target.bsuid }]
}

/** Short, data-free description for logs and errors. */
export function describeTarget(target: ResolvedTarget): 'phone' | 'bsuid' {
  return target.kind
}

/**
 * Who is asking to send: a person replying from the Inbox (`manual_reply`), a Flow run (`flow`, only from the Flows engine, only with the id of its own
 * ACTIVE run, and only while the DB authorization of migration 078 allows that flow, contact and modality), or anything else automatic
 * (automation, AI, public API: `automated`, always refused for a BSUID during the pilot).
 */
export type SendOrigin = 'manual_reply' | 'automated' | 'flow'

/**
 * The signed-in person behind a `manual_reply`. ONLY the dashboard send route creates one, from the `requireRole('agent')` context
 * (never from the request body). Without it a `manual_reply` is refused, so nothing else (Flow, automation, AI, public API) can
 * pass itself off as a person replying from the Inbox.
 */
export interface ManualSendActor { userId: string }

export type BsuidSendBlockCode = 'bsuid_disabled' | 'bsuid_automated_blocked' | 'bsuid_not_authorized' | 'bsuid_check_failed' | 'bsuid_flow_not_authorized'

/** Raised instead of sending when the BSUID pilot rules do not allow this message. Nothing was sent and nothing was stored. */
export class BsuidSendBlockedError extends Error {
  readonly code: BsuidSendBlockCode
  constructor(code: BsuidSendBlockCode) {
    super(`BSUID send blocked: ${code}`)
    this.name = 'BsuidSendBlockedError'
    this.code = code
  }
}

/**
 * Decide the destination of an outbound message for a contact. EVERY sender goes through here (Flows, automations, AI,
 * audio engines, Inbox, public API, reactions), so the pilot rules for a BSUID cannot be bypassed by a side path:
 *  1. a valid phone → phone, exactly as before, with no extra query and no pilot rule;
 *  2. otherwise the contact's ACTIVE BSUID, but only when
 *       a. the BSUID switch is on for this account's own number (account + phone_number_id + WABA, see bsuid-pilot.ts),
 *       b. the sender is a person replying manually (`origin: 'manual_reply'`): Flows, automations, AI and API stay blocked,
 *       c. the operator authorized this exact contact and one authorization is consumed atomically right now;
 *  3. otherwise the same errors as before (`contact not found for this account` when there is no phone at all,
 *     `contact phone invalid: …` when there is one that is not valid).
 * Every block and every consumed authorization is audited (`contact_identity_audit`), without ids or message content in the
 * application log. A failed Meta call after this point does NOT give the authorization back: authorize again explicitly.
 */
export async function resolveContactTarget(
  db: SupabaseClient,
  accountId: string,
  contact: { id: string; phone?: string | null },
  opts: { origin: SendOrigin; actor?: ManualSendActor; flowRun?: { id: string; modality: FlowSendModality } },
): Promise<ResolvedTarget> {
  const sanitized = sanitizePhoneForMeta(contact.phone ?? '')
  if (sanitized && isValidE164(sanitized)) return { kind: 'phone', phone: sanitized }

  const { data, error } = await db
    .from('contact_identities')
    .select('value')
    .eq('account_id', accountId)
    .eq('contact_id', contact.id)
    .eq('kind', 'bsuid')
    .is('superseded_at', null)
    .maybeSingle()
  const bsuid = !error && data && typeof (data as { value?: unknown }).value === 'string' ? (data as { value: string }).value : ''
  if (!bsuid) {
    if (!sanitized) throw new Error('contact not found for this account')
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  // consume_bsuid_send / audit_bsuid_event are EXECUTE-able by service_role only (migration 077 revokes them from anon/authenticated on purpose:
  // an agent's own session must never be able to mint or spend a send credit by itself). The Inbox calls this with the agent's RLS client, so the
  // privileged calls below ALWAYS go through the server-side service-role client — after the caller has been verified again here.
  const block = async (code: BsuidSendBlockCode, reason?: string): Promise<never> => {
    console.warn('[send] BSUID send blocked', { code, origin: opts.origin, account_id: accountId })
    try {
      await supabaseAdmin().rpc('audit_bsuid_event', { p_account_id: accountId, p_contact_id: contact.id, p_event: 'send_blocked', p_origin: opts.origin, p_detail: reason ? { code, reason } : { code } })
    } catch { /* the block already holds; the audit is best effort */ }
    throw new BsuidSendBlockedError(code)
  }

  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('phone_number_id, waba_id')
    .eq('account_id', accountId)
    .maybeSingle()
  const cfg = config as { phone_number_id?: string; waba_id?: string } | null
  if (configError || !cfg || !isBsuidPilotEnabledWithScopes({ accountId, phoneNumberId: cfg.phone_number_id, wabaId: cfg.waba_id }, await getDbPilotScopes())) return block('bsuid_disabled')
  if (opts.origin === 'flow') {
    // A Flow run: no manual credit is used. The run must be a real ACTIVE run of THIS contact and every flow of its call stack must be
    // authorized for this contact and this modality (bsuid_flow_send_check, evaluated on every send, so the kill switch acts at once).
    if (!opts.flowRun?.id) return block('bsuid_automated_blocked')
    const verdict = await bsuidFlowSendCheck(accountId, opts.flowRun.id, contact.id, opts.flowRun.modality)
    if (verdict === 'check_failed') return block('bsuid_check_failed')
    if (verdict !== 'ok') return block('bsuid_flow_not_authorized', verdict)
    return { kind: 'bsuid', bsuid }
  }
  if (opts.origin !== 'manual_reply') return block('bsuid_automated_blocked')
  // A manual reply must carry the verified person; a bare `origin: 'manual_reply'` from any other code path is not enough.
  if (!opts.actor?.userId) return block('bsuid_automated_blocked')

  // Re-verify, with the privileged client, that this person is an agent (or above) of THIS account and that the contact is in it.
  // Any read error fails closed.
  const admin = supabaseAdmin()
  const [profileRes, ownedRes] = await Promise.all([
    admin.from('profiles').select('account_id, account_role').eq('user_id', opts.actor.userId).maybeSingle(),
    admin.from('contacts').select('id').eq('id', contact.id).eq('account_id', accountId).maybeSingle(),
  ])
  if (profileRes.error || ownedRes.error) return block('bsuid_check_failed')
  const profile = profileRes.data as { account_id?: string; account_role?: string } | null
  if (!profile || profile.account_id !== accountId || !isAccountRole(profile.account_role) || !hasMinRole(profile.account_role, 'agent') || !ownedRes.data) {
    return block('bsuid_not_authorized')
  }

  const { data: allowed, error: consumeError } = await admin.rpc('consume_bsuid_send', { p_account_id: accountId, p_contact_id: contact.id, p_origin: opts.origin })
  if (consumeError) return block('bsuid_check_failed')
  if (allowed !== true) return block('bsuid_not_authorized')
  return { kind: 'bsuid', bsuid }
}
