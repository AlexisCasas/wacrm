import { describe, expect, it } from 'vitest'

import { classifyFailure, classifyResponse, errorKindOf } from '@/lib/orders/shalom/classify'
import { extractDestinationDate, hashRaw, mapShalomStatus, summarizeRaw } from '@/lib/orders/shalom/normalize'
import { FAKE_SCENARIOS, fakeResponse } from '@/lib/orders/shalom/providers'

const wrap = (status: Record<string, unknown>, order: Record<string, unknown> = {}) => ({ status, order })

describe('RAW Shalom → normalized status (mapping taken from the InkaClick evidence; not a Shalom contract)', () => {
  it.each([
    ['registrado only → at_origin', wrap({ registrado: { fecha: '2026-01-01' } }), 'at_origin'],
    ['origen → at_origin', wrap({ registrado: { fecha: 'x' }, origen: { fecha: 'x' } }), 'at_origin'],
    ['transito.completo → in_transit', wrap({ origen: {}, transito: { completo: true } }), 'in_transit'],
    ['transito.completo "true" (string) → in_transit', wrap({ transito: { completo: 'true' } }), 'in_transit'],
    ['transito not completo stays at_origin', wrap({ origen: {}, transito: { completo: false } }), 'at_origin'],
    ['destino.completo → at_destination', wrap({ transito: { completo: true }, destino: { completo: true } }), 'at_destination'],
    ['destino.fecha WITHOUT completo → at_destination', wrap({ destino: { completo: false, fecha: '2026-02-01T10:00:00Z' } }), 'at_destination'],
    ['destino with an empty fecha is not destination', wrap({ origen: {}, destino: { completo: false, fecha: '  ' } }), 'at_origin'],
    ['entregado → delivered', wrap({ destino: { completo: true }, entregado: true }), 'delivered'],
    ['status.entregado "true" → delivered', wrap({ entregado: 'true' }), 'delivered'],
    ['order.entregado → delivered', wrap({ origen: {} }, { entregado: true }), 'delivered'],
    ['delivered beats destination', wrap({ destino: { fecha: 'x' }, entregado: true }), 'delivered'],
    ['{data:{status,order}} envelope', { data: wrap({ transito: { completo: true } }) }, 'in_transit'],
  ])('%s', (_name, raw, expected) => {
    expect(mapShalomStatus(raw)).toBe(expected)
  })

  it.each([
    ['null', null], ['undefined', undefined], ['a string', 'ok'], ['an array', []], ['{}', {}], ['no recognizable flag', wrap({ registrado: null, origen: null, transito: null, destino: null, entregado: false })],
    ['only reparto / demora', wrap({ reparto: { fecha: 'x' }, demora: true })],
  ])('an unknown / unrecognizable answer (%s) maps to null: it must never advance an order', (_name, raw) => {
    expect(mapShalomStatus(raw)).toBeNull()
  })

  it('reparto / demora are stored raw in the summary but never interpreted', () => {
    const raw = wrap({ origen: {}, reparto: { fecha: '2026-01-03' }, demora: true })
    expect(mapShalomStatus(raw)).toBe('at_origin')
    expect(summarizeRaw(raw)).toMatchObject({ origen: true, demora: true, reparto: '[obj]' })
  })

  it('the destination date is the one Shalom reports (ISO), or null', () => {
    expect(extractDestinationDate(wrap({ destino: { completo: true, fecha: '2026-12-01T15:00:00Z' } }))).toBe('2026-12-01T15:00:00.000Z')
    expect(extractDestinationDate(wrap({ destino: { completo: true } }))).toBeNull()
    expect(extractDestinationDate(wrap({ destino: { fecha: 'not a date' } }))).toBeNull()
    expect(extractDestinationDate(null)).toBeNull()
  })

  it('the summary keeps no customer data; the hash is stable for the same technical state and differs when it changes', () => {
    const raw = { status: { origen: {} }, order: { remitente: 'Juan Perez', destinatario: 'Ana', monto: '150', entregado: false } }
    expect(JSON.stringify(summarizeRaw(raw))).not.toMatch(/Juan|Ana|150/)
    expect(hashRaw(raw)).toBe(hashRaw(JSON.parse(JSON.stringify(raw))))
    expect(hashRaw(raw)).not.toBe(hashRaw({ status: { origen: {}, transito: { completo: true } }, order: {} }))
  })
})

describe('classifying a provider answer: pedido vs integración vs credenciales global', () => {
  const res = (httpStatus: number, body: unknown = {}, extra: Record<string, unknown> = {}) => classifyResponse({ httpStatus, body, ...extra })

  it.each([
    [404, 'not_found', 'order'], [422, 'invalid_identifier', 'order'], [400, 'invalid_identifier', 'order'],
    [429, 'rate_limited', 'integration'], [500, 'server_error', 'integration'], [502, 'server_error', 'integration'], [503, 'server_error', 'integration'], [504, 'server_error', 'integration'],
    [401, 'credentials', 'credentials'], [403, 'credentials', 'credentials'], [408, 'timeout', 'integration'], [302, 'server_error', 'integration'],
  ])('HTTP %i → %s (%s)', (status, outcome, kind) => {
    const c = res(status)
    expect(c.outcome).toBe(outcome)
    expect(errorKindOf(c.outcome)).toBe(kind)
    expect(c.normalized).toBeNull()
  })

  it('a body error code "not_found" is a not_found even on a 2xx-looking envelope; 429 keeps Retry-After', () => {
    expect(res(200, { error: { code: 'not_found' } }).outcome).toBe('not_found')
    expect(res(429, {}, { retryAfterSeconds: 7 }).retryAfterSeconds).toBe(7)
  })

  it('a 200 with an invalid / non-object body is invalid_json (integration)', () => {
    expect(classifyResponse({ httpStatus: 200, body: null, invalidJson: true }).outcome).toBe('invalid_json')
    expect(res(200, 'oops').outcome).toBe('invalid_json')
    expect(res(200, [1]).outcome).toBe('invalid_json')
    expect(errorKindOf('invalid_json')).toBe('integration')
  })

  it.each([
    ['shalom_auth_failed', 'credentials', 'credentials'], ['shalom_login_unavailable', 'degraded_integration', 'integration'],
    ['orden_no_disponible', 'degraded_order', 'order'], ['something_new', 'degraded_integration', 'integration'],
  ])('a degraded 200 (%s) is %s, never a state', (reason, outcome, kind) => {
    const c = res(200, { status: { origen: {}, registrado: {} }, degraded_reason: reason })
    expect(c.outcome).toBe(outcome)
    expect(errorKindOf(c.outcome)).toBe(kind)
    expect(c.normalized).toBeNull()
  })

  it('a good answer is ok with the normalized status, the date and a bounded summary; an unrecognizable one is unknown_state (not an error)', () => {
    const good = res(200, wrap({ destino: { completo: true, fecha: '2026-12-01T15:00:00Z' } }))
    expect(good).toMatchObject({ outcome: 'ok', normalized: 'at_destination', destinationAt: '2026-12-01T15:00:00.000Z' })
    expect(good.rawHash).toBeTruthy()
    const unk = res(200, wrap({ reparto: { fecha: 'x' } }))
    expect(unk).toMatchObject({ outcome: 'unknown_state', normalized: null, errorCode: 'unknown_status' })
    expect(errorKindOf('unknown_state')).toBeNull()
    expect(errorKindOf('ok')).toBeNull()
  })

  it('no answer at all: timeout and connection failure are integration errors', () => {
    expect(classifyFailure('timeout')).toMatchObject({ outcome: 'timeout' })
    expect(classifyFailure('network')).toMatchObject({ outcome: 'server_error', errorCode: 'network_error' })
    expect(classifyFailure('not_configured')).toMatchObject({ outcome: 'server_error', errorCode: 'not_configured' })
  })
})

describe('every fake scenario classifies the way the QA tooling promises', () => {
  const expected: Record<string, string> = {
    origin: 'ok', transit: 'ok', destination: 'ok', delivered: 'ok', not_found: 'not_found', invalid: 'invalid_identifier', rate_limited: 'rate_limited',
    credentials_401: 'credentials', credentials_403: 'credentials', server_500: 'server_error', server_502: 'server_error', server_503: 'server_error', server_504: 'server_error',
    invalid_json: 'invalid_json', degraded_auth: 'credentials', degraded_login: 'degraded_integration', degraded_order: 'degraded_order', unknown: 'unknown_state',
  }
  it.each(Object.entries(expected))('%s → %s', async (scenario, outcome) => {
    expect(classifyResponse(await fakeResponse(scenario, '12345678'))).toMatchObject({ outcome })
  })
  it('timeout throws a typed error and hang only ends when aborted; every scenario is covered', async () => {
    expect(() => fakeResponse('timeout', '1')).toThrow(/timeout/)
    const ac = new AbortController()
    const pending = fakeResponse('hang', '1', ac.signal) as Promise<unknown>
    ac.abort()
    await expect(pending).rejects.toThrow(/timeout/)
    expect([...FAKE_SCENARIOS].sort()).toEqual([...Object.keys(expected), 'timeout', 'hang'].sort())
  })
  it('the scenario status sequence origin → transit → destination → delivered maps in order', async () => {
    const seq = await Promise.all(['origin', 'transit', 'destination@2026-12-01T15:00:00Z', 'delivered'].map(async (s) => classifyResponse(await fakeResponse(s, '12345678'))))
    expect(seq.map((c) => c.normalized)).toEqual(['at_origin', 'in_transit', 'at_destination', 'delivered'])
    expect(seq[2].destinationAt).toBe('2026-12-01T15:00:00.000Z')
  })
})
