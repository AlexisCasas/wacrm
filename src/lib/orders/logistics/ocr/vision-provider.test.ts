import { describe, expect, it, vi } from 'vitest'

import { normalizeOcrOutput } from '@/lib/orders/logistics/ocr/normalize-result'
import { resolveOcrProvider } from '@/lib/orders/logistics/ocr/providers'
import { createVisionOcrProvider, DOUBTFUL_CONFIDENCE_CAP } from '@/lib/orders/logistics/ocr/vision-provider'

// No real network, fictitious credentials: `fetchImpl` is always a stub.
const FAKE_KEY = 'test-key-not-real'
const PDF = new TextEncoder().encode('%PDF-1.7\nbytes')
const reply = (text: string, extra: Record<string, unknown> = {}) => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text }], ...extra }) }) as unknown as Response
const mk = (impl: (url: string, init: RequestInit) => Promise<Response>) => {
  const f = vi.fn(impl)
  return { f, provider: createVisionOcrProvider({ apiKey: FAKE_KEY, model: 'test-model-1', fetchImpl: f as unknown as typeof fetch }) }
}
const GOOD = JSON.stringify({ fields: { customer_name: { value: 'Ana Perez', confidence: 0.97 }, dni: { value: '12345678', confidence: 0.9 }, phone: { value: '900000001', confidence: 0.8 }, amount: { value: 150.5, confidence: 0.92 }, shalom_number: { value: '104453167', confidence: 0.95 }, shalom_code: { value: 'N3WC', confidence: 0.9 }, destination: { value: 'Piura', confidence: 0.6 }, bogus: { value: 'x', confidence: 1 } }, doubtful: ['phone'] })

describe('vision OCR provider (no network)', () => {
  it('request: POST with the key in a header and the PDF as a document block; the key never reaches the body', async () => {
    const { f, provider } = mk(async () => reply(GOOD))
    await provider.extract({ bytes: PDF, mimeType: 'application/pdf' })
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(FAKE_KEY)
    const body = JSON.parse(String(init.body))
    expect(String(init.body)).not.toContain(FAKE_KEY)
    expect(body.temperature).toBeUndefined()
    expect(body.messages[0].content[1].text).not.toMatch(/sender_/)
    expect(body.messages[0].content[0]).toMatchObject({ type: 'document', source: { media_type: 'application/pdf' } })
  })

  it('an image over the provider limit is not sent at all: unreadable -> manual review', async () => {
    const { f, provider } = mk(async () => reply(GOOD))
    await expect(provider.extract({ bytes: new Uint8Array(5 * 1024 * 1024 + 1), mimeType: 'image/jpeg' })).rejects.toMatchObject({ code: 'ocr_unreadable' })
    expect(f).not.toHaveBeenCalled()
  })

  it('images go as image blocks', async () => {
    const { f, provider } = mk(async () => reply(GOOD))
    await provider.extract({ bytes: Uint8Array.from([0xff, 0xd8, 0xff]), mimeType: 'image/jpeg' })
    expect(JSON.parse(String(f.mock.calls[0][1].body)).messages[0].content[0]).toMatchObject({ type: 'image', source: { media_type: 'image/jpeg' } })
  })

  it('maps the fields, drops unknown names, numbers become strings, doubtful fields are capped, and the output survives normalization', async () => {
    const { provider } = mk(async () => reply('```json\n' + GOOD + '\n```'))
    const out = await provider.extract({ bytes: PDF, mimeType: 'application/pdf' })
    expect(out.provider).toBe('vision_llm')
    expect(out.fields.bogus).toBeUndefined()
    expect(out.fields.amount).toEqual({ value: '150.5', confidence: 0.92 })
    expect(out.fields.phone.confidence).toBe(DOUBTFUL_CONFIDENCE_CAP) // 0.8 -> capped: doubtful
    expect(out.fields.customer_name.confidence).toBe(0.97)
    const n = normalizeOcrOutput(out)
    expect(n.fields.shalom_number.value).toBe('104453167')
  })

  it('a null value never carries confidence; confidence is clamped', async () => {
    const { provider } = mk(async () => reply(JSON.stringify({ fields: { dni: { value: null, confidence: 0.99 }, phone: { value: '900000001', confidence: 7 } } })))
    const out = await provider.extract({ bytes: PDF, mimeType: 'application/pdf' })
    expect(out.fields.dni).toEqual({ value: null, confidence: 0 })
    expect(out.fields.phone.confidence).toBe(1)
  })

  it('errors are typed and carry nothing from the provider: 429 -> rate limited, 5xx / 401 -> provider error', async () => {
    for (const [status, code] of [[429, 'ocr_rate_limited'], [500, 'ocr_provider_error'], [401, 'ocr_provider_error'], [529, 'ocr_provider_error']] as const) {
      const { provider } = mk(async () => ({ ok: false, status, json: async () => ({ error: { message: 'SECRET provider text' } }) }) as unknown as Response)
      const err = await provider.extract({ bytes: PDF, mimeType: 'application/pdf' }).catch((e) => e)
      expect(err).toMatchObject({ code })
      expect(String(err.message)).not.toContain('SECRET')
    }
  })

  it('network failure -> ocr_provider_error; abort (timeout budget) -> ocr_timeout; the message of the fetch error is not kept', async () => {
    const net = mk(async () => { throw new Error('getaddrinfo ENOTFOUND secret-host') })
    const e1 = await net.provider.extract({ bytes: PDF, mimeType: 'application/pdf' }).catch((e) => e)
    expect(e1).toMatchObject({ code: 'ocr_provider_error' })
    expect(String(e1.message)).not.toContain('secret-host')
    const controller = new AbortController()
    const hung = mk((_u, init) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })))
    const p = hung.provider.extract({ bytes: PDF, mimeType: 'application/pdf', signal: controller.signal })
    controller.abort()
    await expect(p).rejects.toMatchObject({ code: 'ocr_timeout' })
  })

  it('invalid responses: not JSON, no fields, wrong shape, empty content -> ocr_invalid_response; refusal -> ocr_unreadable', async () => {
    for (const r of [reply('I cannot help'), reply('{"nothing": 1}'), reply('{"fields": []}'), reply('{ broken'), { ok: true, status: 200, json: async () => ({ content: [] }) } as unknown as Response, { ok: true, status: 200, json: async () => { throw new Error('bad json') } } as unknown as Response]) {
      const { provider } = mk(async () => r)
      await expect(provider.extract({ bytes: PDF, mimeType: 'application/pdf' })).rejects.toMatchObject({ code: 'ocr_invalid_response' })
    }
    const { provider } = mk(async () => reply('x', { stop_reason: 'refusal' }))
    await expect(provider.extract({ bytes: PDF, mimeType: 'application/pdf' })).rejects.toMatchObject({ code: 'ocr_unreadable' })
  })

  it('a response with only unknown / empty fields is unreadable after normalization (manual capture takes over)', async () => {
    const { provider } = mk(async () => reply(JSON.stringify({ fields: { bogus: { value: 'x', confidence: 1 } } })))
    const out = await provider.extract({ bytes: PDF, mimeType: 'application/pdf' })
    expect(() => normalizeOcrOutput(out)).toThrow()
  })
})

describe('resolveOcrProvider with the real provider', () => {
  const full = { ORDER_OCR_PROVIDER: 'vision_llm', ORDER_OCR_API_KEY: FAKE_KEY, ORDER_OCR_MODEL: 'test-model-1' }
  it('needs all three variables; anything missing stays not_configured (manual flow untouched)', () => {
    expect(resolveOcrProvider(full).name).toBe('vision_llm')
    expect(resolveOcrProvider({ ...full, NODE_ENV: 'production' }).name).toBe('vision_llm')
    expect(resolveOcrProvider({ ...full, ORDER_OCR_API_KEY: '' }).name).toBe('not_configured')
    expect(resolveOcrProvider({ ...full, ORDER_OCR_MODEL: undefined }).name).toBe('not_configured')
    expect(resolveOcrProvider({ ORDER_OCR_PROVIDER: 'vision_llm' }).name).toBe('not_configured')
    expect(resolveOcrProvider({}).name).toBe('not_configured')
  })
})
