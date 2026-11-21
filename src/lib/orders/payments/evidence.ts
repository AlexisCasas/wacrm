import { randomUUID } from 'node:crypto'

import type { SupabaseClient } from '@supabase/supabase-js'

import { MAX_DOCUMENT_BYTES, ORDER_DOCS_BUCKET, REQUEST_KEY_PATTERN, SIGNED_URL_TTL_SECONDS } from '@/lib/orders/logistics/constants'
import { fail, mapRpcError, type ServiceResult } from '@/lib/orders/logistics/documents'
import { isAllowedExtension } from '@/lib/orders/logistics/evidence'
import { isAllowedMime, isUuid, safeFileName, sha256Hex, sniffMime } from '@/lib/orders/logistics/files'

// PR-06 · evidence of a PAYMENT. It REUSES order_documents and the private bucket `order-docs` (PR-04's helpers for the type sniffing, hashing and file names; nothing
// of PR-04 is modified): kind `payment_proof`, account-scoped, order-scoped (account-<id>/orders/<order>/payment-proofs/<doc>/<file>), viewed only through
// short-lived signed URLs. A PR-04 voucher can be linked to a payment too (no copy). A file by itself never creates a payment.

export interface PaymentProofView {
  id: string
  order_id: string
  original_filename: string
  mime_type: string
  size_bytes: number
  created_at: string
}

const PROOF_COLUMNS = 'id, order_id, original_filename, mime_type, size_bytes, created_at'
const REASON_STATUS: Record<string, number> = { not_tracked: 409, invalid_request: 400 }

const proofPath = (accountId: string, orderId: string, documentId: string, fileName: string) => `account-${accountId}/orders/${orderId}/payment-proofs/${documentId}/${fileName}`

export interface UploadProofInput {
  fileName: string
  bytes: Uint8Array
  requestKey: unknown
}

/**
 * Uploads a payment proof from the operator's device. Validates before anything is stored (non-empty, size, extension, REAL type from the bytes), stores it in the
 * private bucket and registers it through the RPC, which re-validates actor / both flags / area / order / tracking inside the database. Idempotent on request_key;
 * the very same file for the same order is ONE proof (the stored copy of the duplicate is dropped).
 */
export async function uploadPaymentProof(
  ctx: { userId: string; accountId: string },
  admin: SupabaseClient,
  orderId: string,
  input: UploadProofInput,
  newId: () => string = randomUUID,
): Promise<ServiceResult<{ proof: PaymentProofView; created: boolean }>> {
  if (!isUuid(orderId)) return fail(400, 'invalid_order_id')
  if (typeof input.requestKey !== 'string' || !REQUEST_KEY_PATTERN.test(input.requestKey)) return fail(400, 'invalid_request_key')
  if (input.bytes.byteLength === 0) return fail(400, 'empty_file')
  if (input.bytes.byteLength > MAX_DOCUMENT_BYTES) return fail(413, 'file_too_large', { max_bytes: MAX_DOCUMENT_BYTES })
  if (!isAllowedExtension(input.fileName)) return fail(415, 'unsupported_extension')
  const mime = sniffMime(input.bytes)
  if (!isAllowedMime(mime)) return fail(415, 'unsupported_proof_type')
  const hash = sha256Hex(input.bytes)

  const { data: order, error: orderError } = await admin.from('order_confirmations').select('id').eq('account_id', ctx.accountId).eq('id', orderId).maybeSingle()
  if (orderError) return fail(500, 'internal_error')
  if (!order) return fail(404, 'not_found')

  const { data: replay } = await admin.from('order_documents').select(`${PROOF_COLUMNS}, kind, content_hash`).eq('account_id', ctx.accountId).eq('request_key', input.requestKey).maybeSingle()
  if (replay) {
    const r = replay as unknown as PaymentProofView & { kind: string; content_hash: string }
    if (r.kind !== 'payment_proof' || r.order_id !== orderId || r.content_hash !== hash) return fail(409, 'request_key_conflict')
    return { ok: true, status: 200, body: { proof: { id: r.id, order_id: r.order_id, original_filename: r.original_filename, mime_type: r.mime_type, size_bytes: r.size_bytes, created_at: r.created_at }, created: false } }
  }

  const documentId = newId()
  const fileName = safeFileName(input.fileName, mime)
  const path = proofPath(ctx.accountId, orderId, documentId, fileName)
  const { error: uploadError } = await admin.storage.from(ORDER_DOCS_BUCKET).upload(path, input.bytes, { contentType: mime, upsert: false })
  if (uploadError) {
    console.error('[payments] proof upload failed')
    return fail(502, 'storage_failed')
  }
  const drop = async () => {
    try {
      await admin.storage.from(ORDER_DOCS_BUCKET).remove([path])
    } catch {
      // a private orphan with no row pointing at it is harmless
    }
  }
  const { data, error } = await admin.rpc('register_payment_proof', {
    p_account: ctx.accountId, p_actor: ctx.userId, p_order: orderId, p_doc_id: documentId, p_request_key: input.requestKey, p_storage_path: path,
    p_filename: fileName, p_mime: mime, p_size: input.bytes.byteLength, p_hash: hash,
  })
  if (error) {
    await drop()
    return mapRpcError(error)
  }
  const out = (data ?? {}) as { ok?: boolean; created?: boolean; document_id?: string; reason?: string }
  if (out.ok !== true || !out.document_id) {
    await drop()
    return fail(REASON_STATUS[out.reason ?? ''] ?? 409, out.reason ?? 'rejected')
  }
  if (out.created === false) await drop()
  const { data: row } = await admin.from('order_documents').select(PROOF_COLUMNS).eq('account_id', ctx.accountId).eq('id', out.document_id).maybeSingle()
  if (!row) return fail(500, 'internal_error')
  return { ok: true, status: out.created === false ? 200 : 201, body: { proof: row as unknown as PaymentProofView, created: out.created !== false } }
}

/**
 * A short-lived signed URL for a payment proof (or a voucher linked to a payment) of the caller's account. The caller must hold PAYMENT access (both flags + area): the
 * database says so. The document must be of kind payment_proof / voucher; the storage path is never returned; the bucket is private.
 */
export async function paymentDocumentSignedUrl(
  ctx: { supabase: SupabaseClient; accountId: string },
  admin: SupabaseClient,
  documentId: string,
): Promise<ServiceResult<{ url: string; expires_in: number; mime_type: string; filename: string }>> {
  if (!isUuid(documentId)) return fail(400, 'invalid_document_id')
  const { data: allowed, error: accessError } = await ctx.supabase.rpc('order_payments_access', { p_account_id: ctx.accountId })
  if (accessError) return fail(500, 'internal_error')
  if (allowed !== true) return fail(404, 'not_found')
  const { data: doc, error } = await ctx.supabase
    .from('order_documents')
    .select('id, kind, storage_path, mime_type, original_filename')
    .eq('account_id', ctx.accountId)
    .eq('id', documentId)
    .in('kind', ['payment_proof', 'voucher'])
    .maybeSingle()
  if (error) return fail(500, 'internal_error')
  if (!doc) return fail(404, 'not_found')
  const { data: signed, error: signError } = await admin.storage.from(ORDER_DOCS_BUCKET).createSignedUrl(doc.storage_path as string, SIGNED_URL_TTL_SECONDS)
  if (signError || !signed?.signedUrl) return fail(502, 'storage_failed')
  return { ok: true, status: 200, body: { url: signed.signedUrl, expires_in: SIGNED_URL_TTL_SECONDS, mime_type: doc.mime_type as string, filename: doc.original_filename as string } }
}
