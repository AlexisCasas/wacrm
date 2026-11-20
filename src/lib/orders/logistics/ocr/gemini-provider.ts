import { VoucherOcrError, type OcrErrorCode, type VoucherOcrInput, type VoucherOcrOutput, type VoucherOcrProvider } from '@/lib/orders/logistics/ocr/types'
import { DOUBTFUL_CONFIDENCE_CAP, VOUCHER_FIELDS } from '@/lib/orders/logistics/ocr/vision-provider'
import { MAX_DOCUMENT_BYTES } from '@/lib/orders/logistics/constants'

// OCR provider on the Gemini API (native `generateContent`, REST). Same boundary as every provider: `VoucherOcrProvider` -> runDocumentOcr -> normalizeOcrOutput -> human review.
// The output is a SUGGESTION: it never validates a voucher; every failure is a typed code and the voucher falls back to MANUAL review.
//
//   POST {base}/v1beta/models/{model}:generateContent        auth: header `x-goog-api-key` (never in the URL, never logged)
//   body: contents[0].parts = [ inline_data{mime_type, data(base64)}, text(prompt) ] + generationConfig{ responseMimeType: application/json, responseSchema }
//
// INERT unless ORDER_OCR_PROVIDER=gemini AND ORDER_OCR_API_KEY AND ORDER_OCR_MODEL are set (see resolveOcrProvider). The model is NEVER hardcoded.
// PRIVACY: only the voucher file and this fixed prompt are sent (no order, account, contact, conversation or WhatsApp data). No voucher content or provider message is
// ever logged or put in an error.

export const GEMINI_PROVIDER_NAME = 'gemini'
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com'
const MAX_OUTPUT_TOKENS = 1024

export const GEMINI_PROMPT = [
  'You read ONE Shalom Empresarial shipping voucher (a printed receipt, possibly a phone photo or a PDF). Extract ONLY what is printed; never guess or complete.',
  'customer_name, dni and phone are the RECIPIENT (destinatario); ignore the sender (remitente) entirely. amount is the total to pay: digits with a dot decimal, no currency symbol.',
  'shalom_number is the order number and shalom_code the short alphanumeric code; destination is the destination agency or city.',
  'For every field return its value (null if absent or unreadable) and your confidence from 0 to 1. List in doubtful_fields every field you are not sure you read exactly.',
].join('\n')

/** Gemini `responseSchema` (OpenAPI subset): every expected field is REQUIRED, so a missing one is a schema violation, not a silent gap. */
export const GEMINI_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    fields: {
      type: 'OBJECT',
      properties: Object.fromEntries(
        VOUCHER_FIELDS.map((f) => [f, { type: 'OBJECT', properties: { value: { type: 'STRING', nullable: true }, confidence: { type: 'NUMBER' } }, required: ['value', 'confidence'] }]),
      ),
      required: [...VOUCHER_FIELDS],
    },
    doubtful_fields: { type: 'ARRAY', items: { type: 'STRING', enum: [...VOUCHER_FIELDS] } },
  },
  required: ['fields', 'doubtful_fields'],
} as const

export interface GeminiProviderConfig {
  apiKey: string
  model: string
  baseUrl?: string
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

function codeForStatus(status: number): OcrErrorCode {
  if (status === 429) return 'ocr_rate_limited'
  return 'ocr_provider_error' // 400 / 401 / 403 / 404 / 5xx: configuration or provider problem; the manual flow takes over
}

const invalid = () => new VoucherOcrError('ocr_invalid_response')

interface GeminiBody {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>
  promptFeedback?: { blockReason?: string }
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }
}

/** `models/foo` and `foo` are both accepted; anything that is not a plain model id is refused before any request. */
function modelPath(model: string): string {
  const id = model.replace(/^models\//, '')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id)) throw new VoucherOcrError('ocr_not_configured')
  return id
}

export function createGeminiOcrProvider(config: GeminiProviderConfig): VoucherOcrProvider {
  const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const doFetch = config.fetchImpl ?? fetch
  return {
    name: GEMINI_PROVIDER_NAME,
    async extract(input: VoucherOcrInput): Promise<VoucherOcrOutput> {
      if (input.bytes.length > MAX_DOCUMENT_BYTES) throw new VoucherOcrError('ocr_unreadable') // WACRM limit (8 MB): never sent
      const model = modelPath(config.model)
      let response: Response
      try {
        response = await doFetch(`${base}/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          signal: input.signal,
          headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ inline_data: { mime_type: input.mimeType, data: Buffer.from(input.bytes).toString('base64') } }, { text: GEMINI_PROMPT }] }],
            generationConfig: { responseMimeType: 'application/json', responseSchema: GEMINI_RESPONSE_SCHEMA, maxOutputTokens: MAX_OUTPUT_TOKENS },
          }),
        })
      } catch (error) {
        if (input.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw new VoucherOcrError('ocr_timeout')
        throw new VoucherOcrError('ocr_provider_error') // network failure: its message is never kept
      }
      if (!response.ok) throw new VoucherOcrError(codeForStatus(response.status))

      let body: GeminiBody
      try {
        body = (await response.json()) as GeminiBody
      } catch {
        throw invalid()
      }
      if (body?.promptFeedback?.blockReason) throw new VoucherOcrError('ocr_unreadable')
      const candidate = body?.candidates?.[0]
      if (!candidate) throw invalid()
      const finish = candidate.finishReason
      if (finish === 'MAX_TOKENS') throw invalid() // truncated answer: never trusted
      if (finish && finish !== 'STOP') throw new VoucherOcrError('ocr_unreadable') // SAFETY / RECITATION / OTHER ...
      const text = (candidate.content?.parts ?? []).map((p) => (typeof p?.text === 'string' ? p.text : '')).join('')
      if (!text.trim()) throw invalid()

      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw invalid()
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid()
      const { fields: raw, doubtful_fields: doubtfulRaw } = parsed as { fields?: unknown; doubtful_fields?: unknown }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(doubtfulRaw)) throw invalid()
      const doubtful = new Set(doubtfulRaw.filter((d): d is string => typeof d === 'string'))

      // STRICT: every expected field must be present with the right types; extra keys are ignored (never stored).
      const fields: VoucherOcrOutput['fields'] = {}
      for (const name of VOUCHER_FIELDS) {
        const entry = (raw as Record<string, unknown>)[name]
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalid()
        const { value, confidence } = entry as { value?: unknown; confidence?: unknown }
        if (!(value === null || typeof value === 'string')) throw invalid()
        if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw invalid()
        let c = value === null || value.trim() === '' ? 0 : confidence
        if (doubtful.has(name)) c = Math.min(c, DOUBTFUL_CONFIDENCE_CAP)
        fields[name] = { value: value === null || value.trim() === '' ? null : value, confidence: c }
      }

      const u = body.usageMetadata
      const usage = u && typeof u.promptTokenCount === 'number' && typeof u.candidatesTokenCount === 'number' ? { inputTokens: u.promptTokenCount, outputTokens: u.candidatesTokenCount + (u.thoughtsTokenCount ?? 0) } : undefined
      const modelName = /^[a-z0-9_.:-]{1,60}$/i.test(model) ? model : undefined
      return { provider: GEMINI_PROVIDER_NAME, model: modelName, fields, usage }
    },
  }
}
