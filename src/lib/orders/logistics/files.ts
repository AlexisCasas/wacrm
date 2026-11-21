import { createHash } from 'node:crypto'

import { ALLOWED_DOCUMENT_MIME, UUID_PATTERN, type AllowedDocumentMime } from '@/lib/orders/logistics/constants'

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_PATTERN.test(value)

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b)

/**
 * The real type of a file from its first bytes. A voucher is a PDF or an image; anything else (or a file whose bytes do not match what it claims)
 * returns null. The declared Content-Type / file name are never trusted.
 */
export function sniffMime(bytes: Uint8Array): AllowedDocumentMime | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'
  // PDF header may be preceded by a little junk (the spec allows it inside the first 1024 bytes).
  const head = bytes.subarray(0, 1024)
  for (let i = 0; i + 5 <= head.length; i += 1) if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d], i)) return 'application/pdf'
  return null
}

export const isAllowedMime = (mime: string | null): mime is AllowedDocumentMime => mime !== null && (ALLOWED_DOCUMENT_MIME as readonly string[]).includes(mime)

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const EXTENSION: Record<AllowedDocumentMime, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/** A storage-safe file name: no path, no accents, [A-Za-z0-9._-] only, max 80 chars, extension taken from the SNIFFED type. */
export function safeFileName(name: string, mime: AllowedDocumentMime): string {
  const base = (name.split(/[\\/]/).pop() ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, 70)
  return `${base || 'documento'}.${EXTENSION[mime]}`
}

export type DocumentFolder = 'vouchers' | 'evidence'

/**
 * account-<account_id>/orders/<order_id | unassigned>/(vouchers|evidence)/<document_id>/<file>. A voucher still pending association lives under
 * "unassigned": the object is never moved afterwards (the association is a database fact, the path is just a private address).
 */
export function buildDocumentPath(args: { accountId: string; orderId: string | null; folder: DocumentFolder; documentId: string; fileName: string }): string {
  return `account-${args.accountId}/orders/${args.orderId ?? 'unassigned'}/${args.folder}/${args.documentId}/${args.fileName}`
}
