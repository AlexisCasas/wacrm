import type { AllowedDocumentMime } from '@/lib/orders/logistics/constants'

// The OCR boundary of PR-04. The real provider is NOT chosen yet (no SDK, nothing hardcoded): the domain only knows this interface, so the provider
// can be swapped in one place once real voucher samples exist. An OCR result is a SUGGESTION: it never validates a voucher and never decides which
// order a voucher belongs to (the order is known from the screen, or chosen by a person / the conservative matching rule).
//
// The field names below are CONVENTIONS the review screen and the comparison understand (dni, phone, customer_name, amount); the full field
// contract of a real voucher is intentionally NOT frozen until real samples are reviewed. Unknown fields are kept and shown as informational.

export interface OcrFieldResult {
  /** The text the provider read (numbers as written), or null when it could not read the field. */
  value: string | null
  /** 0..1, as reported by the provider. */
  confidence: number
}

export interface VoucherOcrInput {
  bytes: Uint8Array
  mimeType: AllowedDocumentMime
  /** Aborted when the attempt exceeds its time budget; a provider must stop promptly. */
  signal?: AbortSignal
}

export interface VoucherOcrOutput {
  /** Provider identifier recorded with the attempt (lowercase, [a-z0-9_.-]). */
  provider: string
  model?: string
  fields: Record<string, OcrFieldResult>
  /** Token usage when the provider reports it (pilot cost only; never persisted). */
  usage?: { inputTokens: number; outputTokens: number }
}

export interface VoucherOcrProvider {
  readonly name: string
  extract(input: VoucherOcrInput): Promise<VoucherOcrOutput>
}

/** Typed, sanitized failure codes (they are stored and audited: never put provider messages or voucher content in them). */
export type OcrErrorCode =
  | 'ocr_not_configured'
  | 'ocr_timeout'
  | 'ocr_provider_error'
  | 'ocr_rate_limited'
  | 'ocr_unreadable'
  | 'ocr_invalid_response'
  | 'ocr_file_unavailable'

export class VoucherOcrError extends Error {
  constructor(readonly code: OcrErrorCode) {
    super(code)
    this.name = 'VoucherOcrError'
  }
}

/** The normalized shape persisted in order_documents.ocr_result. */
export interface NormalizedOcrResult {
  model?: string
  fields: Record<string, OcrFieldResult>
}
