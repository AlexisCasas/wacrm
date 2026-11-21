import type { SupabaseClient } from '@supabase/supabase-js'

import { ForbiddenError } from '@/lib/auth/account'
import { assertConversationOperationalAccess } from '@/lib/conversations/operational-access'
import { CONFIRMED_ITEM_COLUMNS, CONFIRMED_ORDER_COLUMNS, toOrder } from '@/lib/orders/confirmed-orders'
import { ORDER_DOCS_BUCKET } from '@/lib/orders/logistics/constants'
import { fail, mapRpcError, type ServiceResult } from '@/lib/orders/logistics/documents'
import { isUuid } from '@/lib/orders/logistics/files'
import { classifySendError, type SendMessageFn } from '@/lib/orders/logistics/packaging'
import { buildTemplateBodyParams } from '@/lib/orders/logistics/template-params'
import { extractVariableIndices } from '@/lib/whatsapp/template-validators'
import { resolveTemplateRow } from '@/lib/whatsapp/template-body'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import type { LogisticsCaller } from '@/lib/orders/logistics/access'

// P0 parity · the VOUCHER NOTICE (template `voucher_envio_shalom`: UTILITY, header DOCUMENT). The customer receives the Shalom voucher (the PDF that PR-04 validated) with the guide
// (order number + code), the name and the destination: the equivalent of InkaClick's `voucher_shalom_pdf`, which an operator sends by hand. So it is MANUAL: a person (Logistica /
// Supervisor) presses the button; no tick, no cron, no trigger ever sends it. The send is the EXISTING WhatsApp infrastructure (sendMessageToConversation: the order's own conversation,
// the same number, the same persisted messages: it shows in the same Inbox history).
//
// SAFETY (the same pattern as PR-04's dispatches, in its OWN ledger order_shipment_voucher_messages):
//   begin (claim: one row per order + guide) -> everything that can fail BEFORE Meta -> mark `sending` -> Meta call -> finish
//   * double click / two operators / HTTP retry: one notice per guide; the second click is refused (already sent / in progress / failed -> retry / uncertain -> resolve);
//   * failure BEFORE Meta (no template, not approved, wrong document type, no storage): `failed`, nothing was sent; only a PERSON retries it;
//   * failure AFTER Meta may have accepted (lost answer, message not saved): `uncertain`: NEVER re-sent automatically, a person resolves it;
//   * a corrected guide makes the notice obsolete (`skipped`, never sent); the corrected guide is a new notice.
// Template name / language / variables come from order_shipment_settings (account configuration); nothing is hardcoded. No DNI, no balance and no bank data are involved.

const HEADER_URL_TTL_SECONDS = 600
const DEFAULT_PARAMS = ['customer_name', 'shalom_number', 'shalom_code', 'destination']

export interface VoucherMessageDeps {
  sendMessage?: SendMessageFn
}

export interface VoucherSendBody {
  message_id: string
  status: 'sent' | 'failed' | 'uncertain'
  attempt: number
  error_code?: string
}

interface Claim {
  message_id: string
  claim_token: string
  attempt: number
  conversation_id: string
  voucher_document_id: string
  template_name: string
  template_language: string
  template_params: unknown[] | null
  tracking_number: string
  tracking_code: string
}

const BEGIN_REASON_STATUS: Record<string, number> = {
  no_shipment: 409,
  customer_message_disabled: 409,
  template_not_configured: 409,
  tracking_stopped: 409,
  order_without_conversation: 409,
  voucher_required: 409,
  already_sent: 409,
  skipped: 409,
  failed_use_retry: 409,
  needs_resolution: 409,
  in_progress: 409,
  not_failed: 409,
  guide_changed: 409,
}

/** Everything after the claim: checks that can still fail BEFORE Meta, the send and the bookkeeping. Never throws. */
async function executeSend(ctx: Pick<LogisticsCaller, 'supabase' | 'userId' | 'accountId'>, admin: SupabaseClient, orderId: string, claim: Claim, deps: VoucherMessageDeps): Promise<ServiceResult<VoucherSendBody>> {
  const sendMessage = deps.sendMessage ?? sendMessageToConversation
  const finish = async (outcome: 'sent' | 'failed' | 'uncertain', extra: { messageRowId?: string; wamid?: string; code?: string; detail?: string } = {}) => {
    const args = {
      p_account: ctx.accountId, p_message: claim.message_id, p_token: claim.claim_token, p_outcome: outcome,
      p_message_row: extra.messageRowId || null, p_wamid: extra.wamid ?? null, p_error_code: extra.code ?? null, p_error_detail: extra.detail ?? null,
    }
    let result = await admin.rpc('finish_shipment_voucher_message', args)
    if (result.error) result = await admin.rpc('finish_shipment_voucher_message', args) // one retry: only the bookkeeping failed
    return result
  }
  const failedBeforeMeta = async (status: number, code: string): Promise<ServiceResult<VoucherSendBody>> => {
    const { error } = await finish('failed', { code })
    if (error) console.error('[shalom-voucher] could not record a pre-send failure:', error.code)
    return { ok: false, status, error: code, extra: { message_id: claim.message_id, status: 'failed' } }
  }

  // ---- the template (an account configuration, resolved against its existing message_templates) ----
  const resolved = await resolveTemplateRow(admin, ctx.accountId, claim.template_name, claim.template_language)
  if (resolved.malformed) return failedBeforeMeta(409, 'template_malformed')
  const template = resolved.row as { body_text: string; header_type?: string | null; status?: string } | null
  if (!template) return failedBeforeMeta(409, 'template_not_found')
  if (String(template.status ?? '').toUpperCase() !== 'APPROVED') return failedBeforeMeta(409, 'template_not_approved')
  if (String(template.header_type ?? '').toLowerCase() !== 'document') return failedBeforeMeta(409, 'template_header_mismatch') // this notice carries the voucher document
  const fields = Array.isArray(claim.template_params) ? claim.template_params : DEFAULT_PARAMS
  if (extractVariableIndices(template.body_text).length !== fields.length) return failedBeforeMeta(409, 'template_params_mismatch')

  // ---- the order (name / product / destination) and the guide the database claimed it for ----
  const { data: orderRow } = await admin.from('order_confirmations').select(`${CONFIRMED_ORDER_COLUMNS}, dni`).eq('account_id', ctx.accountId).eq('id', orderId).maybeSingle()
  if (!orderRow) return failedBeforeMeta(404, 'order_not_found')
  const { data: itemRows } = await admin.from('order_confirmation_items').select(CONFIRMED_ITEM_COLUMNS).eq('account_id', ctx.accountId).eq('order_id', orderId).order('line_number', { ascending: true })
  const order = toOrder(orderRow as unknown as Parameters<typeof toOrder>[0], (itemRows ?? []) as unknown as Parameters<typeof toOrder>[1])
  const built = buildTemplateBodyParams(
    { customer_name: order.customer_name, product_summary: order.product_summary, quantity: order.quantity, total: order.total, destination: order.destination, seller_name: order.seller_name, dni: null,
      shalom_number: claim.tracking_number, shalom_code: claim.tracking_code },
    fields,
  )
  if (!built.ok) return failedBeforeMeta(409, built.error)

  // ---- the voucher document: a PDF in the private bucket, handed to Meta through a short-lived signed link ----
  const { data: doc } = await admin.from('order_documents').select('storage_path, mime_type').eq('id', claim.voucher_document_id).eq('account_id', ctx.accountId).maybeSingle()
  const voucher = doc as { storage_path: string; mime_type: string } | null
  if (!voucher) return failedBeforeMeta(409, 'voucher_required')
  if (voucher.mime_type !== 'application/pdf') return failedBeforeMeta(409, 'voucher_type_mismatch')
  const { data: signed, error: signError } = await admin.storage.from(ORDER_DOCS_BUCKET).createSignedUrl(voucher.storage_path, HEADER_URL_TTL_SECONDS)
  if (signError || !signed?.signedUrl) return failedBeforeMeta(502, 'storage_failed')

  try {
    await assertConversationOperationalAccess(ctx.supabase, ctx.accountId, claim.conversation_id)
  } catch (error) {
    if (error instanceof ForbiddenError) return failedBeforeMeta(403, 'conversation_forbidden')
    return failedBeforeMeta(500, 'access_check_failed')
  }

  // ---- last check, then Meta ----
  const { data: marked, error: markError } = await admin.rpc('mark_shipment_voucher_sending', { p_account: ctx.accountId, p_message: claim.message_id, p_token: claim.claim_token, p_lease_seconds: 600 })
  if (markError) return mapRpcError(markError)
  const mk = (marked ?? {}) as { ok?: boolean; reason?: string; skip_reason?: string }
  if (mk.ok !== true) return fail(409, mk.reason === 'skipped' ? mk.skip_reason ?? 'skipped' : mk.reason ?? 'claim_lost', { message_id: claim.message_id })

  let sent
  try {
    sent = await sendMessage(ctx.supabase, ctx.accountId, {
      conversationId: claim.conversation_id,
      messageType: 'template',
      templateName: claim.template_name,
      templateLanguage: resolved.language,
      templateParams: built.params,
      templateMessageParams: { body: built.params, headerMediaUrl: signed.signedUrl },
      origin: 'manual_reply',
      actor: { userId: ctx.userId },
      senderId: ctx.userId,
    })
  } catch (error) {
    const verdict = classifySendError(error)
    const { error: finishError } = await finish(verdict.outcome, { code: verdict.code })
    if (finishError) console.error('[shalom-voucher] could not record the send outcome:', finishError.code)
    return { ok: false, status: verdict.outcome === 'failed' ? 502 : 409, error: verdict.outcome === 'failed' ? 'send_failed' : 'send_uncertain', extra: { message_id: claim.message_id, status: verdict.outcome, error_code: verdict.code } }
  }

  const { data: done, error: doneError } = await finish('sent', { messageRowId: sent.messageId, wamid: sent.whatsappMessageId })
  if (doneError || (done as { ok?: boolean } | null)?.ok !== true) {
    // The message IS in WhatsApp and in the chat; only our bookkeeping failed. It stays `sending` and turns `uncertain` by itself: never re-sent.
    console.error('[shalom-voucher] sent but could not record it:', doneError?.code)
    return fail(500, 'voucher_record_failed', { message_id: claim.message_id, status: 'sending' })
  }
  return { ok: true, status: 200, body: { message_id: claim.message_id, status: 'sent', attempt: claim.attempt } }
}

const asClaim = (out: Record<string, unknown>): Claim => ({
  message_id: out.message_id as string,
  claim_token: out.claim_token as string,
  attempt: Number(out.attempt ?? 1),
  conversation_id: out.conversation_id as string,
  voucher_document_id: out.voucher_document_id as string,
  template_name: out.template_name as string,
  template_language: out.template_language as string,
  template_params: (out.template_params as unknown[] | null) ?? null,
  tracking_number: out.tracking_number as string,
  tracking_code: out.tracking_code as string,
})

/** A person (Logistica / Supervisor) presses "send the voucher". One notice per guide: any other click answers why it is refused. */
export async function sendShipmentVoucher(ctx: Pick<LogisticsCaller, 'supabase' | 'userId' | 'accountId'>, admin: SupabaseClient, orderId: string, deps: VoucherMessageDeps = {}): Promise<ServiceResult<VoucherSendBody>> {
  if (!isUuid(orderId)) return fail(400, 'invalid_order_id')
  const { data, error } = await admin.rpc('begin_shipment_voucher_message', { p_account: ctx.accountId, p_actor: ctx.userId, p_order: orderId })
  if (error) return mapRpcError(error)
  const out = (data ?? {}) as Record<string, unknown> & { ok?: boolean; reason?: string; message_id?: string }
  if (out.ok !== true) return fail(BEGIN_REASON_STATUS[String(out.reason ?? '')] ?? 409, String(out.reason ?? 'rejected'), out.message_id ? { message_id: out.message_id } : undefined)
  return executeSend(ctx, admin, orderId, asClaim(out), deps)
}

/** Controlled retry of a FAILED notice (never automatic): the configuration is read again, the same ledger row is reused (no duplicate). */
export async function retryShipmentVoucher(ctx: Pick<LogisticsCaller, 'supabase' | 'userId' | 'accountId'>, admin: SupabaseClient, orderId: string, messageId: unknown, deps: VoucherMessageDeps = {}): Promise<ServiceResult<VoucherSendBody>> {
  if (!isUuid(orderId)) return fail(400, 'invalid_order_id')
  if (!isUuid(messageId)) return fail(400, 'invalid_message_id')
  const { data: row } = await admin.from('order_shipment_voucher_messages').select('id').eq('account_id', ctx.accountId).eq('order_id', orderId).eq('id', messageId).maybeSingle()
  if (!row) return fail(404, 'not_found')
  const { data, error } = await admin.rpc('retry_shipment_voucher_message', { p_account: ctx.accountId, p_actor: ctx.userId, p_message: messageId })
  if (error) return mapRpcError(error)
  const out = (data ?? {}) as Record<string, unknown> & { ok?: boolean; reason?: string }
  if (out.ok !== true) return fail(BEGIN_REASON_STATUS[String(out.reason ?? '')] ?? 409, String(out.reason ?? 'rejected'))
  return executeSend(ctx, admin, orderId, asClaim(out), deps)
}

/** A person looked at the conversation: the UNCERTAIN notice was (or was not) delivered. Never an automatic re-send. */
export async function resolveShipmentVoucher(ctx: Pick<LogisticsCaller, 'userId' | 'accountId'>, admin: SupabaseClient, orderId: string, messageId: unknown, resolution: unknown): Promise<ServiceResult<{ status: string }>> {
  if (!isUuid(orderId)) return fail(400, 'invalid_order_id')
  if (!isUuid(messageId)) return fail(400, 'invalid_message_id')
  if (resolution !== 'confirmed_sent' && resolution !== 'confirmed_not_sent') return fail(400, 'invalid_resolution')
  const { data: row } = await admin.from('order_shipment_voucher_messages').select('id').eq('account_id', ctx.accountId).eq('order_id', orderId).eq('id', messageId).maybeSingle()
  if (!row) return fail(404, 'not_found')
  const { data, error } = await admin.rpc('resolve_shipment_voucher_message', { p_account: ctx.accountId, p_actor: ctx.userId, p_message: messageId, p_resolution: resolution })
  if (error) return mapRpcError(error)
  const out = (data ?? {}) as { ok?: boolean; reason?: string; status?: string }
  return out.ok === true ? { ok: true, status: 200, body: { status: out.status ?? 'failed' } } : fail(out.reason === 'invalid_resolution' ? 400 : 409, out.reason ?? 'rejected')
}
