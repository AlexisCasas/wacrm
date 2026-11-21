import type { SupabaseClient } from '@supabase/supabase-js'

import type { LogisticsCaller } from '@/lib/orders/logistics/access'
import { OCR_STALE_SECONDS, OCR_TIMEOUT_MS, ORDER_DOCS_BUCKET } from '@/lib/orders/logistics/constants'
import { fail, mapRpcError, type ServiceResult } from '@/lib/orders/logistics/documents'
import { isAllowedMime, isUuid, sniffMime } from '@/lib/orders/logistics/files'
import { normalizeOcrOutput, safeProviderName } from '@/lib/orders/logistics/ocr/normalize-result'
import { VoucherOcrError, type OcrErrorCode, type VoucherOcrProvider } from '@/lib/orders/logistics/ocr/types'

// One OCR attempt on one voucher: claim (RPC) -> read the private file -> provider (with a time budget) -> normalize -> store (RPC).
// The OCR output is a SUGGESTION stored as `ocr_result`: it never validates the voucher and never overwrites reviewed data.
// Every attempt is audited by the RPCs (attempt number, result, typed error code, provider) without voucher content.
// The claim (`ocr_status = 'pending'`) makes a double click / two operators / an HTTP retry safe: only one attempt runs at a time, and an attempt
// that was abandoned (process died, provider hung) can be retaken after OCR_STALE_SECONDS.

export interface OcrRunBody {
  attempt: number
  ocr_status: 'done' | 'failed'
  error_code: OcrErrorCode | null
}

export interface RunOcrOptions {
  timeoutMs?: number
  staleSeconds?: number
}

async function withTimeout<T>(start: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new VoucherOcrError('ocr_timeout'))
    }, ms)
  })
  const work = start(controller.signal)
  work.catch(() => undefined) // a late rejection after the timeout must not become an unhandled rejection
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function runDocumentOcr(
  ctx: Pick<LogisticsCaller, 'userId' | 'accountId'>,
  admin: SupabaseClient,
  provider: VoucherOcrProvider,
  documentId: string,
  options: RunOcrOptions = {},
): Promise<ServiceResult<OcrRunBody>> {
  if (!isUuid(documentId)) return fail(400, 'invalid_document_id')

  const { data: doc, error: docError } = await admin
    .from('order_documents')
    .select('id, storage_path, kind, status')
    .eq('account_id', ctx.accountId)
    .eq('id', documentId)
    .maybeSingle()
  if (docError) {
    console.error('[logistics] ocr document lookup failed:', docError.code)
    return fail(500, 'internal_error')
  }
  if (!doc) return fail(404, 'not_found')

  const { data: claim, error: claimError } = await admin.rpc('begin_document_ocr', {
    p_account: ctx.accountId,
    p_actor: ctx.userId,
    p_doc: documentId,
    p_stale_seconds: options.staleSeconds ?? OCR_STALE_SECONDS,
  })
  if (claimError) return mapRpcError(claimError)
  const started = (claim ?? {}) as { ok?: boolean; attempt?: number; reason?: string }
  if (started.ok !== true || typeof started.attempt !== 'number') return fail(409, started.reason ?? 'rejected')
  const attempt = started.attempt

  const recordFailure = async (code: OcrErrorCode, providerName: string): Promise<ServiceResult<OcrRunBody>> => {
    const { error } = await admin.rpc('fail_document_ocr', {
      p_account: ctx.accountId,
      p_actor: ctx.userId,
      p_doc: documentId,
      p_attempt: attempt,
      p_provider: safeProviderName(providerName),
      p_error_code: code,
    })
    if (error) return mapRpcError(error) // the claim stays `pending` and becomes retakeable after the stale window
    return { ok: true, status: 200, body: { attempt, ocr_status: 'failed', error_code: code } }
  }

  let bytes: Uint8Array
  try {
    const { data: blob, error: downloadError } = await admin.storage.from(ORDER_DOCS_BUCKET).download(doc.storage_path as string)
    if (downloadError || !blob) return await recordFailure('ocr_file_unavailable', provider.name)
    bytes = new Uint8Array(await blob.arrayBuffer())
  } catch {
    return recordFailure('ocr_file_unavailable', provider.name)
  }
  const mimeType = sniffMime(bytes)
  if (!isAllowedMime(mimeType)) return recordFailure('ocr_unreadable', provider.name)

  let result
  let providerName = provider.name
  try {
    const output = await withTimeout((signal) => provider.extract({ bytes, mimeType, signal }), options.timeoutMs ?? OCR_TIMEOUT_MS)
    providerName = output.provider || provider.name
    result = normalizeOcrOutput(output)
  } catch (error) {
    return recordFailure(error instanceof VoucherOcrError ? error.code : 'ocr_provider_error', providerName)
  }

  const { data: done, error: completeError } = await admin.rpc('complete_document_ocr', {
    p_account: ctx.accountId,
    p_actor: ctx.userId,
    p_doc: documentId,
    p_attempt: attempt,
    p_provider: safeProviderName(providerName),
    p_result: result,
  })
  if (completeError) {
    if (completeError.code === '22023') return recordFailure('ocr_invalid_response', providerName)
    return mapRpcError(completeError)
  }
  const out = (done ?? {}) as { ok?: boolean; reason?: string }
  if (out.ok !== true) return fail(409, out.reason ?? 'rejected')
  return { ok: true, status: 200, body: { attempt, ocr_status: 'done', error_code: null } }
}
