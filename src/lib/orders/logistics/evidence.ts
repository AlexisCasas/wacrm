import { randomUUID } from 'node:crypto'

import type { SupabaseClient } from '@supabase/supabase-js'

import { denyUnlessLogisticsInDatabase, type LogisticsCaller } from '@/lib/orders/logistics/access'
import { MAX_DOCUMENT_BYTES, ORDER_DOCS_BUCKET, REQUEST_KEY_PATTERN } from '@/lib/orders/logistics/constants'
import { fail, mapRpcError, readDocumentView, type DocumentView, type ServiceResult } from '@/lib/orders/logistics/documents'
import { buildDocumentPath, isAllowedMime, isUuid, safeFileName, sha256Hex, sniffMime } from '@/lib/orders/logistics/files'

// Packaging EVIDENCE comes from the SAME conversation as the order: Logística picks a media message that is already in the chat (no download from
// another tool, no manual re-upload). The backend validates account / order / conversation / message, then keeps a PRIVATE SNAPSHOT of the file in
// `order-docs` so the evidence outlives the chat copy (a contact cleanup deletes chat-media objects; Meta's proxy links expire after ~30 days).
// The original message and its public chat-media object are never moved, modified or deleted; the Inbox is untouched.
//
// The PRIMARY way is uploadEvidence (bottom of this file): Logística / Supervisor upload the packaging photo / PDF from their own device (the chat may
// have no usable file at all). The chat stays as an optional alternative. Both end in the same place: an ACTIVE 'evidence' row of order_documents
// (private order-docs object, scoped to account + order) that order_logistics.evidence_document_id points at; the template send does not care which
// one it was. The origin is kept in order_documents.source ('upload' | 'chat_message') and in the audit trail ('evidence_uploaded' | 'evidence_selected').
//
// Supported source: media that WACRM stored in its own `chat-media` bucket (outbound uploads and the inbound mirror, which is ON by default).
// A message whose media is only the expiring Meta proxy link is reported as `media_not_stored` (it cannot be snapshotted safely from here).

const CHAT_MEDIA_BUCKET = 'chat-media'
const EVIDENCE_CONTENT_TYPES = ['image', 'document']

/**
 * The object path inside chat-media of a message's media_url, ONLY when that URL is a public chat-media URL of this Supabase project AND the object
 * belongs to the caller's account folder. Anything else (other host, proxy link, another account's folder, traversal) returns null.
 */
export function parseChatMediaPath(mediaUrl: string | null | undefined, accountId: string, supabaseUrl: string | undefined = process.env.NEXT_PUBLIC_SUPABASE_URL): string | null {
  if (!mediaUrl || !supabaseUrl) return null
  const prefix = `${supabaseUrl.replace(/\/+$/, '')}/storage/v1/object/public/${CHAT_MEDIA_BUCKET}/`
  if (!mediaUrl.startsWith(prefix)) return null
  let path: string
  try {
    path = decodeURIComponent(mediaUrl.slice(prefix.length).split(/[?#]/)[0])
  } catch {
    return null
  }
  if (path.includes('..') || path.includes('//') || path.startsWith('/') || path.includes('\\')) return null
  return path.startsWith(`account-${accountId}/`) ? path : null
}

export interface ChatMediaItem {
  message_id: string
  content_type: string
  media_type: string | null
  sender_type: string
  created_at: string
  /** True when the file can be snapshotted as evidence. */
  available: boolean
  /** The same public chat-media URL the Inbox already shows (only when available). */
  preview_url: string | null
}

const MESSAGE_COLUMNS = 'id, content_type, media_url, media_type, sender_type, created_at'

/** The media messages of the ORDER'S conversation, read with the caller's client (so the existing conversation access rules apply). */
export async function listChatMedia(ctx: LogisticsCaller, orderId: string, supabaseUrl?: string): Promise<ServiceResult<{ media: ChatMediaItem[] }>> {
  if (!isUuid(orderId)) return fail(400, 'invalid_order_id')
  const denied = await denyUnlessLogisticsInDatabase(ctx)
  if (denied) return fail(denied.status, denied.error)

  const { data: order, error: orderError } = await ctx.supabase.from('order_confirmations').select('id, conversation_id').eq('account_id', ctx.accountId).eq('id', orderId).maybeSingle()
  if (orderError) return fail(500, 'internal_error')
  if (!order) return fail(404, 'not_found')
  const conversationId = (order as { conversation_id: string | null }).conversation_id
  if (!conversationId) return fail(409, 'order_without_conversation')

  const { data, error } = await ctx.supabase
    .from('messages')
    .select(MESSAGE_COLUMNS)
    .eq('conversation_id', conversationId)
    .not('media_url', 'is', null)
    .in('content_type', EVIDENCE_CONTENT_TYPES)
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) {
    console.error('[logistics] chat media list failed:', error.code)
    return fail(500, 'internal_error')
  }
  const media = ((data ?? []) as Array<{ id: string; content_type: string; media_url: string; media_type: string | null; sender_type: string; created_at: string }>).map((m) => {
    const available = parseChatMediaPath(m.media_url, ctx.accountId, supabaseUrl) !== null
    return { message_id: m.id, content_type: m.content_type, media_type: m.media_type, sender_type: m.sender_type, created_at: m.created_at, available, preview_url: available ? m.media_url : null }
  })
  return { ok: true, status: 200, body: { media } }
}

export interface SelectEvidenceInput {
  messageId: unknown
  requestKey: unknown
}

const REASON_STATUS: Record<string, number> = {
  not_packing: 409,
  already_ready: 409,
  dispatch_open: 409,
  order_without_conversation: 409,
  message_not_in_conversation: 404,
}

export async function selectEvidenceFromChat(
  ctx: Pick<LogisticsCaller, 'supabase' | 'userId' | 'accountId'>,
  admin: SupabaseClient,
  orderId: string,
  input: SelectEvidenceInput,
  deps: { supabaseUrl?: string; newId?: () => string } = {},
): Promise<ServiceResult<{ evidence: DocumentView; created: boolean }>> {
  if (!isUuid(orderId)) return fail(400, 'invalid_order_id')
  if (!isUuid(input.messageId)) return fail(400, 'invalid_message_id')
  if (typeof input.requestKey !== 'string' || !REQUEST_KEY_PATTERN.test(input.requestKey)) return fail(400, 'invalid_request_key')
  const { messageId, requestKey } = input as { messageId: string; requestKey: string }

  // Order of THIS account (service client, explicit account filter) and its conversation.
  const { data: order, error: orderError } = await admin.from('order_confirmations').select('id, conversation_id').eq('account_id', ctx.accountId).eq('id', orderId).maybeSingle()
  if (orderError) return fail(500, 'internal_error')
  if (!order) return fail(404, 'not_found')
  const conversationId = (order as { conversation_id: string | null }).conversation_id
  if (!conversationId) return fail(409, 'order_without_conversation')

  // Replay of the same operation: answer without touching Storage.
  const { data: replay } = await admin.from('order_documents').select('id, order_id, kind, source_message_id').eq('account_id', ctx.accountId).eq('request_key', requestKey).maybeSingle()
  if (replay) {
    const r = replay as { id: string; order_id: string | null; kind: string; source_message_id: string | null }
    if (r.kind !== 'evidence' || r.order_id !== orderId || r.source_message_id !== messageId) return fail(409, 'request_key_conflict')
    const view = await readDocumentView(admin, ctx.accountId, r.id)
    return view ? { ok: true, status: 200, body: { evidence: view, created: false } } : fail(500, 'internal_error')
  }

  // The message is read with the CALLER's client: the conversation access rules (flag + area + routing stage + RLS) apply to it.
  const { data: message, error: messageError } = await ctx.supabase
    .from('messages')
    .select(MESSAGE_COLUMNS)
    .eq('id', messageId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (messageError) return fail(500, 'internal_error')
  if (!message) return fail(404, 'message_not_found')
  const m = message as { content_type: string; media_url: string | null }
  if (!EVIDENCE_CONTENT_TYPES.includes(m.content_type) || !m.media_url) return fail(422, 'message_has_no_media')

  const sourcePath = parseChatMediaPath(m.media_url, ctx.accountId, deps.supabaseUrl)
  if (!sourcePath) return fail(422, 'media_not_stored')

  const { data: blob, error: downloadError } = await admin.storage.from(CHAT_MEDIA_BUCKET).download(sourcePath)
  if (downloadError || !blob) return fail(422, 'media_not_stored')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (bytes.byteLength === 0) return fail(422, 'media_not_stored')
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) return fail(413, 'file_too_large', { max_bytes: MAX_DOCUMENT_BYTES })
  const mime = sniffMime(bytes)
  if (!isAllowedMime(mime)) return fail(415, 'unsupported_evidence_type')

  const documentId = (deps.newId ?? randomUUID)()
  const fileName = safeFileName(sourcePath.split('/').pop() ?? 'evidencia', mime)
  const snapshotPath = buildDocumentPath({ accountId: ctx.accountId, orderId, folder: 'evidence', documentId, fileName })
  const hash = sha256Hex(bytes)

  const { error: uploadError } = await admin.storage.from(ORDER_DOCS_BUCKET).upload(snapshotPath, bytes, { contentType: mime, upsert: false })
  if (uploadError) {
    console.error('[logistics] evidence snapshot upload failed')
    return fail(502, 'storage_failed')
  }
  const dropSnapshot = async () => {
    try {
      await admin.storage.from(ORDER_DOCS_BUCKET).remove([snapshotPath])
    } catch {
      // a private orphan with no row pointing at it is harmless
    }
  }

  const { data, error } = await admin.rpc('select_order_evidence', {
    p_account: ctx.accountId,
    p_actor: ctx.userId,
    p_order: orderId,
    p_message: messageId,
    p_doc_id: documentId,
    p_request_key: requestKey,
    p_storage_path: snapshotPath,
    p_filename: fileName,
    p_mime: mime,
    p_size: bytes.byteLength,
    p_hash: hash,
  })
  if (error) {
    await dropSnapshot()
    return mapRpcError(error)
  }
  const out = (data ?? {}) as { ok?: boolean; created?: boolean; document_id?: string; reason?: string }
  if (out.ok !== true || !out.document_id) {
    await dropSnapshot()
    return fail(REASON_STATUS[out.reason ?? ''] ?? 409, out.reason ?? 'rejected')
  }
  if (out.created === false) await dropSnapshot() // same message / same key: the existing snapshot is the one that counts

  const view = await readDocumentView(admin, ctx.accountId, out.document_id)
  if (!view) return fail(500, 'internal_error')
  return { ok: true, status: out.created === false ? 200 : 201, body: { evidence: view, created: out.created !== false } }
}

/** Extensions a person may declare for an evidence file. The REAL type is always sniffed from the bytes; this only refuses names like "x.exe". */
const ALLOWED_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png', 'webp']

/** True when the file name has no extension, or one of ALLOWED_EXTENSIONS (case-insensitive). */
export function isAllowedExtension(fileName: string): boolean {
  const base = fileName.split(/[\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return true
  return ALLOWED_EXTENSIONS.includes(base.slice(dot + 1).toLowerCase())
}

export interface UploadEvidenceInput {
  fileName: string
  bytes: Uint8Array
  requestKey: unknown
}

/**
 * Packaging evidence UPLOADED from the operator's device. Validates before anything is stored: non-empty, size, extension, the REAL type from the
 * bytes (pdf / jpeg / png / webp, the same allow-list as vouchers) and the order (service client with an explicit account filter). The object goes to
 * the private order-docs bucket; the RPC re-validates actor / flag / area / order / state inside the database and registers the evidence (audited as
 * 'evidence_uploaded'). Idempotent on request_key; uploading the very same file again changes nothing and leaves no duplicate object.
 */
export async function uploadEvidence(
  ctx: Pick<LogisticsCaller, 'userId' | 'accountId'>,
  admin: SupabaseClient,
  orderId: string,
  input: UploadEvidenceInput,
  newId: () => string = randomUUID,
): Promise<ServiceResult<{ evidence: DocumentView; created: boolean }>> {
  if (!isUuid(orderId)) return fail(400, 'invalid_order_id')
  if (typeof input.requestKey !== 'string' || !REQUEST_KEY_PATTERN.test(input.requestKey)) return fail(400, 'invalid_request_key')
  const requestKey = input.requestKey
  if (input.bytes.byteLength === 0) return fail(400, 'empty_file')
  if (input.bytes.byteLength > MAX_DOCUMENT_BYTES) return fail(413, 'file_too_large', { max_bytes: MAX_DOCUMENT_BYTES })
  if (!isAllowedExtension(input.fileName)) return fail(415, 'unsupported_extension')
  const mime = sniffMime(input.bytes)
  if (!isAllowedMime(mime)) return fail(415, 'unsupported_evidence_type')
  const hash = sha256Hex(input.bytes)

  const { data: order, error: orderError } = await admin.from('order_confirmations').select('id').eq('account_id', ctx.accountId).eq('id', orderId).maybeSingle()
  if (orderError) return fail(500, 'internal_error')
  if (!order) return fail(404, 'not_found')

  // Replay of the same operation: answer without touching Storage.
  const { data: replay } = await admin.from('order_documents').select('id, order_id, kind, content_hash').eq('account_id', ctx.accountId).eq('request_key', requestKey).maybeSingle()
  if (replay) {
    const r = replay as { id: string; order_id: string | null; kind: string; content_hash: string }
    if (r.kind !== 'evidence' || r.order_id !== orderId || r.content_hash !== hash) return fail(409, 'request_key_conflict')
    const view = await readDocumentView(admin, ctx.accountId, r.id)
    return view ? { ok: true, status: 200, body: { evidence: view, created: false } } : fail(500, 'internal_error')
  }

  const documentId = newId()
  const fileName = safeFileName(input.fileName, mime)
  const path = buildDocumentPath({ accountId: ctx.accountId, orderId, folder: 'evidence', documentId, fileName })
  const { error: uploadError } = await admin.storage.from(ORDER_DOCS_BUCKET).upload(path, input.bytes, { contentType: mime, upsert: false })
  if (uploadError) {
    console.error('[logistics] evidence upload failed')
    return fail(502, 'storage_failed')
  }
  const drop = async () => {
    try {
      await admin.storage.from(ORDER_DOCS_BUCKET).remove([path])
    } catch {
      // a private orphan with no row pointing at it is harmless
    }
  }

  const { data, error } = await admin.rpc('register_order_evidence_upload', {
    p_account: ctx.accountId,
    p_actor: ctx.userId,
    p_order: orderId,
    p_doc_id: documentId,
    p_request_key: requestKey,
    p_storage_path: path,
    p_filename: fileName,
    p_mime: mime,
    p_size: input.bytes.byteLength,
    p_hash: hash,
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
  if (out.created === false) await drop() // the existing evidence / the winner of the same key is the one that counts

  const view = await readDocumentView(admin, ctx.accountId, out.document_id)
  if (!view) return fail(500, 'internal_error')
  return { ok: true, status: out.created === false ? 200 : 201, body: { evidence: view, created: out.created !== false } }
}
