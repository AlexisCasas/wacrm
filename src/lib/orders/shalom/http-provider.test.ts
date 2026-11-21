import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { classifyFailure, classifyResponse } from '@/lib/orders/shalom/classify'
import { readShalomConfig, shalomConfigWarnings, SHALOM_DEFAULTS } from '@/lib/orders/shalom/config'
import { createHttpShalomProvider, MAX_BODY_CHARS, minimizeErrorBody, minimizeSuccessBody, parseRetryAfter, parseShalomBaseUrl } from '@/lib/orders/shalom/http-provider'
import { missingShalomHttpVariables, notConfiguredProvider, resolveShalomProvider } from '@/lib/orders/shalom/providers'
import { ShalomProviderError } from '@/lib/orders/shalom/types'

// SYNTHETIC values only. No network (fetch is injected), no real credential, no real guide. The shapes follow what a read-only audit of the existing
// integration showed; they are NOT a Shalom contract.
const KEY = 'test-api-key-SENTINEL-1'
const EMAIL = 'sentinel-user@example.invalid'
const PASSWORD = 'test-password-SENTINEL-2'
const BASE = 'https://tracking.example.test'

const CUSTOMER = ['CLIENTE-SINTETICO-REMITENTE', 'CLIENTE-SINTETICO-DESTINATARIO', 'CONTENIDO-SINTETICO', 'CARGUERO-SINTETICO', 'COMPROBANTE-SINTETICO']

const stage = (extra: Record<string, unknown> = {}) => ({ carguero: CUSTOMER[3], cargueros: [CUSTOMER[3]], fecha: '2026-01-02T10:00:00Z', completo: true, ...extra })
const orderBlock = (entregado: boolean) => ({
  remitente: CUSTOMER[0], destinatario: CUSTOMER[1], monto: 123.45, contenido: CUSTOMER[2], comprobante: CUSTOMER[4], ose_id: 'OSE-SINTETICO',
  fecha_emision: '2026-01-01', fecha_traslado: '2026-01-02', tiempo_llegada: '2 dias', origen: 'ORIGEN-SINT', destino: 'DESTINO-SINT', numero_orden: '12345678', codigo_orden: 'ABCD', entregado,
})
const answer = (status: Record<string, unknown>, entregado = false) => ({ status: { registrado: { fecha: '2026-01-01T10:00:00Z' }, origen: null, transito: null, destino: null, entregado: null, reparto: null, demora: null, ...status }, order: orderBlock(entregado), detailed: true })

const ORIGIN = answer({ origen: { fecha: '2026-01-02T10:00:00Z' } })
const TRANSIT = answer({ origen: { fecha: '2026-01-02T10:00:00Z' }, transito: stage() })
const DESTINATION = answer({ origen: { fecha: 'x' }, transito: stage(), destino: { fecha: '2026-01-05T15:00:00Z', completo: true } })
const DELIVERED = answer({ origen: { fecha: 'x' }, transito: stage(), destino: { fecha: '2026-01-05T15:00:00Z', completo: true }, entregado: { fecha: '2026-01-06T09:00:00Z' } }, true)

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const text = (status: number, body: string, headers: Record<string, string> = {}) => new Response(body, { status, headers })

function provider(fetchImpl: typeof fetch) {
  return createHttpShalomProvider({ baseUrl: BASE, apiKey: KEY, email: EMAIL, password: PASSWORD, fetchImpl })
}
const fetchReturning = (res: () => Response | Promise<Response>) => vi.fn(async () => res()) as unknown as typeof fetch & ReturnType<typeof vi.fn>

/** provider → classify, exactly like the poller does (a provider that throws is a classified failure). */
async function run(fetchImpl: typeof fetch, signal?: AbortSignal) {
  try {
    return classifyResponse(await provider(fetchImpl).fetchTracking({ numero: '12345678', codigo: 'ABCD', signal }))
  } catch (error) {
    if (error instanceof ShalomProviderError) return classifyFailure(error.code)
    throw error
  }
}

afterEach(() => vi.restoreAllMocks())

describe('request contract (GET {base}/v1/tracking?numero&codigo, read-only)', () => {
  it('sends one GET with the three credential headers and the guide as URLSearchParams, never following redirects', async () => {
    const f = fetchReturning(() => json(200, ORIGIN))
    await provider(f).fetchTracking({ numero: '12345678', codigo: 'AB&C=1', signal: new AbortController().signal })
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/v1/tracking?numero=12345678&codigo=AB%26C%3D1`)
    expect(init.method).toBe('GET')
    expect(init.redirect).toBe('manual')
    expect(init.body).toBeUndefined()
    expect(init.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json', 'X-API-Key': KEY, 'X-Shalom-Email': EMAIL, 'X-Shalom-Password': PASSWORD })
  })

  it('keeps a path prefix of the base URL and drops a trailing slash', async () => {
    const f = fetchReturning(() => json(200, ORIGIN))
    await createHttpShalomProvider({ baseUrl: `${BASE}/api/`, apiKey: KEY, email: EMAIL, password: PASSWORD, fetchImpl: f }).fetchTracking({ numero: '1', codigo: 'A' })
    expect(((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string])[0]).toBe(`${BASE}/api/v1/tracking?numero=1&codigo=A`)
  })

  it('does not follow a redirect: a 3xx is a single request and an unexpected integration error', async () => {
    const f = fetchReturning(() => text(302, '', { location: 'https://elsewhere.example.test/steal' }))
    const out = await run(f)
    expect(f).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ outcome: 'server_error', errorCode: 'http_unexpected', httpStatus: 302 })
  })
})

describe('good answers (the real shape) → normalized status', () => {
  it.each([
    ['origin', ORIGIN, 'at_origin'],
    ['transit', TRANSIT, 'in_transit'],
    ['destination', DESTINATION, 'at_destination'],
    ['delivered (order.entregado=true and a dated status.entregado)', DELIVERED, 'delivered'],
  ])('%s', async (_n, body, expected) => {
    const out = await run(fetchReturning(() => json(200, body)))
    expect(out).toMatchObject({ outcome: 'ok', normalized: expected })
  })

  it('reports the destination date Shalom gives', async () => {
    expect(await run(fetchReturning(() => json(200, DESTINATION)))).toMatchObject({ destinationAt: '2026-01-05T15:00:00.000Z' })
  })

  it('accepts the {data:{status,order}} envelope', async () => {
    expect(await run(fetchReturning(() => json(200, { data: TRANSIT })))).toMatchObject({ outcome: 'ok', normalized: 'in_transit' })
  })

  it('status.entregado as an OBJECT with order.entregado=false (the 45 real cases pending Shalom) is NOT delivered', async () => {
    const atDestination = answer({ destino: { fecha: '2026-01-05T15:00:00Z', completo: true }, entregado: { fecha: '2026-01-06T09:00:00Z' } }, false)
    expect(await run(fetchReturning(() => json(200, atDestination)))).toMatchObject({ outcome: 'ok', normalized: 'at_destination' })
    const onlyEntregadoObject = answer({ entregado: { fecha: '2026-01-06T09:00:00Z' } }, false)
    const out = await run(fetchReturning(() => json(200, onlyEntregadoObject)))
    expect(out.normalized).not.toBe('delivered')
    const orderFlagMissing = { status: { registrado: { fecha: 'x' }, entregado: { fecha: '2026-01-06T09:00:00Z' } }, order: {}, detailed: true }
    expect((await run(fetchReturning(() => json(200, orderFlagMissing)))).normalized).not.toBe('delivered')
  })

  it('an unrecognizable answer is unknown_state: it never advances an order', async () => {
    const out = await run(fetchReturning(() => json(200, { status: { registrado: null, origen: null, transito: null, destino: null, entregado: null, reparto: { fecha: 'x' }, demora: {} }, order: orderBlock(false), detailed: true })))
    expect(out).toMatchObject({ outcome: 'unknown_state', normalized: null })
  })
})

describe('HTTP errors', () => {
  it.each([
    [404, 'not_found'], [400, 'invalid_identifier'], [422, 'invalid_identifier'], [401, 'credentials'], [403, 'credentials'], [408, 'timeout'],
    [500, 'server_error'], [502, 'server_error'], [503, 'server_error'], [504, 'server_error'],
  ])('%i → %s', async (status, outcome) => {
    const out = await run(fetchReturning(() => json(status, { error: { code: `http_${status}`, message: 'free text that may carry anything' } })))
    expect(out).toMatchObject({ outcome, httpStatus: status })
  })

  it('a not_found error code in the body is not_found even when the status is odd', async () => {
    expect(await run(fetchReturning(() => json(404, { error: { code: 'not_found', message: 'No se encontró la orden de servicio.' } })))).toMatchObject({ outcome: 'not_found' })
  })

  it('429 keeps Retry-After in seconds, or as an HTTP date; without it the pause falls back to the configured one', async () => {
    expect(await run(fetchReturning(() => json(429, {}, { 'retry-after': '7' })))).toMatchObject({ outcome: 'rate_limited', retryAfterSeconds: 7 })
    const at = new Date(Date.now() + 30_000).toUTCString()
    const dated = await run(fetchReturning(() => json(429, {}, { 'retry-after': at })))
    expect(dated.outcome).toBe('rate_limited')
    expect(dated.retryAfterSeconds).toBeGreaterThanOrEqual(28)
    expect(dated.retryAfterSeconds).toBeLessThanOrEqual(31)
    expect(await run(fetchReturning(() => json(429, {})))).toMatchObject({ outcome: 'rate_limited', retryAfterSeconds: null })
    expect(await run(fetchReturning(() => json(429, {}, { 'retry-after': 'soon' })))).toMatchObject({ outcome: 'rate_limited', retryAfterSeconds: null })
  })

  it('an HTML error page from a proxy is an integration error, not a crash', async () => {
    expect(await run(fetchReturning(() => text(503, '<html>Service Unavailable</html>')))).toMatchObject({ outcome: 'server_error', httpStatus: 503 })
  })
})

describe('invalid answers (HTTP 2xx but unusable)', () => {
  it.each([
    ['not JSON (HTML)', () => text(200, '<html>login</html>')],
    ['truncated JSON', () => text(200, '{"status":{')],
    ['empty body', () => text(200, '')],
    ['a JSON array', () => json(200, [1, 2])],
    ['JSON null', () => text(200, 'null')],
    ['a JSON string', () => text(200, '"ok"')],
  ])('%s → invalid_json (integration)', async (_n, make) => {
    expect(await run(fetchReturning(make))).toMatchObject({ outcome: 'invalid_json', errorCode: 'invalid_json' })
  })

  it('an oversized body is never parsed', async () => {
    expect(await run(fetchReturning(() => text(200, 'x'.repeat(MAX_BODY_CHARS + 1))))).toMatchObject({ outcome: 'invalid_json' })
    expect(await run(fetchReturning(() => text(200, '{}', { 'content-length': String(MAX_BODY_CHARS + 10) })))).toMatchObject({ outcome: 'invalid_json' })
  })
})

describe('degraded answers (HTTP 200 with degraded_reason)', () => {
  const degraded = (reason: string) => ({ ...answer({}), degraded_reason: reason })

  it('shalom_auth_failed → credentials (the global breaker case)', async () => {
    expect(await run(fetchReturning(() => json(200, degraded('shalom_auth_failed'))))).toMatchObject({ outcome: 'credentials', errorCode: 'credentials' })
  })
  it('shalom_login_unavailable → integration error, NOT the credentials breaker', async () => {
    const out = await run(fetchReturning(() => json(200, degraded('shalom_login_unavailable'))))
    expect(out).toMatchObject({ outcome: 'degraded_integration' })
    expect(out.outcome).not.toBe('credentials')
  })
  it('orden_no_disponible → order-level (degraded_order)', async () => {
    expect(await run(fetchReturning(() => json(200, degraded('orden_no_disponible'))))).toMatchObject({ outcome: 'degraded_order' })
  })
  it('an unknown degraded reason is the integration\'s fault, not the order\'s', async () => {
    expect(await run(fetchReturning(() => json(200, degraded('something_new'))))).toMatchObject({ outcome: 'degraded_integration' })
  })
})

describe('no answer at all: timeout / network / AbortSignal', () => {
  const abortError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })

  it('an AbortError is a timeout', async () => {
    expect(await run(vi.fn(async () => { throw abortError() }) as unknown as typeof fetch)).toMatchObject({ outcome: 'timeout' })
  })

  it('a connection failure is a network error (an integration error), and the thrown error carries ONLY a machine code', async () => {
    const f = vi.fn(async () => { throw new TypeError(`fetch failed: ${BASE}/v1/tracking?numero=12345678 ${KEY}`) }) as unknown as typeof fetch
    const err = await provider(f).fetchTracking({ numero: '12345678', codigo: 'ABCD' }).catch((e) => e)
    expect(err).toBeInstanceOf(ShalomProviderError)
    expect(err.code).toBe('network')
    expect(String(err.message) + String(err.stack)).not.toContain(KEY)
    expect(String(err.message)).not.toContain('tracking.example.test')
    expect(await run(f)).toMatchObject({ outcome: 'server_error', errorCode: 'network_error' })
  })

  it('an already aborted signal is a timeout, and the signal reaches fetch', async () => {
    const controller = new AbortController()
    controller.abort()
    const f = vi.fn(async (_u: string, init?: RequestInit) => { if (init?.signal?.aborted) throw abortError(); return json(200, ORIGIN) }) as unknown as typeof fetch
    expect(await run(f, controller.signal)).toMatchObject({ outcome: 'timeout' })
    expect(((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].signal).toBe(controller.signal)
  })

  it('an abort DURING the request (a hang) ends as a timeout', async () => {
    const controller = new AbortController()
    const f = vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(abortError()), { once: true }))) as unknown as typeof fetch
    const pending = run(f, controller.signal)
    controller.abort()
    expect(await pending).toMatchObject({ outcome: 'timeout' })
  })
})

describe('data minimization: no customer data leaves the provider', () => {
  it('only the fields the classifier reads survive a good answer', () => {
    const out = JSON.stringify(minimizeSuccessBody({ ...DELIVERED, degraded_reason: 'x'.repeat(200) }))
    for (const pii of CUSTOMER) expect(out).not.toContain(pii)
    for (const key of ['remitente', 'destinatario', 'monto', 'contenido', 'comprobante', 'ose_id', 'carguero', 'numero_orden', 'codigo_orden']) expect(out).not.toContain(key)
    expect(out.length).toBeLessThan(600)
  })

  it('the provider answer carries none of it either (success and error)', async () => {
    const ok = JSON.stringify(await provider(fetchReturning(() => json(200, DELIVERED))).fetchTracking({ numero: '1', codigo: 'A' }))
    const bad = JSON.stringify(await provider(fetchReturning(() => json(404, { error: { code: 'not_found', message: CUSTOMER[0] }, remitente: CUSTOMER[0] }))).fetchTracking({ numero: '1', codigo: 'A' }))
    for (const pii of CUSTOMER) { expect(ok).not.toContain(pii); expect(bad).not.toContain(pii) }
    expect(bad).toContain('not_found')
  })

  it('an error body keeps only its machine code', () => {
    expect(minimizeErrorBody({ error: { code: 'rate_limited', message: 'whatever', detail: CUSTOMER[0] }, extra: 1 })).toEqual({ error: { code: 'rate_limited' } })
    expect(minimizeErrorBody({ message: 'x' })).toBeNull()
  })

  it('the stored summary has no customer data either (end to end)', async () => {
    const out = await run(fetchReturning(() => json(200, DESTINATION)))
    const summary = JSON.stringify(out.rawSummary)
    for (const pii of CUSTOMER) expect(summary).not.toContain(pii)
  })
})

describe('credentials never appear anywhere observable', () => {
  it('not in any console output, any classified result, any returned value or any thrown error, over every scenario', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined))
    const scenarios: Array<() => Response | Promise<Response>> = [
      () => json(200, ORIGIN), () => json(200, DELIVERED), () => json(404, { error: { code: 'not_found' } }), () => json(401, {}), () => json(403, {}),
      () => json(429, {}, { 'retry-after': '3' }), () => json(503, {}), () => text(200, '<html>'), () => json(200, { ...answer({}), degraded_reason: 'shalom_auth_failed' }),
      () => { throw new TypeError(`network ${KEY} ${EMAIL} ${PASSWORD}`) },
    ]
    const seen: string[] = []
    for (const make of scenarios) {
      const out = await run(fetchReturning(make))
      seen.push(JSON.stringify(out))
    }
    const thrown = await provider(vi.fn(async () => { throw new TypeError(`network ${KEY} ${EMAIL} ${PASSWORD}`) }) as unknown as typeof fetch).fetchTracking({ numero: '1', codigo: 'A' }).catch((e) => `${e.message}${e.stack}${JSON.stringify(e)}`)
    seen.push(String(thrown))
    const logged = spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' ')))
    for (const blob of [...seen, ...logged]) for (const secret of [KEY, EMAIL, PASSWORD]) expect(blob).not.toContain(secret)
  })
})

describe('provider selection (fail closed)', () => {
  const full = { SHALOM_PROVIDER: 'shalom_http', SHALOM_BASE_URL: BASE, SHALOM_API_KEY: KEY, SHALOM_EMAIL: EMAIL, SHALOM_PASSWORD: PASSWORD }

  it('is selected only with every variable present', () => {
    expect(resolveShalomProvider(full).name).toBe('shalom_http')
    for (const name of ['SHALOM_BASE_URL', 'SHALOM_API_KEY', 'SHALOM_EMAIL', 'SHALOM_PASSWORD'] as const) {
      const env: Record<string, string | undefined> = { ...full }
      delete env[name]
      expect(resolveShalomProvider(env)).toBe(notConfiguredProvider)
      expect(missingShalomHttpVariables(env)).toEqual([name])
      expect(resolveShalomProvider({ ...env, [name]: '   ' })).toBe(notConfiguredProvider)
    }
    expect(missingShalomHttpVariables({})).toEqual(['SHALOM_BASE_URL', 'SHALOM_API_KEY', 'SHALOM_EMAIL', 'SHALOM_PASSWORD'])
  })

  it('needs SHALOM_PROVIDER=shalom_http explicitly: the variables alone select nothing', () => {
    const { SHALOM_PROVIDER: _omit, ...rest } = full
    void _omit
    expect(resolveShalomProvider(rest)).toBe(notConfiguredProvider)
    expect(resolveShalomProvider({ ...full, SHALOM_PROVIDER: 'real' })).toBe(notConfiguredProvider)
  })

  it('missing-variable diagnostics list names, never values', () => {
    expect(JSON.stringify(missingShalomHttpVariables({ ...full, SHALOM_API_KEY: '' }))).not.toMatch(/SENTINEL|example/)
  })

  it('rejects an unusable base URL: not https, credentials or a query inside it, garbage', () => {
    for (const bad of ['http://tracking.example.test', 'ftp://tracking.example.test', 'https://user:pw@tracking.example.test', 'https://tracking.example.test/?k=v', 'not a url', 'https://tracking.example.test/#x']) {
      expect(parseShalomBaseUrl(bad, {})).toBeNull()
      expect(resolveShalomProvider({ ...full, SHALOM_BASE_URL: bad })).toBe(notConfiguredProvider)
    }
  })

  it('plain http is accepted for localhost outside production only', () => {
    expect(parseShalomBaseUrl('http://localhost:4010', { NODE_ENV: 'development' })).not.toBeNull()
    expect(parseShalomBaseUrl('http://127.0.0.1:4010', { NODE_ENV: 'test' })).not.toBeNull()
    expect(parseShalomBaseUrl('http://localhost:4010', { NODE_ENV: 'production' })).toBeNull()
    expect(resolveShalomProvider({ ...full, SHALOM_BASE_URL: 'http://localhost:4010', NODE_ENV: 'production' })).toBe(notConfiguredProvider)
  })

  it('NODE_ENV=production never resolves the fake provider, with or without the real one configured', () => {
    expect(resolveShalomProvider({ SHALOM_PROVIDER: 'fake', NODE_ENV: 'production' })).toBe(notConfiguredProvider)
    expect(resolveShalomProvider({ ...full, SHALOM_PROVIDER: 'fake', NODE_ENV: 'production' })).toBe(notConfiguredProvider)
    expect(resolveShalomProvider({ ...full, NODE_ENV: 'production' }).name).toBe('shalom_http')
  })

  it('resolving the real provider makes no request by itself', () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    resolveShalomProvider(full)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('Retry-After parsing', () => {
  it('seconds, HTTP-date, junk', () => {
    expect(parseRetryAfter('12')).toBe(12)
    expect(parseRetryAfter('0')).toBe(0)
    expect(parseRetryAfter(new Date(1_000_000 + 20_000).toUTCString(), 1_000_000)).toBe(20)
    expect(parseRetryAfter(new Date(1_000_000 - 20_000).toUTCString(), 1_000_000)).toBe(0)
    for (const junk of [null, undefined, '', 'abc', '-5', '1e9', '1234567']) expect(parseRetryAfter(junk as string | null)).toBeNull()
  })
})

describe('configuration for the first real test (values stay provisional; everything adjustable with SHALOM_CONFIG_JSON)', () => {
  it('the defaults warn once the real 120 s timeout is used with the default lease', () => {
    const cfg = readShalomConfig({ SHALOM_CONFIG_JSON: JSON.stringify({ timeoutMs: 120000 }) })
    expect(cfg.timeoutMs).toBe(120000)
    expect(shalomConfigWarnings(cfg).join(' ')).toMatch(/leaseSeconds/)
    expect(shalomConfigWarnings(SHALOM_DEFAULTS)).toEqual([])
  })

  it('the recommended first-test configuration is consistent', () => {
    const cfg = readShalomConfig({ SHALOM_CONFIG_JSON: JSON.stringify({ timeoutMs: 120000, batchSize: 5, leaseSeconds: 1500, tickMinutes: 15 }) })
    expect(cfg).toMatchObject({ timeoutMs: 120000, batchSize: 5, leaseSeconds: 1500 })
    expect(shalomConfigWarnings(cfg)).toEqual([])
  })

  it('a tick whose worst case exceeds the tick interval is flagged', () => {
    const cfg = readShalomConfig({ SHALOM_CONFIG_JSON: JSON.stringify({ timeoutMs: 120000, batchSize: 10, leaseSeconds: 3000, tickMinutes: 15 }) })
    expect(shalomConfigWarnings(cfg).join(' ')).toMatch(/overlap/)
  })
})

describe('secrets stay on the server (source guards)', () => {
  const root = resolve(process.cwd())
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.next') continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)) files.push(full)
    }
  }
  walk(join(root, 'src'))
  const source = (f: string) => readFileSync(f, 'utf8')
  const isTest = (f: string) => /\.test\.(ts|tsx)$/.test(f)
  const rel = (f: string) => relative(root, f).replace(/\\/g, '/')

  it('no SHALOM variable is ever exposed with a NEXT_PUBLIC name, and next.config does not list them', () => {
    for (const f of files.filter((x) => !isTest(x))) expect(source(f), rel(f)).not.toMatch(/NEXT_PUBLIC_SHALOM/)
    expect(readFileSync(join(root, 'next.config.ts'), 'utf8')).not.toMatch(/SHALOM/)
    expect(readFileSync(join(root, 'Dockerfile'), 'utf8')).not.toMatch(/SHALOM/)
  })

  it('the secret variables are read in exactly one place: providers.ts', () => {
    const readers = files.filter((f) => !isTest(f) && /SHALOM_(API_KEY|EMAIL|PASSWORD)/.test(source(f))).map(rel)
    expect(readers).toEqual(['src/lib/orders/shalom/providers.ts'])
  })

  it('no client component imports a Shalom provider module', () => {
    for (const f of files.filter((x) => !isTest(x))) {
      const s = source(f)
      if (/^\s*['"]use client['"]/m.test(s)) expect(s, rel(f)).not.toMatch(/orders\/shalom\/(providers|http-provider)/)
    }
  })

  it('the provider files never log', () => {
    for (const f of ['src/lib/orders/shalom/http-provider.ts', 'src/lib/orders/shalom/providers.ts']) expect(readFileSync(join(root, f), 'utf8'), f).not.toMatch(/console\./)
  })
})
