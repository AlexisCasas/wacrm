import { VoucherOcrError, type OcrErrorCode, type VoucherOcrInput, type VoucherOcrOutput, type VoucherOcrProvider } from '@/lib/orders/logistics/ocr/types'

// P0 parity: the REAL OCR provider of the voucher flow, independent of InkaClick. It reads a Shalom voucher (PDF / JPEG / PNG) with a vision-capable
// LLM through its HTTP Messages API and returns the same `VoucherOcrOutput` the rest of PR-04 already understands (fields with value + 0..1 confidence).
// Everything around it is unchanged: runDocumentOcr (claim / timeout / audit), normalizeOcrOutput (untrusted output), the review screen, the comparison
// with the order and the conservative matching rule. The result stays a SUGGESTION: it never validates a voucher and the manual capture stays the fallback.
//
// INERT unless ORDER_OCR_PROVIDER=vision_llm AND ORDER_OCR_API_KEY AND ORDER_OCR_MODEL are all set (see resolveOcrProvider). The key is read from the
// environment only, never logged, never stored. Errors carry typed codes only: neither provider messages nor voucher content are ever propagated.

export const VISION_PROVIDER_NAME = 'vision_llm'
const DEFAULT_BASE_URL = 'https://api.anthropic.com'
const API_VERSION = '2023-06-01'
const MAX_TOKENS = 1024
/** Per-image limit of the provider API (a PDF has a larger one): a bigger image is not sent, the voucher goes to MANUAL review instead of failing remotely. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** A field the model flags as doubtful can never look confident (parity with InkaClick's `campos_dudosos`). */
export const DOUBTFUL_CONFIDENCE_CAP = 0.5

/** Wacrm field names (what the review screen / comparison / matching read) mapped from what is printed on the Shalom voucher. */
export const VOUCHER_FIELDS = [
  'customer_name', // destinatario (recipient)
  'dni', // destinatario documento
  'phone', // destinatario telefono
  'amount', // total a pagar
  'shalom_number', // numero de orden
  'shalom_code', // codigo
  'destination', // agencia / ciudad de destino
] as const
// DATA MINIMIZATION: only what WACRM uses (comparison with the order, matching, guide registration). The SENDER (remitente: the business itself), the issue date and
// the currency are deliberately NOT requested, so they are neither extracted nor stored. The file itself still contains them: see the privacy notes in the docs.

export const VOUCHER_PROMPT = [
  'You read ONE Shalom Empresarial shipping voucher (a printed receipt, possibly a phone photo or a PDF). Extract ONLY what is printed; never guess or complete.',
  `Return ONLY a JSON object, no prose: {"fields": {<name>: {"value": string|null, "confidence": number 0..1}}, "doubtful": [<name>...]}.`,
  `Allowed names: ${VOUCHER_FIELDS.join(', ')}.`,
  'customer_name, dni, phone are the RECIPIENT (destinatario); ignore the sender (remitente) entirely. amount is the total to pay, digits with dot decimals, no currency symbol.',
  'shalom_number is the order number and shalom_code the short alphanumeric code. Use null when a field is absent or unreadable. List in "doubtful" every field you are not sure you read exactly.',
].join('\n')

export interface VisionProviderConfig {
  apiKey: string
  model: string
  baseUrl?: string
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function codeForStatus(status: number): OcrErrorCode {
  if (status === 429) return 'ocr_rate_limited'
  return 'ocr_provider_error'
}

/** The first JSON object found in the model's text (tolerates a ```json fence around it). */
function parseJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new VoucherOcrError('ocr_invalid_response')
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape')
    return parsed as Record<string, unknown>
  } catch {
    throw new VoucherOcrError('ocr_invalid_response')
  }
}

export function createVisionOcrProvider(config: VisionProviderConfig): VoucherOcrProvider {
  const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const doFetch = config.fetchImpl ?? fetch
  return {
    name: VISION_PROVIDER_NAME,
    async extract(input: VoucherOcrInput): Promise<VoucherOcrOutput> {
      if (input.mimeType !== 'application/pdf' && input.bytes.length > MAX_IMAGE_BYTES) throw new VoucherOcrError('ocr_unreadable')
      const data = toBase64(input.bytes)
      const block =
        input.mimeType === 'application/pdf'
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
          : { type: 'image', source: { type: 'base64', media_type: input.mimeType, data } }
      let response: Response
      try {
        response = await doFetch(`${base}/v1/messages`, {
          method: 'POST',
          signal: input.signal,
          headers: { 'content-type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': API_VERSION },
          body: JSON.stringify({ model: config.model, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: [block, { type: 'text', text: VOUCHER_PROMPT }] }] }),
        })
      } catch (error) {
        if (input.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw new VoucherOcrError('ocr_timeout')
        throw new VoucherOcrError('ocr_provider_error') // network failure: the message is never kept
      }
      if (!response.ok) throw new VoucherOcrError(codeForStatus(response.status))

      let body: { content?: Array<{ type?: string; text?: string }>; stop_reason?: string }
      try {
        body = (await response.json()) as typeof body
      } catch {
        throw new VoucherOcrError('ocr_invalid_response')
      }
      if (body?.stop_reason === 'refusal') throw new VoucherOcrError('ocr_unreadable')
      const text = (body?.content ?? []).filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n')
      if (!text.trim()) throw new VoucherOcrError('ocr_invalid_response')

      const parsed = parseJsonObject(text)
      const raw = parsed.fields
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new VoucherOcrError('ocr_invalid_response')
      const doubtful = new Set(Array.isArray(parsed.doubtful) ? parsed.doubtful.filter((d): d is string => typeof d === 'string') : [])
      const allowed = new Set<string>(VOUCHER_FIELDS)
      const fields: VoucherOcrOutput['fields'] = {}
      for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
        if (!allowed.has(name) || !entry || typeof entry !== 'object') continue
        const e = entry as { value?: unknown; confidence?: unknown }
        const value = typeof e.value === 'string' ? e.value : typeof e.value === 'number' && Number.isFinite(e.value) ? String(e.value) : null
        let confidence = typeof e.confidence === 'number' && Number.isFinite(e.confidence) ? Math.min(1, Math.max(0, e.confidence)) : 0
        if (value === null) confidence = 0
        if (doubtful.has(name)) confidence = Math.min(confidence, DOUBTFUL_CONFIDENCE_CAP)
        fields[name] = { value, confidence }
      }
      return { provider: VISION_PROVIDER_NAME, model: /^[a-z0-9_.:-]{1,60}$/i.test(config.model) ? config.model : undefined, fields }
    },
  }
}
