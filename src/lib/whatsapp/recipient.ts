/**
 * Who a WhatsApp message is addressed to: a phone number (`to`) or, for a user who hides their number, the BSUID
 * (`recipient`). Meta's contract: set `recipient` to the BSUID and omit `to`; if both are sent, `to` wins — so exactly
 * one of them is ever produced here.
 *
 * Phone contacts keep every existing behaviour (digits-only `to`, trunk-prefix retries, healing of `contacts.phone`).
 * A BSUID is sent once, as is: no prefix variants, and `contacts.phone` is never modified because of it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isValidE164, phoneVariants, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils'

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
 * Decide the destination of an outbound message for a contact.
 *  1. a valid phone → phone (unchanged behaviour);
 *  2. otherwise the contact's ACTIVE BSUID of this account;
 *  3. otherwise the same errors as before (`contact not found for this account` when there is no phone at all,
 *     `contact phone invalid: …` when there is one that is not valid).
 * The database is only consulted when the phone is missing or invalid, so phone contacts cost nothing extra.
 */
export async function resolveContactTarget(
  db: SupabaseClient,
  accountId: string,
  contact: { id: string; phone?: string | null },
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
  if (!error && data && typeof (data as { value?: unknown }).value === 'string' && (data as { value: string }).value) {
    return { kind: 'bsuid', bsuid: (data as { value: string }).value }
  }
  if (!sanitized) throw new Error('contact not found for this account')
  throw new Error(`contact phone invalid: ${contact.phone}`)
}
