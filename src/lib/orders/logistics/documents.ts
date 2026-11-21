import { randomUUID } from 'node:crypto'

import type { SupabaseClient } from '@supabase/supabase-js'

import type { LogisticsCaller } from '@/lib/orders/logistics/access'
import {
  DEFAULT_LIST_LIMIT,
  DOCUMENT_PUBLIC_COLUMNS,
  MAX_DOCUMENT_BYTES,
  MAX_LIST_LIMIT,
  ORDER_DOCS_BUCKET,
  REQUEST_KEY_PATTERN,
  SIGNED_URL_TTL_SECONDS,
} from '@/lib/orders/logistics/constants'
import { buildDocumentPath, isAllowedMime, isUuid, safeFileName, sha256Hex, sniffMime } from '@/lib/orders/logistics/files'

// Server-side document service of PR-04 (vouchers). Nothing here trusts the browser: the account / user come from the session context, the
// order's ownership is verified by the database (composite FK + guard + RPC), the file type is sniffed from the bytes.
//
// Upload order: private bucket FIRST, then the RPC that registers the row. A refused / duplicate registration only leaves a private orphan object
// that this function removes best-effort; a row can never point at a missing file. Replays of the same request_key never touch Storage.

export type ServiceResult<T> = { ok: true; status: number; body: T } | { ok: false; status: number; error: string; extra?: Record<string, unknown> }

export const fail = (status: number, error: string, extra?: Record<string, unknown>): ServiceResult<never> => ({ ok: false, status, error, extra })

export interface UploadVoucherInput {
  fileName: string
  bytes: Uint8Array
  /** Direct association (known order) when present; bulk upload (pending association) when null. */
  orderId: string | null
  batchId: string | null
  requestKey: string
  allowDuplicate: boolean
}

export interface DocumentView {
  id: string
  order_id: string | null
  kind: string
  status: string
  association: string
  version: number | null
  row_version: number
  batch_id: string | null
  original_filename: string
  mime_type: string
  size_bytes: number
  ocr_status: string
  ocr_attempts: number
  ocr_error_code: string | null
  validated_at: string | null
  created_at: string
}

/** Maps a database refusal of a PR-04 RPC to an HTTP result. Cross-account and non-existent ids are deliberately indistinguishable (404). */
export function mapRpcError(error: { code?: string; message?: string }): ServiceResult<never> {
  const message = error.message ?? ''
  if (error.code === '42501') return message.includes('feature_disabled') ? fail(403, 'feature_disabled') : fail(404, 'not_found')
  if (error.code === '22023') {
    if (message.includes('request_key_conflict')) return fail(409, 'request_key_conflict')
    if (message.includes('packaging_completed_elsewhere')) return fail(409, 'packaging_completed_elsewhere')
    return fail(400, 'invalid_request')
  }
  console.error('[logistics] rpc failed:', error.code)
  return fail(500, 'internal_error')
}

async function removeObject(admin: SupabaseClient, path: string): Promise<void> {
  try {
    await admin.storage.from(ORDER_DOCS_BUCKET).remove([path])
  } catch {
    // best effort: an orphan in a private bucket is harmless and has no database row pointing at it
  }
}

export async function readDocumentView(admin: SupabaseClient, accountId: string, documentId: string): Promise<DocumentView | null> {
  const { data } = await admin.from('order_documents').select(DOCUMENT_PUBLIC_COLUMNS).eq('account_id', accountId).eq('id', documentId).maybeSingle()
  return (data as DocumentView | null) ?? null
}

export async function uploadVoucher(
  ctx: Pick<LogisticsCaller, 'userId' | 'accountId'>,
  admin: SupabaseClient,
  input: UploadVoucherInput,
  newId: () => string = randomUUID,
): Promise<ServiceResult<{ document: DocumentView; created: boolean }>> {
  if (!REQUEST_KEY_PATTERN.test(input.requestKey)) return fail(400, 'invalid_request_key')
  if (input.orderId !== null && !isUuid(input.orderId)) return fail(400, 'invalid_order_id')
  if (input.batchId !== null && !isUuid(input.batchId)) return fail(400, 'invalid_batch_id')
  if (input.bytes.byteLength === 0) return fail(400, 'empty_file')
  if (input.bytes.byteLength > MAX_DOCUMENT_BYTES) return fail(413, 'file_too_large', { max_bytes: MAX_DOCUMENT_BYTES })

  const mime = sniffMime(input.bytes)
  if (!isAllowedMime(mime)) return fail(415, 'unsupported_file_type')
  const hash = sha256Hex(input.bytes)

  // Replay of the same operation (double click / HTTP retry): answer with the existing document, no upload, no second row.
  const { data: existing } = await admin
    .from('order_documents')
    .select(`${DOCUMENT_PUBLIC_COLUMNS}, content_hash`)
    .eq('account_id', ctx.accountId)
    .eq('request_key', input.requestKey)
    .maybeSingle()
  if (existing) {
    const { content_hash: existingHash, ...view } = existing as unknown as DocumentView & { content_hash: string }
    if (existingHash !== hash) return fail(409, 'request_key_conflict')
    return { ok: true, status: 200, body: { document: view, created: false } }
  }

  const documentId = newId()
  const fileName = safeFileName(input.fileName, mime)
  const path = buildDocumentPath({ accountId: ctx.accountId, orderId: input.orderId, folder: 'vouchers', documentId, fileName })

  const { error: uploadError } = await admin.storage.from(ORDER_DOCS_BUCKET).upload(path, input.bytes, { contentType: mime, upsert: false })
  if (uploadError) {
    console.error('[logistics] storage upload failed')
    return fail(502, 'storage_failed')
  }

  const { data: result, error: rpcError } = await admin.rpc('register_order_document', {
    p_account: ctx.accountId,
    p_actor: ctx.userId,
    p_doc_id: documentId,
    p_order: input.orderId,
    p_batch: input.batchId,
    p_request_key: input.requestKey,
    p_storage_path: path,
    p_filename: fileName,
    p_mime: mime,
    p_size: input.bytes.byteLength,
    p_hash: hash,
    p_allow_duplicate: input.allowDuplicate,
  })
  if (rpcError) {
    await removeObject(admin, path)
    return mapRpcError(rpcError)
  }

  const out = (result ?? {}) as {
    ok?: boolean
    created?: boolean
    document_id?: string
    reason?: string
    duplicate_of?: string
    duplicate_order_id?: string | null
  }
  if (out.ok !== true || !out.document_id) {
    await removeObject(admin, path)
    if (out.reason === 'duplicate') return fail(409, 'duplicate', { duplicate_of: out.duplicate_of, duplicate_order_id: out.duplicate_order_id ?? null })
    if (out.reason === 'order_locked') return fail(409, 'order_locked')
    return fail(409, out.reason ?? 'rejected')
  }
  // Lost a race with the same request_key: the winner's object is the one that counts.
  if (out.created === false) await removeObject(admin, path)

  const document = await readDocumentView(admin, ctx.accountId, out.document_id)
  if (!document) return fail(500, 'internal_error')
  return { ok: true, status: out.created === false ? 200 : 201, body: { document, created: out.created !== false } }
}

export interface ListDocumentsFilter {
  orderId?: string | null
  batchId?: string | null
  kind?: string | null
  status?: string | null
  association?: string | null
  limit?: number
}

const KINDS = ['voucher', 'evidence']
const STATUSES = ['pending_review', 'validated', 'rejected', 'superseded', 'active']
const ASSOCIATIONS = ['direct', 'auto', 'manual', 'pending']

/** Lists with the CALLER's client: row-level security (flag + area + role) applies on top of the explicit account filter. */
export async function listDocuments(ctx: LogisticsCaller, filter: ListDocumentsFilter): Promise<ServiceResult<{ documents: DocumentView[] }>> {
  if (filter.orderId && !isUuid(filter.orderId)) return fail(400, 'invalid_order_id')
  if (filter.batchId && !isUuid(filter.batchId)) return fail(400, 'invalid_batch_id')
  if (filter.kind && !KINDS.includes(filter.kind)) return fail(400, 'invalid_kind')
  if (filter.status && !STATUSES.includes(filter.status)) return fail(400, 'invalid_status')
  if (filter.association && !ASSOCIATIONS.includes(filter.association)) return fail(400, 'invalid_association')
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? DEFAULT_LIST_LIMIT) || DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT)

  let query = ctx.supabase.from('order_documents').select(DOCUMENT_PUBLIC_COLUMNS).eq('account_id', ctx.accountId)
  if (filter.orderId) query = query.eq('order_id', filter.orderId)
  if (filter.batchId) query = query.eq('batch_id', filter.batchId)
  if (filter.kind) query = query.eq('kind', filter.kind)
  if (filter.status) query = query.eq('status', filter.status)
  if (filter.association) query = query.eq('association', filter.association)
  const { data, error } = await query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit)
  if (error) {
    console.error('[logistics] list documents failed:', error.code)
    return fail(500, 'internal_error')
  }
  return { ok: true, status: 200, body: { documents: (data ?? []) as unknown as DocumentView[] } }
}

/**
 * A short-lived signed URL for one document. The row is read with the CALLER's client (RLS decides whether the caller may see it at all), then the
 * URL is minted with the service role. The storage path itself is never returned.
 */
export async function documentSignedUrl(
  ctx: LogisticsCaller,
  admin: SupabaseClient,
  documentId: string,
): Promise<ServiceResult<{ url: string; expires_in: number; mime_type: string; filename: string }>> {
  if (!isUuid(documentId)) return fail(400, 'invalid_document_id')
  const { data: doc, error } = await ctx.supabase
    .from('order_documents')
    .select('id, storage_path, mime_type, original_filename')
    .eq('account_id', ctx.accountId)
    .eq('id', documentId)
    .maybeSingle()
  if (error) {
    console.error('[logistics] document lookup failed:', error.code)
    return fail(500, 'internal_error')
  }
  if (!doc) return fail(404, 'not_found')

  const { data: signed, error: signError } = await admin.storage.from(ORDER_DOCS_BUCKET).createSignedUrl(doc.storage_path as string, SIGNED_URL_TTL_SECONDS)
  if (signError || !signed?.signedUrl) {
    console.error('[logistics] signed url failed')
    return fail(502, 'storage_failed')
  }
  return {
    ok: true,
    status: 200,
    body: { url: signed.signedUrl, expires_in: SIGNED_URL_TTL_SECONDS, mime_type: doc.mime_type as string, filename: doc.original_filename as string },
  }
}
