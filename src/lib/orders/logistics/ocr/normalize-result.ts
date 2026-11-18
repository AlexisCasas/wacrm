import { VoucherOcrError, type NormalizedOcrResult, type OcrFieldResult, type VoucherOcrOutput } from '@/lib/orders/logistics/ocr/types'

// What a provider returns is untrusted data: it is validated and reduced to the persisted shape before it reaches the database. Field names are
// snake_case words; values are short strings; confidence is clamped to 0..1. Anything else is dropped (never stored, never logged).

export const MAX_OCR_FIELDS = 30
export const MAX_OCR_VALUE_LENGTH = 200
const FIELD_NAME = /^[a-z][a-z0-9_]{0,39}$/

export function normalizeOcrOutput(output: VoucherOcrOutput): NormalizedOcrResult {
  if (!output || typeof output !== 'object' || typeof output.fields !== 'object' || output.fields === null) throw new VoucherOcrError('ocr_invalid_response')

  const fields: Record<string, OcrFieldResult> = {}
  for (const [name, raw] of Object.entries(output.fields)) {
    if (Object.keys(fields).length >= MAX_OCR_FIELDS) break
    if (!FIELD_NAME.test(name) || typeof raw !== 'object' || raw === null) continue
    const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? Math.min(1, Math.max(0, raw.confidence)) : 0
    const value = typeof raw.value === 'string' ? raw.value.trim().slice(0, MAX_OCR_VALUE_LENGTH) : typeof raw.value === 'number' && Number.isFinite(raw.value) ? String(raw.value) : null
    fields[name] = { value: value === '' ? null : value, confidence: Math.round(confidence * 1000) / 1000 }
  }
  if (Object.keys(fields).length === 0) throw new VoucherOcrError('ocr_unreadable')

  const model = typeof output.model === 'string' && /^[a-z0-9_.:-]{1,60}$/i.test(output.model) ? output.model : undefined
  return model ? { model, fields } : { fields }
}

/** Provider names are stored: keep them to the database's own format. */
export function safeProviderName(name: string): string {
  return /^[a-z0-9_.-]{1,40}$/.test(name) ? name : 'unknown'
}
