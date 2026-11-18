// PR-04 (voucher / OCR / review / packaging). Shared constants. Nothing here is a business rule that depends on real data: only technical limits.

/** Private Storage bucket (migration 20261129000002). Never the public chat-media / flow-media / voice-notes. */
export const ORDER_DOCS_BUCKET = 'order-docs'

/**
 * Upload ceiling. The request crosses the proxy/middleware body buffer (10 MB by default), so the application cap stays below it; the bucket
 * limit (10 MB) is the second line of defence.
 */
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024

/** What a voucher / evidence file can be. Mirrors the bucket allow-list; the bytes are sniffed, the declared Content-Type is never trusted. */
export const ALLOWED_DOCUMENT_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const
export type AllowedDocumentMime = (typeof ALLOWED_DOCUMENT_MIME)[number]

/** Lifetime of a signed URL handed to the browser (viewing) — short on purpose; a new one is requested when needed. */
export const SIGNED_URL_TTL_SECONDS = 120

export const REQUEST_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const MAX_LIST_LIMIT = 100
export const DEFAULT_LIST_LIMIT = 50

/** The ONLY document columns an endpoint returns in lists. No storage path, no content hash, no OCR payload, no reviewed data. */
export const DOCUMENT_PUBLIC_COLUMNS =
  'id, order_id, kind, status, association, version, row_version, batch_id, original_filename, mime_type, size_bytes, ocr_status, ocr_attempts, ocr_error_code, validated_at, created_at' as const

export type LogisticsStatus = 'pending_voucher' | 'voucher_validated' | 'packing' | 'ready_for_dispatch'
