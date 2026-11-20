import type { SupabaseClient } from '@supabase/supabase-js'

import { CONFIRMED_ITEM_COLUMNS, CONFIRMED_ORDER_COLUMNS, toOrder } from '@/lib/orders/confirmed-orders'
import { fail, mapRpcError, type ServiceResult } from '@/lib/orders/logistics/documents'
import { isUuid } from '@/lib/orders/logistics/files'
import { classifySendError } from '@/lib/orders/logistics/packaging'
import { buildTemplateBodyParams } from '@/lib/orders/logistics/template-params'
import { nextMessageAttempt, type ShalomConfig } from '@/lib/orders/shalom/config'
import { extractVariableIndices } from '@/lib/whatsapp/template-validators'
import { resolveTemplateRow } from '@/lib/whatsapp/template-body'
import { sendMessageToConversation, type SendMessageParams, type SendMessageResult } from '@/lib/whatsapp/send-message'

// PR-05A · the automatic message to the CUSTOMER at day 15 En destino. The decision "this message is due" is the database's (evaluate_pickup_day15 writes ONE
// ledger row per order + episode); this file only SENDS it, through the EXISTING WhatsApp infrastructure (sendMessageToConversation: the order's own
// conversation_id, the same number, the same persisted messages: the message shows in the same Inbox history; no chat is ever created). Nothing about Meta
// is modified and NO template is frozen: name / language / variables are configuration of the account (order_shipment_settings), resolved against the
// account's existing message_templates. The real Meta template is PENDING PRE-DEPLOY; locally the Meta simulator answers.
//
// SAFETY (same pattern as PR-04's dispatches): claim (token + lease) -> last check -> mark `sending` -> send -> finish.
//   * a failure BEFORE Meta (no template, no conversation, rejected) is `failed`: bounded automatic retries with backoff, then a person can retry;
//   * a failure AFTER Meta may have accepted (lost answer, message not saved, process died) is `uncertain`: NEVER re-sent automatically, a person resolves it;
//   * a message whose shipment is no longer En destino (delivered / corrected / stopped) is `skipped`, never sent.
// The message and the tracking are INDEPENDENT: nothing here touches the Shalom status, the tracking, the internal alert or the day-20 abandonment.

export type SendFn = (db: SupabaseClient, accountId: string, params: SendMessageParams) => Promise<SendMessageResult>

export interface ClaimedMessage {
  id: string
  account_id: string
  order_id: string
  destination_episode: number
  conversation_id: string | null
  template_name: string | null
  template_language: string | null
  template_params: unknown[] | null
  claim_token: string
  attempt: number
}

export interface MessageDeps {
  cfg: ShalomConfig
  now?: () => Date
  /** Injectable for tests; defaults to the real send core. */
  sendMessage?: SendFn
}

export interface MessageTickResult {
  claimed: number
  sent: number
  failed: number
  uncertain: number
  skipped: number
  errors: number
}

export const emptyMessageTick = (): MessageTickResult => ({ claimed: 0, sent: 0, failed: 0, uncertain: 0, skipped: 0, errors: 0 })

const clock = (deps: MessageDeps) => (deps.now ? deps.now() : new Date())
const DEFAULT_PARAMS = ['customer_name']

async function finish(admin: SupabaseClient, m: ClaimedMessage, deps: MessageDeps, outcome: 'sent' | 'failed' | 'uncertain', extra: { messageRowId?: string; wamid?: string; code?: string; detail?: string } = {}) {
  const now = clock(deps)
  const { error } = await admin.rpc('finish_shipment_message', {
    p_account: m.account_id,
    p_message: m.id,
    p_token: m.claim_token,
    p_outcome: outcome,
    p_message_row: extra.messageRowId || null,
    p_wamid: extra.wamid ?? null,
    p_error_code: extra.code ?? null,
    p_error_detail: extra.detail ?? null,
    p_next_attempt_at: outcome === 'failed' && !NO_AUTO_RETRY.has(extra.code ?? '') ? nextMessageAttempt(m.attempt, now, deps.cfg)?.toISOString() ?? null : null,
    p_now: now.toISOString(),
  })
  return error
}

/** Failures a retry cannot fix by itself (configuration / data): they wait for a person instead of burning the automatic attempts. */
const NO_AUTO_RETRY = new Set(['template_not_configured', 'template_not_found', 'template_not_approved', 'template_malformed', 'template_params_mismatch', 'invalid_params_config', 'order_without_conversation'])

/** Sends ONE claimed message. Never throws: every problem becomes a recorded outcome. */
export async function sendClaimedMessage(admin: SupabaseClient, m: ClaimedMessage, deps: MessageDeps): Promise<'sent' | 'failed' | 'uncertain' | 'skipped' | 'error'> {
  const send = deps.sendMessage ?? sendMessageToConversation
  const failBeforeMeta = async (code: string) => ((await finish(admin, m, deps, 'failed', { code })) ? 'error' : 'failed')

  if (!m.conversation_id) return failBeforeMeta('order_without_conversation')
  if (!m.template_name || !m.template_language) return failBeforeMeta('template_not_configured')

  const resolved = await resolveTemplateRow(admin, m.account_id, m.template_name, m.template_language)
  if (resolved.malformed) return failBeforeMeta('template_malformed')
  const template = resolved.row as { body_text: string; status?: string; header_type?: string | null } | null
  if (!template) return failBeforeMeta('template_not_found')
  if (String(template.status ?? '').toUpperCase() !== 'APPROVED') return failBeforeMeta('template_not_approved')
  const fields = Array.isArray(m.template_params) ? m.template_params : DEFAULT_PARAMS
  if (extractVariableIndices(template.body_text).length !== fields.length) return failBeforeMeta('template_params_mismatch')

  const { data: orderRow } = await admin.from('order_confirmations').select(`${CONFIRMED_ORDER_COLUMNS}, dni`).eq('account_id', m.account_id).eq('id', m.order_id).maybeSingle()
  if (!orderRow) return failBeforeMeta('order_not_found')
  const { data: items } = await admin.from('order_confirmation_items').select(CONFIRMED_ITEM_COLUMNS).eq('account_id', m.account_id).eq('order_id', m.order_id).order('line_number', { ascending: true })
  const order = toOrder(orderRow as unknown as Parameters<typeof toOrder>[0], (items ?? []) as unknown as Parameters<typeof toOrder>[1])
  const built = buildTemplateBodyParams(
    { customer_name: order.customer_name, product_summary: order.product_summary, quantity: order.quantity, total: order.total, destination: order.destination, seller_name: order.seller_name, dni: (orderRow as { dni: string | null }).dni },
    fields,
  )
  if (!built.ok) return failBeforeMeta('invalid_params_config')

  const { data: marked, error: markError } = await admin.rpc('mark_shipment_message_sending', { p_account: m.account_id, p_message: m.id, p_token: m.claim_token, p_lease_seconds: deps.cfg.leaseSeconds, p_now: clock(deps).toISOString() })
  if (markError) return 'error'
  const mk = (marked ?? {}) as { ok?: boolean; reason?: string }
  if (mk.ok !== true) return mk.reason === 'skipped' ? 'skipped' : 'error'

  let sent: SendMessageResult
  try {
    sent = await send(admin, m.account_id, {
      conversationId: m.conversation_id,
      messageType: 'template',
      templateName: m.template_name,
      templateLanguage: resolved.language,
      templateParams: built.params,
      templateMessageParams: { body: built.params },
      origin: 'automated',
    })
  } catch (error) {
    const verdict = classifySendError(error)
    return (await finish(admin, m, deps, verdict.outcome, { code: verdict.code })) ? 'error' : verdict.outcome
  }
  // The message IS in WhatsApp and in the chat; if only our bookkeeping fails it stays `sending` and turns `uncertain` by itself: never re-sent.
  const bookkeeping = await finish(admin, m, deps, 'sent', { messageRowId: sent.messageId, wamid: sent.whatsappMessageId })
  return bookkeeping ? 'error' : 'sent'
}

/** One tick of the customer-message sender: claim due messages (SKIP LOCKED + token + lease) and send them one by one. */
export async function processCustomerMessages(admin: SupabaseClient, deps: MessageDeps): Promise<MessageTickResult> {
  const out = emptyMessageTick()
  try {
    const { data, error } = await admin.rpc('claim_shipment_messages', { p_limit: deps.cfg.batchSize, p_lease_seconds: deps.cfg.leaseSeconds, p_max_attempts: deps.cfg.messageMaxAttempts, p_order: null, p_now: clock(deps).toISOString() })
    if (error) {
      out.errors += 1
      console.error('[shalom] message claim failed:', error.code)
      return out
    }
    for (const m of (data ?? []) as ClaimedMessage[]) {
      out.claimed += 1
      const r = await sendClaimedMessage(admin, m, deps).catch(() => 'error' as const)
      if (r === 'error') out.errors += 1
      else out[r] += 1
    }
  } catch (e) {
    out.errors += 1
    console.error('[shalom] message tick failed:', e instanceof Error ? e.name : 'unknown')
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// actor-facing (Logística / Supervisor)
// ---------------------------------------------------------------------------------------------------------------------------------------------

const REASON_STATUS: Record<string, number> = { not_failed: 409, needs_resolution: 409, no_longer_at_destination: 409, not_uncertain: 409, invalid_resolution: 400 }

/** Controlled retry of a FAILED message: it becomes pending and is sent by the next tick (never an immediate duplicate: the ledger row is the same). */
export async function retryCustomerMessage(ctx: { userId: string; accountId: string }, admin: SupabaseClient, messageId: unknown, now: Date = new Date()): Promise<ServiceResult<{ queued: boolean }>> {
  if (!isUuid(messageId)) return fail(400, 'invalid_message_id')
  const { data, error } = await admin.rpc('retry_shipment_message', { p_account: ctx.accountId, p_actor: ctx.userId, p_message: messageId, p_now: now.toISOString() })
  if (error) return mapRpcError(error)
  const out = (data ?? {}) as { ok?: boolean; reason?: string }
  return out.ok === true ? { ok: true, status: 200, body: { queued: true } } : fail(REASON_STATUS[out.reason ?? ''] ?? 409, out.reason ?? 'rejected')
}

/** A person looked at the conversation: the UNCERTAIN message was (or was not) delivered. Never an automatic re-send. */
export async function resolveCustomerMessage(ctx: { userId: string; accountId: string }, admin: SupabaseClient, messageId: unknown, resolution: unknown, now: Date = new Date()): Promise<ServiceResult<{ status: string }>> {
  if (!isUuid(messageId)) return fail(400, 'invalid_message_id')
  if (resolution !== 'confirmed_sent' && resolution !== 'confirmed_not_sent') return fail(400, 'invalid_resolution')
  const { data, error } = await admin.rpc('resolve_shipment_message', { p_account: ctx.accountId, p_actor: ctx.userId, p_message: messageId, p_resolution: resolution, p_now: now.toISOString() })
  if (error) return mapRpcError(error)
  const out = (data ?? {}) as { ok?: boolean; reason?: string; status?: string }
  return out.ok === true ? { ok: true, status: 200, body: { status: out.status ?? 'failed' } } : fail(REASON_STATUS[out.reason ?? ''] ?? 409, out.reason ?? 'rejected')
}
