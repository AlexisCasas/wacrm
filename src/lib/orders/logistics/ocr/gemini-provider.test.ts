import { describe, expect, it, vi } from 'vitest'

import { createGeminiOcrProvider, GEMINI_PROMPT, GEMINI_RESPONSE_SCHEMA } from '@/lib/orders/logistics/ocr/gemini-provider'
import { normalizeOcrOutput } from '@/lib/orders/logistics/ocr/normalize-result'
import { resolveOcrProvider } from '@/lib/orders/logistics/ocr/providers'
import { VOUCHER_FIELDS } from '@/lib/orders/logistics/ocr/vision-provider'

// No real network, fictitious credentials: `fetchImpl` is always a stub.
const FAKE_KEY = 'AIza-test-key-not-real'
const PDF = new TextEncoder().encode('%PDF-1.7\nbytes')
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])

const fieldsOk = (over: Record<string, unknown> = {}) => ({
  customer_name: { value: 'Ana Perez', confidence: 0.97 },
  dni: { value: '12345678', confidence: 0.9 },
  phone: { value: '900000001', confidence: 0.8 },
  amount: { value: '150.50', confidence: 0.92 },
  shalom_number: { value: '104453167', confidence: 0.95 },
  shalom_code: { value: 'N3WC', confidence: 0.9 },
  destination: { value: 'Piura', confidence: 0.6 },
  ...over,
})
const payload = (fields: unknown = fieldsOk(), doubtful: unknown = ['phone']) => JSON.stringify({ fields, doubtful_fields: doubtful })
const reply = (text: string, over: Record<string, unknown> = {}) =>
  ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 200 }, ...over }) }) as unknown as Response
const mk = (impl: (url: string, init: RequestInit) => Promise<Response>, model = 'models/test-flash-1') => {
  const f = vi.fn(impl)
  return { f, provider: createGeminiOcrProvider({ apiKey: FAKE_KEY, model, fetchImpl: f as unknown as typeof fetch }) }
}
const run = (p: { extract: (i: { bytes: Uint8Array; mimeType: 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp'; signal?: AbortSignal }) => Promise<unknown> }, bytes = PDF, mimeType: 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp' = 'application/pdf') => p.extract({ bytes, mimeType })

describe('gemini OCR provider (no network)', () => {
  it('request: native generateContent, key ONLY in the x-goog-api-key header (never in the URL or body), inline file + prompt, JSON schema', async () => {
    const { f, provider } = mk(async () => reply(payload()))
    await run(provider)
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/test-flash-1:generateContent')
    expect(url).not.toContain(FAKE_KEY)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe(FAKE_KEY)
    expect(String(init.body)).not.toContain(FAKE_KEY)
    const body = JSON.parse(String(init.body))
    expect(body.contents[0].parts[0].inline_data.mime_type).toBe('application/pdf')
    expect(body.contents[0].parts[0].inline_data.data).toBe(Buffer.from(PDF).toString('base64'))
    expect(body.contents[0].parts).toHaveLength(2) // the file + the fixed prompt, nothing else
    expect(body.generationConfig.responseMimeType).toBe('application/json')
    expect(body.generationConfig.responseSchema).toEqual(JSON.parse(JSON.stringify(GEMINI_RESPONSE_SCHEMA)))
    expect(JSON.stringify(body)).not.toMatch(/sender_|remitente_|order_id|account|conversation|whatsapp/i)
  })

  it('destination is ONLY the text after the "Destino:" label: agency, address, reference and anything after it are excluded (instruction text; nothing hardcoded)', async () => {
    const line = GEMINI_PROMPT.split('\n').find((l) => l.startsWith('destination is'))!
    expect(line).toContain('ONLY')
    expect(line).toContain('immediately after the label "Destino:"')
    for (const excluded of ['agency name', 'address', 'reference', 'additional branch', 'text that follows']) expect(line).toContain(excluded)
    expect(line).toContain('"Agencia:"')
    expect(line).toContain('"Dirección:"')
    expect(GEMINI_PROMPT).not.toMatch(/Piura|Sullana/) // no hardcoded example
    expect(GEMINI_PROMPT).not.toContain('destination agency or city')
    const { f, provider } = mk(async () => reply(payload()))
    await run(provider)
    expect(JSON.parse(String(f.mock.calls[0][1].body)).contents[0].parts[1].text).toBe(GEMINI_PROMPT)
  })

  it('missing usage metadata is not an error: usage stays undefined (never invented)', async () => {
    for (const usageMetadata of [undefined, {}, { promptTokenCount: 10 }]) {
      const { provider } = mk(async () => reply(payload(), { usageMetadata }))
      const out = await run(provider) as Awaited<ReturnType<typeof provider.extract>>
      expect(out.usage).toBeUndefined()
      expect(out.fields.customer_name.value).toBe('Ana Perez')
    }
  })

  it('every supported format goes inline with its own MIME type', async () => {
    for (const mime of ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const) {
      const { f, provider } = mk(async () => reply(payload()))
      await run(provider, mime === 'application/pdf' ? PDF : JPEG, mime)
      expect(JSON.parse(String(f.mock.calls[0][1].body)).contents[0].parts[0].inline_data.mime_type).toBe(mime)
    }
  })

  it('the schema requires exactly the 7 fields + doubtful_fields (nothing unnecessary is asked)', () => {
    expect(Object.keys(GEMINI_RESPONSE_SCHEMA.properties.fields.properties)).toEqual([...VOUCHER_FIELDS])
    expect(GEMINI_RESPONSE_SCHEMA.properties.fields.required).toEqual([...VOUCHER_FIELDS])
    expect(GEMINI_RESPONSE_SCHEMA.required).toEqual(['fields', 'doubtful_fields'])
    expect([...VOUCHER_FIELDS]).toEqual(['customer_name', 'dni', 'phone', 'amount', 'shalom_number', 'shalom_code', 'destination'])
  })

  it('valid structured JSON: values and confidences kept, doubtful fields capped at 0.5, usage reported, survives normalization', async () => {
    const { provider } = mk(async () => reply(payload()))
    const out = await run(provider) as Awaited<ReturnType<typeof provider.extract>>
    expect(out.provider).toBe('gemini')
    expect(out.model).toBe('test-flash-1')
    expect(out.fields.customer_name).toEqual({ value: 'Ana Perez', confidence: 0.97 })
    expect(out.fields.phone.confidence).toBe(0.5) // 0.8 -> capped: doubtful
    expect(out.usage).toEqual({ inputTokens: 1500, outputTokens: 200 })
    expect(Object.keys(out.fields)).toEqual([...VOUCHER_FIELDS])
    expect(normalizeOcrOutput(out).fields.shalom_number.value).toBe('104453167')
  })

  it('null / blank values carry no confidence', async () => {
    const { provider } = mk(async () => reply(payload(fieldsOk({ dni: { value: null, confidence: 0.99 }, destination: { value: '  ', confidence: 0.9 } }), [])))
    const out = await run(provider) as Awaited<ReturnType<typeof provider.extract>>
    expect(out.fields.dni).toEqual({ value: null, confidence: 0 })
    expect(out.fields.destination).toEqual({ value: null, confidence: 0 })
  })

  it('401 / 403 / 400 / 404 / 5xx -> ocr_provider_error; 429 -> ocr_rate_limited; the provider message is never kept', async () => {
    for (const [status, code] of [[401, 'ocr_provider_error'], [403, 'ocr_provider_error'], [400, 'ocr_provider_error'], [404, 'ocr_provider_error'], [429, 'ocr_rate_limited'], [500, 'ocr_provider_error'], [503, 'ocr_provider_error']] as const) {
      const { provider } = mk(async () => ({ ok: false, status, json: async () => ({ error: { message: 'SECRET provider text' } }) }) as unknown as Response)
      const err = (await run(provider).catch((e) => e)) as { code?: string; message: string }
      expect(err).toMatchObject({ code })
      expect(String(err.message)).not.toContain('SECRET')
    }
  })

  it('network failure -> ocr_provider_error (message dropped); abort -> ocr_timeout', async () => {
    const net = mk(async () => { throw new Error('getaddrinfo ENOTFOUND secret-host') })
    const e1 = (await run(net.provider).catch((e) => e)) as { code?: string; message: string }
    expect(e1).toMatchObject({ code: 'ocr_provider_error' })
    expect(String(e1.message)).not.toContain('secret-host')
    const controller = new AbortController()
    const hung = mk((_u, init) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })))
    const p = hung.provider.extract({ bytes: PDF, mimeType: 'application/pdf', signal: controller.signal })
    controller.abort()
    await expect(p).rejects.toMatchObject({ code: 'ocr_timeout' })
  })

  it('invalid JSON, non-object, wrong types, out-of-range confidence, empty text, no candidates, unreadable body -> ocr_invalid_response', async () => {
    const bad: Response[] = [
      reply('not json'), reply('[]'), reply('{ broken'), reply(''),
      reply(payload(fieldsOk({ dni: { value: 12345678, confidence: 0.9 } }))),
      reply(payload(fieldsOk({ dni: { value: '12345678', confidence: 1.5 } }))),
      reply(payload(fieldsOk({ dni: { value: '12345678', confidence: '0.9' } }))),
      reply(payload(fieldsOk(), 'phone')),
      reply(JSON.stringify({ fields: fieldsOk() })),
      reply(JSON.stringify({ doubtful_fields: [] })),
      { ok: true, status: 200, json: async () => ({ candidates: [] }) } as unknown as Response,
      { ok: true, status: 200, json: async () => { throw new Error('bad json') } } as unknown as Response,
    ]
    for (const r of bad) {
      const { provider } = mk(async () => r)
      await expect(run(provider)).rejects.toMatchObject({ code: 'ocr_invalid_response' })
    }
  })

  it('a MISSING expected field is an invalid response (strict), not a silent gap', async () => {
    for (const name of VOUCHER_FIELDS) {
      const f = fieldsOk() as Record<string, unknown>
      delete f[name]
      const { provider } = mk(async () => reply(payload(f)))
      await expect(run(provider)).rejects.toMatchObject({ code: 'ocr_invalid_response' })
    }
  })

  it('truncated answer (MAX_TOKENS) -> ocr_invalid_response even if the cut JSON happens to parse', async () => {
    const { provider } = mk(async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: payload() }] }, finishReason: 'MAX_TOKENS' }] }) }) as unknown as Response)
    await expect(run(provider)).rejects.toMatchObject({ code: 'ocr_invalid_response' })
  })

  it('blocked / safety / other finish reasons -> ocr_unreadable (manual review)', async () => {
    for (const body of [{ promptFeedback: { blockReason: 'SAFETY' } }, { candidates: [{ finishReason: 'SAFETY' }] }, { candidates: [{ finishReason: 'RECITATION' }] }, { candidates: [{ finishReason: 'OTHER' }] }]) {
      const { provider } = mk(async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response)
      const err = (await run(provider).catch((e) => e)) as { code?: string; message: string }
      expect(err.code === 'ocr_unreadable' || err.code === 'ocr_invalid_response').toBe(true)
    }
    const blocked = mk(async () => ({ ok: true, status: 200, json: async () => ({ promptFeedback: { blockReason: 'SAFETY' } }) }) as unknown as Response)
    await expect(run(blocked.provider)).rejects.toMatchObject({ code: 'ocr_unreadable' })
  })

  it('a file over the WACRM limit (8 MB) is never sent -> ocr_unreadable (manual review)', async () => {
    const { f, provider } = mk(async () => reply(payload()))
    await expect(run(provider, new Uint8Array(8 * 1024 * 1024 + 1), 'image/jpeg')).rejects.toMatchObject({ code: 'ocr_unreadable' })
    expect(f).not.toHaveBeenCalled()
  })

  it('a model id that is not a plain id is refused before any request', async () => {
    const { f, provider } = mk(async () => reply(payload()), 'x/../../v1/files')
    await expect(run(provider)).rejects.toMatchObject({ code: 'ocr_not_configured' })
    expect(f).not.toHaveBeenCalled()
  })

  it('a custom base URL is honoured (no trailing slash issues); the model is never hardcoded', async () => {
    const f = vi.fn(async () => reply(payload()))
    const p = createGeminiOcrProvider({ apiKey: FAKE_KEY, model: 'other-model', baseUrl: 'https://proxy.example.test/', fetchImpl: f as unknown as typeof fetch })
    await run(p)
    expect((f.mock.calls[0] as unknown[])[0]).toBe('https://proxy.example.test/v1beta/models/other-model:generateContent')
  })
})

describe('resolveOcrProvider: gemini, vision_llm and manual fallback', () => {
  const g = { ORDER_OCR_PROVIDER: 'gemini', ORDER_OCR_API_KEY: FAKE_KEY, ORDER_OCR_MODEL: 'test-flash-1' }
  it('gemini needs all three variables; anything missing stays not_configured (manual flow untouched)', async () => {
    expect(resolveOcrProvider(g).name).toBe('gemini')
    expect(resolveOcrProvider({ ...g, NODE_ENV: 'production' }).name).toBe('gemini')
    for (const miss of ['ORDER_OCR_API_KEY', 'ORDER_OCR_MODEL'] as const) expect(resolveOcrProvider({ ...g, [miss]: '' }).name).toBe('not_configured')
    expect(resolveOcrProvider({ ORDER_OCR_PROVIDER: 'gemini' }).name).toBe('not_configured')
    await expect(resolveOcrProvider({}).extract({ bytes: PDF, mimeType: 'application/pdf' })).rejects.toMatchObject({ code: 'ocr_not_configured' })
  })

  it('compatibility: vision_llm still resolves to the previous provider, fake stays dev-only, unknown names stay not_configured', () => {
    expect(resolveOcrProvider({ ...g, ORDER_OCR_PROVIDER: 'vision_llm' }).name).toBe('vision_llm')
    expect(resolveOcrProvider({ ORDER_OCR_PROVIDER: 'fake', NODE_ENV: 'development' }).name).toBe('fake')
    expect(resolveOcrProvider({ ORDER_OCR_PROVIDER: 'fake', NODE_ENV: 'production' }).name).toBe('not_configured')
    expect(resolveOcrProvider({ ...g, ORDER_OCR_PROVIDER: 'openai' }).name).toBe('not_configured')
  })
})
