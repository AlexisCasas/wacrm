import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sanitizePhoneForMeta } from '../whatsapp/phone-utils'
import { parseRetryAfterSeconds, sendMediaMessage, sendTextMessage } from '../whatsapp/meta-api'
import { MockMetaTransport } from './test-support/mock-meta-transport'
import { buildMetaRequestBody, createMetaEffectSender, HttpTransportError, isRateLimited, META_GRAPH_BASE_URL, parseRetryAfter, type MetaSenderEvent, type MetaSendContext } from './versioned-meta-sender'
import type { OutboundPayload, OutboundRequest } from './versioned-messaging'

const TOKEN = 'SYNTHETIC-TOKEN-NOT-REAL-9f3a'
const PHONE = '+37063949836'
const ctx = (over: Partial<MetaSendContext & { ok: true }> = {}): MetaSendContext => ({ ok: true, phoneNumberId: '1234567890', accessToken: TOKEN, recipientPhone: PHONE, ...over })
const req = (payload: OutboundPayload, over: Partial<OutboundRequest> = {}): OutboundRequest => ({ effectId: 'e1', attemptId: '11111111-1111-4111-8111-111111111111', attempt: 1, occurrenceKey: 'run:3', effectType: payload.kind === 'text' ? 'send_message' : 'send_media', contactId: 'c', conversationId: 'v', payload, ...over })
const TEXT: OutboundPayload = { kind: 'text', text: 'Hola Ana, ¿cómo estás?' }
function make(t: MockMetaTransport, o: { context?: MetaSendContext; resolve?: () => Promise<MetaSendContext>; maxVariants?: number; callbackData?: 'none' | 'attempt' } = {}) {
  const events: MetaSenderEvent[] = []
  const sender = createMetaEffectSender({ transport: t, resolveContext: o.resolve ?? (async () => o.context ?? ctx()), onEvent: (e) => events.push(e), maxVariants: o.maxVariants, callbackData: o.callbackData })
  return { sender, events }
}
afterEach(() => { vi.unstubAllGlobals() })

describe('wire contract with the legacy sender (src/lib/whatsapp/meta-api.ts)', () => {
  async function legacy(call: () => Promise<unknown>) {
    const seen: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { seen.push({ url, init }); return new Response(JSON.stringify({ messages: [{ id: 'wamid.LEGACY' }] }), { status: 200 }) })
    await call()
    return { url: seen[0].url, headers: seen[0].init.headers as Record<string, string>, body: JSON.parse(String(seen[0].init.body)) as Record<string, unknown> }
  }
  it('text: same URL, headers and body as sendTextMessage', async () => {
    const l = await legacy(() => sendTextMessage({ phoneNumberId: '1234567890', accessToken: TOKEN, to: '37063949836', text: TEXT.kind === 'text' ? TEXT.text : '' }))
    const t = new MockMetaTransport()
    await make(t).sender.send(req(TEXT))
    expect({ url: t.requests[0].url, headers: t.requests[0].headers, body: t.requests[0].body }).toEqual(l)
    expect(META_GRAPH_BASE_URL).toBe(l.url.replace('/1234567890/messages', ''))
  })
  it.each([
    [{ kind: 'media', media_type: 'image', media_url: 'https://x.test/a.png', caption: 'Look' } as OutboundPayload, { kind: 'image', link: 'https://x.test/a.png', caption: 'Look' }],
    [{ kind: 'media', media_type: 'video', media_url: 'https://x.test/a.mp4' } as OutboundPayload, { kind: 'video', link: 'https://x.test/a.mp4' }],
    [{ kind: 'media', media_type: 'document', media_url: 'https://x.test/a.pdf', caption: 'Doc', filename: 'a.pdf' } as OutboundPayload, { kind: 'document', link: 'https://x.test/a.pdf', caption: 'Doc', filename: 'a.pdf' }],
  ])('media %#: same wire body as sendMediaMessage', async (payload, legacyArgs) => {
    const l = await legacy(() => sendMediaMessage({ phoneNumberId: '1234567890', accessToken: TOKEN, to: '37063949836', ...legacyArgs } as Parameters<typeof sendMediaMessage>[0]))
    const t = new MockMetaTransport()
    await make(t).sender.send(req(payload))
    expect({ url: t.requests[0].url, headers: t.requests[0].headers, body: t.requests[0].body }).toEqual(l)
  })
  it('the callback data field is opt-in (default keeps the body identical to the legacy one)', () => {
    expect(buildMetaRequestBody(TEXT, '37063949836')).not.toHaveProperty('biz_opaque_callback_data')
    expect(buildMetaRequestBody(TEXT, '37063949836', 'att-1')).toHaveProperty('biz_opaque_callback_data', 'att-1')
  })
  it('an image document caption/filename rules: filename only for documents, no empty caption', () => {
    const body = buildMetaRequestBody({ kind: 'media', media_type: 'image', media_url: 'https://x.test/a.png', filename: 'ignored.png', caption: '' }, '1') as { image: Record<string, unknown> }
    expect(body.image).toEqual({ link: 'https://x.test/a.png' })
  })
})

describe('classification', () => {
  it('accepted: 2xx with a well-formed wamid', async () => {
    const t = new MockMetaTransport(); const { sender } = make(t)
    const out = await sender.send(req(TEXT))
    expect(out).toEqual({ kind: 'accepted', providerMessageId: t.wamids[0] })
    expect(t.requests).toHaveLength(1)
  })
  it.each([
    ['invalid_param', 'meta_100'], ['undeliverable', 'undeliverable'], ['auth_error', 'auth_error'],
  ] as const)('definitive refusal %s -> rejected/%s with a single request', async (behavior, code) => {
    const t = new MockMetaTransport().script(behavior); const { sender } = make(t)
    expect(await sender.send(req(TEXT))).toEqual({ kind: 'rejected', errorCode: code })
    expect(t.requests).toHaveLength(1)
    expect(t.delivered).toHaveLength(0)
  })
  it.each([
    ['accept_then_timeout', 'transport_timeout'], ['lost_response', 'transport_unknown'], ['reset_in_flight', 'transport_reset'], ['server_error', 'http_500'], ['accepted_no_id', 'accepted_without_wamid'],
  ] as const)('%s is AMBIGUOUS (never not_dispatched) and is not retried here', async (behavior, code) => {
    const t = new MockMetaTransport().script(behavior); const { sender } = make(t)
    expect(await sender.send(req(TEXT))).toEqual({ kind: 'ambiguous', errorCode: code })
    expect(t.requests).toHaveLength(1)
  })
  it('only a transport that PROVES nothing was transmitted yields not_dispatched', async () => {
    const t = new MockMetaTransport().script('refused_before_send'); const { sender } = make(t)
    expect(await sender.send(req(TEXT))).toEqual({ kind: 'not_dispatched', errorCode: 'connect_refused' })
    // a typed in-flight error, an untyped error and an abort are all ambiguous
    for (const thrown of [new HttpTransportError('x', 'in_flight'), new Error('boom'), Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })]) {
      const bad = { post: async () => { throw thrown } }
      const s = createMetaEffectSender({ transport: bad, resolveContext: async () => ctx() })
      expect((await s.send(req(TEXT))).kind).toBe('ambiguous')
    }
  })
  it('HTTP status rules: 4xx = definitive (except 408), 408 / 5xx / 3xx = ambiguous, non-JSON bodies do not change that', async () => {
    const run = async (status: number, body: string) => createMetaEffectSender({ transport: { post: async () => ({ status, body }) }, resolveContext: async () => ctx() }).send(req(TEXT))
    expect((await run(404, 'not json')).kind).toBe('rejected')
    expect((await run(400, '')).kind).toBe('rejected')
    expect(await run(408, '{}')).toMatchObject({ kind: 'ambiguous', errorCode: 'http_408' })
    for (const s of [500, 502, 503, 504, 301]) expect((await run(s, '<html>')).kind, String(s)).toBe('ambiguous')
    expect((await run(200, 'not json')).kind).toBe('ambiguous')
    expect((await run(200, JSON.stringify({ messages: [{ id: 'not-a-wamid' }] }))).kind).toBe('ambiguous')
    expect((await run(200, JSON.stringify({ messages: [{ id: 5 }] }))).kind).toBe('ambiguous')
  })
  it('nothing is sent when there is nothing valid to send to', async () => {
    const t = new MockMetaTransport()
    expect(await make(t, { context: ctx({ recipientPhone: 'abc' }) }).sender.send(req(TEXT))).toEqual({ kind: 'rejected', errorCode: 'invalid_recipient' })
    expect(await make(t, { context: ctx({ recipientPhone: '' }) }).sender.send(req(TEXT))).toEqual({ kind: 'rejected', errorCode: 'invalid_recipient' })
    expect(await make(t, { context: { ok: false, kind: 'recipient_unavailable', code: 'contact_has_no_phone' } }).sender.send(req(TEXT))).toEqual({ kind: 'rejected', errorCode: 'contact_has_no_phone' })
    expect(await make(t, { context: { ok: false, kind: 'config_unavailable', code: 'whatsapp_not_configured' } }).sender.send(req(TEXT))).toEqual({ kind: 'not_dispatched', errorCode: 'whatsapp_not_configured' })
    expect(await make(t, { resolve: async () => { throw new Error('db down') } }).sender.send(req(TEXT))).toEqual({ kind: 'not_dispatched', errorCode: 'context_error' })
    expect(t.requests).toHaveLength(0)
  })
})

describe('temporary rejections (HTTP 429 / Meta throttling)', () => {
  it('HTTP 429 is a retryable rejection, not a definitive rejection and not not_dispatched', async () => {
    const t = new MockMetaTransport().script('rate_limited'); const { sender, events } = make(t)
    const out = await sender.send(req(TEXT))
    expect(out).toEqual({ kind: 'retryable_rejection', errorCode: 'rate_limited' })
    expect(t.requests).toHaveLength(1); expect(t.delivered).toHaveLength(0)
    expect(events.at(-1)).toMatchObject({ classification: 'retryable_rejection', httpStatus: 429, metaCode: 131056 })
  })
  it('carries a valid Retry-After and ignores a missing or unusable one', async () => {
    const run = async (header: string | undefined) => {
      const t = new MockMetaTransport().script('rate_limited'); t.retryAfterHeader = header
      return make(t).sender.send(req(TEXT))
    }
    expect(await run('120')).toEqual({ kind: 'retryable_rejection', errorCode: 'rate_limited', retryAfterSeconds: 120 })
    expect(await run(undefined)).toEqual({ kind: 'retryable_rejection', errorCode: 'rate_limited' })
    for (const bad of ['', 'soon', '0', '-5', '1.5', '12abc']) expect(await run(bad), bad).toEqual({ kind: 'retryable_rejection', errorCode: 'rate_limited' })
    expect(await run('999999')).toEqual({ kind: 'retryable_rejection', errorCode: 'rate_limited', retryAfterSeconds: 86400 })
  })
  it('Meta throttling codes count even when the HTTP status is 400', async () => {
    const t = new MockMetaTransport().script('throttled_400')
    expect(await make(t).sender.send(req(TEXT))).toMatchObject({ kind: 'retryable_rejection', errorCode: 'rate_limited' })
    expect(isRateLimited(429, {})).toBe(true); expect(isRateLimited(400, { code: 131056 })).toBe(true); expect(isRateLimited(400, { code: 130429 })).toBe(true)
    expect(isRateLimited(400, { code: 80007 })).toBe(true); expect(isRateLimited(400, { code: 100 })).toBe(false); expect(isRateLimited(500, {})).toBe(false)
  })
  it('the other classes are unchanged: 400 definitive, 5xx and timeouts ambiguous, nothing before transmission', async () => {
    expect(await make(new MockMetaTransport().script('invalid_param')).sender.send(req(TEXT))).toEqual({ kind: 'rejected', errorCode: 'meta_100' })
    expect(await make(new MockMetaTransport().script('server_error')).sender.send(req(TEXT))).toEqual({ kind: 'ambiguous', errorCode: 'http_500' })
    expect(await make(new MockMetaTransport().script('accept_then_timeout')).sender.send(req(TEXT))).toEqual({ kind: 'ambiguous', errorCode: 'transport_timeout' })
    expect(await make(new MockMetaTransport().script('refused_before_send')).sender.send(req(TEXT))).toEqual({ kind: 'not_dispatched', errorCode: 'connect_refused' })
  })
  it('the rate limit is never retried inside the adapter', async () => {
    const t = new MockMetaTransport().setDefault('rate_limited'); await make(t).sender.send(req(TEXT))
    expect(t.requests).toHaveLength(1)
  })
})

describe('parseRetryAfter', () => {
  const NOW = Date.parse('2026-10-14T10:00:00Z')
  it('reads delta-seconds and HTTP-dates, case-insensitively, and bounds the result to 1..86400', () => {
    expect(parseRetryAfter({ 'Retry-After': '30' }, NOW)).toBe(30)
    expect(parseRetryAfter({ 'retry-after': ' 45 ' }, NOW)).toBe(45)
    expect(parseRetryAfter({ 'RETRY-AFTER': '1' }, NOW)).toBe(1)
    expect(parseRetryAfter({ 'Retry-After': 'Wed, 14 Oct 2026 10:02:00 GMT' }, NOW)).toBe(120)
    expect(parseRetryAfter({ 'Retry-After': 'Wed, 14 Oct 2026 10:00:01 GMT' }, NOW)).toBe(1)
    expect(parseRetryAfter({ 'Retry-After': 'Wed, 14 Oct 2026 10:00:00 GMT' }, NOW)).toBeUndefined()      // not in the future: unusable
    expect(parseRetryAfter({ 'Retry-After': 'Wed, 14 Oct 2026 09:00:00 GMT' }, NOW)).toBeUndefined()
    expect(parseRetryAfter({ 'Retry-After': 'Fri, 16 Oct 2026 10:00:00 GMT' }, NOW)).toBe(86400)
    for (const bad of ['', '0', '-1', 'abc', '1e3', '99999999999']) expect(parseRetryAfter({ 'Retry-After': bad }, NOW), bad).toBeUndefined()
    expect(parseRetryAfter(undefined, NOW)).toBeUndefined(); expect(parseRetryAfter({}, NOW)).toBeUndefined()
  })
  it('agrees with the legacy parser on every value both consider valid and in range', () => {
    for (const v of ['1', '30', '120', '3600', 'Wed, 14 Oct 2026 10:02:00 GMT']) {
      expect(parseRetryAfter({ 'Retry-After': v }, NOW), v).toBe(parseRetryAfterSeconds(v, new Date(NOW)))
    }
    for (const v of [null, '', '0', '-3', 'garbage']) expect(parseRetryAfter({ 'Retry-After': v ?? '' }, NOW)).toBe(parseRetryAfterSeconds(v, new Date(NOW)) || undefined)
  })
})

describe('one recipient only (no altered numbers)', () => {
  const sanitized = sanitizePhoneForMeta(PHONE)
  it('a valid number gets exactly one request, to exactly that number', async () => {
    const t = new MockMetaTransport(); const { sender } = make(t)
    expect((await sender.send(req(TEXT))).kind).toBe('accepted')
    expect(t.requests).toHaveLength(1)
    expect(t.requests[0].to).toBe(sanitized)
  })
  it('an invalid number gets zero requests', async () => {
    for (const bad of ['abc', '', '123', '+0000', '12345678901234567']) {
      const t = new MockMetaTransport()
      expect(await make(t, { context: ctx({ recipientPhone: bad }) }).sender.send(req(TEXT)), bad).toEqual({ kind: 'rejected', errorCode: 'invalid_recipient' })
      expect(t.requests, bad).toHaveLength(0)
    }
  })
  it('when Meta rejects the original recipient no other number is tried', async () => {
    const t = new MockMetaTransport().setDefault('not_allowed'); const { sender } = make(t)
    expect(await sender.send(req(TEXT))).toEqual({ kind: 'rejected', errorCode: 'recipient_not_allowed' })
    expect(t.requests).toHaveLength(1)
    expect(t.delivered).toHaveLength(0)
  })
  it('after a timeout no other number is tried either', async () => {
    const t = new MockMetaTransport().script('accept_then_timeout', 'accept', 'accept'); const { sender } = make(t)
    expect(await sender.send(req(TEXT))).toEqual({ kind: 'ambiguous', errorCode: 'transport_timeout' })
    expect(t.requests).toHaveLength(1)
    expect(t.delivered).toHaveLength(1)                                     // only the original number can have received it
  })
  it('an old configuration with maxVariants > 1 does NOT bring variants back', async () => {
    for (const maxVariants of [2, 3, 7, 99]) {
      const t = new MockMetaTransport().setDefault('not_allowed')
      const out = await make(t, { maxVariants }).sender.send(req(TEXT))
      expect(out, String(maxVariants)).toEqual({ kind: 'rejected', errorCode: 'recipient_not_allowed' })
      expect(t.requests, String(maxVariants)).toHaveLength(1)
    }
  })
  it('every request ever sent carries the sanitised original number, never a derived one', async () => {
    const t = new MockMetaTransport().script('not_allowed', 'invalid_param', 'undeliverable', 'accept')
    const { sender } = make(t)
    for (let i = 0; i < 4; i++) await sender.send(req(TEXT, { attempt: i + 1 }))
    expect(new Set(t.requests.map((r) => r.to))).toEqual(new Set([sanitized]))
  })
  it('the adapter no longer depends on the legacy variant generator, which stays untouched in the legacy sender', () => {
    const adapter = readFileSync(join(process.cwd(), 'src/lib/flows/versioned-meta-sender.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(adapter).not.toMatch(/phoneVariants/)
    const legacy = readFileSync(join(process.cwd(), 'src/lib/flows/meta-send.ts'), 'utf8')
    expect(legacy).toMatch(/phoneVariants\(/)
    expect(legacy).toMatch(/isRecipientNotAllowedError/)
  })
})

describe('secrets and content never leave through logs or outcomes', () => {
  it('events carry no token, no message text and only a masked recipient', async () => {
    const t = new MockMetaTransport().script('accept_then_timeout'); const { sender, events } = make(t)
    const out = await sender.send(req(TEXT))
    const dump = JSON.stringify({ events, out })
    expect(dump).not.toContain(TOKEN)
    expect(dump).not.toContain('Hola Ana')
    expect(dump).not.toContain('3706394')
    expect(events).toHaveLength(2)
    expect(events.every((e) => /^\*\*\*\d{4}$/.test(e.recipient))).toBe(true)
  })
  it('a throwing logger cannot change the outcome', async () => {
    const t = new MockMetaTransport()
    const s = createMetaEffectSender({ transport: t, resolveContext: async () => ctx(), onEvent: () => { throw new Error('logger bug') } })
    expect((await s.send(req(TEXT))).kind).toBe('accepted')
  })
  it('the callback data is sent only when enabled', async () => {
    const t = new MockMetaTransport(); await make(t, { callbackData: 'attempt' }).sender.send(req(TEXT))
    expect(t.requests[0].body.biz_opaque_callback_data).toBe('11111111-1111-4111-8111-111111111111')
  })
})

describe('the adapter itself has no network, environment or credential code', () => {
  it('only imports the pure phone helpers and the messaging contracts', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/flows/versioned-meta-sender.ts'), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|node:https?|node:net|axios|process\.env|SUPABASE|decrypt|encryption/i)
    const imports = [...code.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort()
    expect(imports).toEqual(['../whatsapp/phone-utils', './versioned-messaging'])
    expect(code).not.toMatch(/phoneVariants/)
  })
})

describe('the adapter is not wired to anything', () => {
  it('no module outside tests and test-support imports it (no dispatcher, route, cron or interpreter)', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) { walk(p); continue }
        if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name) || p.includes('/test-support/') || name === 'versioned-meta-sender.ts') continue
        if (/versioned-meta-sender['"]/.test(readFileSync(p, 'utf8'))) offenders.push(p)
      }
    }
    walk(join(process.cwd(), 'src'))
    expect(offenders).toEqual([])
  })
})
