import type { SupabaseClient } from '@supabase/supabase-js'

import { ForbiddenError } from '@/lib/auth/account'
import { assertConversationOperationalAccess } from '@/lib/conversations/operational-access'
import { CONFIRMED_ITEM_COLUMNS, CONFIRMED_ORDER_COLUMNS, toOrder } from '@/lib/orders/confirmed-orders'
import type { LogisticsCaller } from '@/lib/orders/logistics/access'
import { ORDER_DOCS_BUCKET, REQUEST_KEY_PATTERN } from '@/lib/orders/logistics/constants'
import { fail, mapRpcError, type ServiceResult } from '@/lib/orders/logistics/documents'
import { isUuid } from '@/lib/orders/logistics/files'
import { buildTemplateBodyParams } from '@/lib/orders/logistics/template-params'
import { formatSoles, readPaymentInstructions, resolveOrderBalance, type OrderBalance } from '@/lib/orders/payments/balance'
import { resolveTemplateRow } from '@/lib/whatsapp/template-body'
import { extractVariableIndices } from '@/lib/whatsapp/template-validators'
import { SendMessageError, sendMessageToConversation, type SendMessageParams, type SendMessageResult } from '@/lib/whatsapp/send-message'

// PACKAGING: start it, send the operational WhatsApp template (with the order's evidence as the header media when the template has one) and, only
// after a CONFIRMED send, move the order to "listo para despacho". The send itself is the EXISTING WhatsApp infrastructure, untouched
// (sendMessageToConversation -> same conversation_id, same persisted messages, same Meta core); this file wraps it with its OWN operational ledger
// (order_template_dispatches), because the generic send has no idempotency and calls Meta before it persists:
//
//   begin (claim, per order + request_key)  ->  everything that can fail BEFORE Meta is checked here and, if it fails, recorded as `failed`
//   ->  mark `sending`  ->  Meta call  ->  finish: sent (+ packaging completed, one transaction) | failed | uncertain
//
//   * double click / HTTP retry / two operators: the same key never sends twice; another key while one is open is refused;
//   * failure before Meta: `failed`, the order stays in packing, the same key can retry;
//   * failure AFTER Meta accepted (message not saved, lost answer, process died): `uncertain` — never re-sent automatically, a person resolves it;
//   * the order only becomes ready_for_dispatch with a `sent` dispatch.
// Template name / language / variables come from order_logistics_settings + the account's existing message_templates. Nothing is hardcoded.

const HEADER_URL_TTL_SECONDS = 600
const NETWORK_ERROR = /fetch failed|network|timeout|timed out|aborted|ECONN|ETIMEDOUT|ENOTFOUND|socket|UND_ERR/i

export type SendMessageFn = (db: SupabaseClient, accountId: string, params: SendMessageParams) => Promise<SendMessageResult>

export interface PackagingDeps {
  sendMessage?: SendMessageFn
}

/** How a failure of the send core is recorded. `failed` = nothing reached WhatsApp; `uncertain` = it may have. */
export function classifySendError(error: unknown): { outcome: 'failed' | 'uncertain'; code: string } {
  if (error instanceof SendMessageError) {
    if (/but failed to save/i.test(error.message)) return { outcome: 'uncertain', code: 'persist_failed' }
    if (error.code === 'meta_error') return NETWORK_ERROR.test(error.message) ? { outcome: 'uncertain', code: 'meta_unreachable' } : { outcome: 'failed', code: 'meta_rejected' }
    if (error.code === 'manychat_error') return { outcome: 'uncertain', code: 'transport_error' }
    const code = error.code.toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 40)
    return { outcome: 'failed', code: code || 'send_failed' }
  }
  return { outcome: 'uncertain', code: 'send_unknown_error' }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// start packaging
// ---------------------------------------------------------------------------------------------------------------------------------------------

export async function startPackaging(ctx: Pick<LogisticsCaller, 'userId' | 'accountId'>, admin: SupabaseClient, orderId: string): Promise<ServiceResult<{ status: string; changed: boolean }>> {
  if (!isUuid(orderId)) return fail(400, 'invalid_order_id')
  const { data, error } = await admin.rpc('start_order_packaging', { p_account: ctx.accountId, p_actor: ctx.userId, p_order: orderId })
  if (error) return mapRpcError(error)
  const out = (data ?? {}) as { ok?: boolean; changed?: boolean; status?: string; reason?: string }
  if (out.ok !== true) return fail(409, out.reason ?? 'rejected')
  return { ok: true, status: 200, body: { status: out.status ?? 'packing', changed: out.changed !== false } }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// send the operational template
// ---------------------------------------------------------------------------------------------------------------------------------------------

export interface PackagingSendBody {
  dispatch_id: string
  status: 'sent' | 'failed' | 'uncertain'
  order_status: 'ready_for_dispatch' | 'packing'
  attempt?: number
  replay?: boolean
  error_code?: string
}

const BEGIN_REASON_STATUS: Record<string, number> = {
  in_progress: 409,
  uncertain: 409,
  dispatch_open: 409,
  not_packing: 409,
  evidence_required: 409,
  already_ready: 409,
  order_without_conversation: 409,
}

export async function sendPackagingTemplate(
  ctx: Pick<LogisticsCaller, 'supabase' | 'userId' | 'accountId'>,
  admin: SupabaseClient,
  orderId: string,
  requestKey: unknown,
  deps: PackagingDeps = {},
): Promise<ServiceResult<PackagingSendBody>> {
  if (!isUuid(orderId)) return fail(400, 'invalid_order_id')
  if (typeof requestKey !== 'string' || !REQUEST_KEY_PATTERN.test(requestKey)) return fail(400, 'invalid_request_key')
  const sendMessage = deps.sendMessage ?? sendMessageToConversation

  // ---- 1. configuration (nothing is claimed while the template is not configured / not usable) ----
  const { data: settings, error: settingsError } = await admin
    .from('order_logistics_settings')
    .select('packaging_template_name, packaging_template_language, packaging_template_params, packaging_balance_template_name, packaging_balance_template_language, packaging_balance_template_params')
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (settingsError) return fail(500, 'internal_error')
  const base = settings as {
    packaging_template_name: string | null; packaging_template_language: string | null; packaging_template_params: unknown[] | null
    packaging_balance_template_name: string | null; packaging_balance_template_language: string | null; packaging_balance_template_params: unknown[] | null
  } | null
  if (!base?.packaging_template_name || !base.packaging_template_language) return fail(409, 'template_not_configured')

  // Which VARIANT: the existing template is the one for a fully paid order. When the account ALSO configured a balance variant, the PR-06 financial row decides
  // (pending > 0 -> balance variant, pending = 0 -> the base one). An order with no financial row (NOT TRACKED) has no balance: it is refused, never treated as
  // zero. With no balance variant configured nothing of this applies and the behaviour is exactly the previous one.
  let cfg = { packaging_template_name: base.packaging_template_name, packaging_template_language: base.packaging_template_language, packaging_template_params: base.packaging_template_params }
  let balance: OrderBalance | null = null
  if (base.packaging_balance_template_name && base.packaging_balance_template_language) {
    balance = await resolveOrderBalance(admin, ctx.accountId, orderId)
    if (!balance.available) return fail(409, balance.reason === 'lookup_failed' ? 'internal_error' : 'pending_balance_unavailable', { balance_reason: balance.reason })
    if (balance.pending > 0) cfg = { packaging_template_name: base.packaging_balance_template_name, packaging_template_language: base.packaging_balance_template_language, packaging_template_params: base.packaging_balance_template_params }
  }

  const resolved = await resolveTemplateRow(admin, ctx.accountId, cfg.packaging_template_name, cfg.packaging_template_language)
  if (resolved.malformed) return fail(409, 'template_malformed')
  const template = resolved.row as { body_text: string; header_type?: string; header_content?: string; status?: string } | null
  if (!template) return fail(409, 'template_not_found')
  if (String(template.status ?? '').toUpperCase() !== 'APPROVED') return fail(409, 'template_not_approved')
  const headerType = template.header_type ?? null
  if (headerType === 'video' || (headerType === 'text' && extractVariableIndices(template.header_content ?? '').length > 0)) return fail(409, 'template_header_unsupported')

  const bodyVariables = extractVariableIndices(template.body_text)
  const fields = cfg.packaging_template_params ?? []
  // A template that shows the balance / the payment instructions needs them from the PR-06 row / the account configuration, nothing else.
  if (balance === null && fields.includes('pending_balance')) balance = await resolveOrderBalance(admin, ctx.accountId, orderId)
  const paymentInstructions = fields.includes('payment_instructions') ? await readPaymentInstructions(admin, ctx.accountId) : null
  if (bodyVariables.length !== fields.length) return fail(409, 'template_params_mismatch')

  // ---- 2. the order (PR-02 read model + the DNI, which only ever goes into the template) ----
  const { data: orderRow, error: orderError } = await admin.from('order_confirmations').select(`${CONFIRMED_ORDER_COLUMNS}, dni`).eq('account_id', ctx.accountId).eq('id', orderId).maybeSingle()
  if (orderError) return fail(500, 'internal_error')
  if (!orderRow) return fail(404, 'not_found')
  const { data: itemRows, error: itemsError } = await admin.from('order_confirmation_items').select(CONFIRMED_ITEM_COLUMNS).eq('account_id', ctx.accountId).eq('order_id', orderId).order('line_number', { ascending: true })
  if (itemsError) return fail(500, 'internal_error')
  const order = toOrder(orderRow as unknown as Parameters<typeof toOrder>[0], (itemRows ?? []) as unknown as Parameters<typeof toOrder>[1])
  const built = buildTemplateBodyParams(
    { customer_name: order.customer_name, product_summary: order.product_summary, quantity: order.quantity, total: order.total, destination: order.destination, seller_name: order.seller_name, dni: (orderRow as { dni: string | null }).dni,
      pending_balance: balance && balance.available ? formatSoles(balance.pending) : null, payment_instructions: paymentInstructions },
    fields,
  )
  if (!built.ok) return fail(409, built.error)

  // ---- 3. claim ----
  const { data: claim, error: claimError } = await admin.rpc('begin_template_dispatch', {
    p_account: ctx.accountId,
    p_actor: ctx.userId,
    p_order: orderId,
    p_request_key: requestKey,
    p_template_name: cfg.packaging_template_name,
    p_template_language: cfg.packaging_template_language,
  })
  if (claimError) return mapRpcError(claimError)
  const began = (claim ?? {}) as { ok?: boolean; replay?: boolean; dispatch_id?: string; attempt?: number; evidence_document_id?: string; conversation_id?: string; reason?: string; status?: string }
  if (began.ok !== true) return fail(BEGIN_REASON_STATUS[began.reason ?? ''] ?? 409, began.reason ?? 'rejected', began.dispatch_id ? { dispatch_id: began.dispatch_id } : undefined)
  if (began.replay) return { ok: true, status: 200, body: { dispatch_id: began.dispatch_id as string, status: 'sent', order_status: 'ready_for_dispatch', replay: true } }
  const dispatchId = began.dispatch_id as string
  const conversationId = began.conversation_id as string
  const attempt = began.attempt

  const finish = async (outcome: 'sent' | 'failed' | 'uncertain', extra: { messageRowId?: string; wamid?: string; code?: string; detail?: string } = {}) => {
    const args = {
      p_account: ctx.accountId,
      p_actor: ctx.userId,
      p_dispatch: dispatchId,
      p_outcome: outcome,
      p_message_row_id: extra.messageRowId ?? null,
      p_wamid: extra.wamid ?? null,
      p_error_code: extra.code ?? null,
      p_error_detail: extra.detail ?? null,
    }
    let result = await admin.rpc('finish_template_dispatch', args)
    if (result.error) result = await admin.rpc('finish_template_dispatch', args) // one retry: the send already happened, only the bookkeeping failed
    return result
  }
  const failedBeforeMeta = async (status: number, code: string): Promise<ServiceResult<PackagingSendBody>> => {
    const { error } = await finish('failed', { code })
    if (error) console.error('[logistics] could not record a pre-send failure:', error.code)
    return { ok: false, status, error: code, extra: { dispatch_id: dispatchId, order_status: 'packing', status: 'failed' } }
  }

  // ---- 4. everything that can fail BEFORE Meta (a failure here is a definitive `failed`: nothing was sent) ----
  const { data: evidence } = await admin.from('order_documents').select('storage_path, mime_type').eq('id', began.evidence_document_id as string).eq('account_id', ctx.accountId).maybeSingle()
  const ev = evidence as { storage_path: string; mime_type: string } | null
  if (!ev) return failedBeforeMeta(409, 'evidence_required')

  let headerMediaUrl: string | undefined
  if (headerType === 'image' || headerType === 'document') {
    const compatible = headerType === 'image' ? ev.mime_type.startsWith('image/') : ev.mime_type === 'application/pdf'
    if (!compatible) return failedBeforeMeta(409, 'evidence_type_mismatch')
    const { data: signed, error: signError } = await admin.storage.from(ORDER_DOCS_BUCKET).createSignedUrl(ev.storage_path, HEADER_URL_TTL_SECONDS)
    if (signError || !signed?.signedUrl) return failedBeforeMeta(502, 'storage_failed')
    headerMediaUrl = signed.signedUrl
  }

  try {
    await assertConversationOperationalAccess(ctx.supabase, ctx.accountId, conversationId)
  } catch (error) {
    if (error instanceof ForbiddenError) return failedBeforeMeta(403, 'conversation_forbidden')
    return failedBeforeMeta(500, 'access_check_failed')
  }

  const { data: marked, error: markError } = await admin.rpc('mark_template_dispatch_sending', { p_account: ctx.accountId, p_actor: ctx.userId, p_dispatch: dispatchId })
  if (markError) return mapRpcError(markError)
  if ((marked as { ok?: boolean } | null)?.ok !== true) return fail(409, 'in_progress', { dispatch_id: dispatchId })

  // ---- 5. the send: the EXISTING WhatsApp infrastructure, same conversation, same persistence ----
  let sent: SendMessageResult
  try {
    sent = await sendMessage(ctx.supabase, ctx.accountId, {
      conversationId,
      messageType: 'template',
      templateName: cfg.packaging_template_name,
      templateLanguage: resolved.language,
      templateParams: built.params,
      templateMessageParams: { body: built.params, ...(headerMediaUrl ? { headerMediaUrl } : {}) },
      origin: 'manual_reply',
      actor: { userId: ctx.userId },
      senderId: ctx.userId,
    })
  } catch (error) {
    const verdict = classifySendError(error)
    const { error: finishError } = await finish(verdict.outcome, { code: verdict.code })
    if (finishError) console.error('[logistics] could not record the send outcome:', finishError.code)
    return { ok: false, status: verdict.outcome === 'failed' ? 502 : 409, error: verdict.outcome === 'failed' ? 'send_failed' : 'send_uncertain', extra: { dispatch_id: dispatchId, status: verdict.outcome, error_code: verdict.code, order_status: 'packing' } }
  }

  // ---- 6. confirmed send: record it and complete the packaging (one transaction in the database) ----
  const { data: done, error: doneError } = await finish('sent', { messageRowId: sent.messageId, wamid: sent.whatsappMessageId })
  if (doneError || (done as { ok?: boolean } | null)?.ok !== true) {
    // The message IS in WhatsApp and in the chat; only our bookkeeping failed. The dispatch stays `sending` and turns `uncertain` by itself
    // after a few minutes, so a person confirms it: it is never re-sent.
    console.error('[logistics] sent but could not record it:', doneError?.code)
    return fail(500, 'dispatch_record_failed', { dispatch_id: dispatchId, status: 'sending' })
  }
  return { ok: true, status: 200, body: { dispatch_id: dispatchId, status: 'sent', order_status: 'ready_for_dispatch', attempt } }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// resolve an uncertain dispatch (a person looked at the chat)
// ---------------------------------------------------------------------------------------------------------------------------------------------

export async function resolveDispatch(
  ctx: Pick<LogisticsCaller, 'userId' | 'accountId'>,
  admin: SupabaseClient,
  orderId: string,
  input: { dispatchId: unknown; resolution: unknown },
): Promise<ServiceResult<{ status: string; order_status: string; changed: boolean }>> {
  if (!isUuid(orderId)) return fail(400, 'invalid_order_id')
  if (!isUuid(input.dispatchId)) return fail(400, 'invalid_dispatch_id')
  if (input.resolution !== 'confirmed_sent' && input.resolution !== 'confirmed_not_sent') return fail(400, 'invalid_resolution')

  // The dispatch must belong to THIS order of THIS account (the database checks the account again).
  const { data: row } = await admin.from('order_template_dispatches').select('id').eq('account_id', ctx.accountId).eq('order_id', orderId).eq('id', input.dispatchId).maybeSingle()
  if (!row) return fail(404, 'not_found')

  const { data, error } = await admin.rpc('resolve_template_dispatch', { p_account: ctx.accountId, p_actor: ctx.userId, p_dispatch: input.dispatchId, p_resolution: input.resolution, p_wamid: null })
  if (error) return mapRpcError(error)
  const out = (data ?? {}) as { ok?: boolean; changed?: boolean; status?: string; order_status?: string; reason?: string }
  if (out.ok !== true) return fail(409, out.reason ?? 'rejected')
  return { ok: true, status: 200, body: { status: out.status ?? 'failed', order_status: out.order_status ?? 'packing', changed: out.changed !== false } }
}
