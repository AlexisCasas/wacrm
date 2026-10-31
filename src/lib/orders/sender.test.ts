import { describe, expect, it, vi } from 'vitest'
import { lookupInkaclickOrder, sendOrderToInkaclick } from './sender'
import type { OrderRow } from './payload'

const order: OrderRow = {
  id: '0b8e9f4e-5a52-4d0e-9d6e-3c7c4f0a1111', confirmed_at: '2026-11-01T03:05:09.000Z', customer_name: 'Cliente Sintetico', dni: '12345678',
  phone: '51900000001', product: 'Nivel laser', quantity: 1, price: '99.90', order_description: 'https://example.invalid/x', agency: 'Shalom',
  destination: 'Arequipa', seller_name: 'Vendedor Uno', order_status: 'Pedido confirmado', department: 'Arequipa',
}
const cfg = { url: 'https://receiver.example.invalid/orders', token: 'secret-token-value' }
const ID = '7d3c1c1e-0f5b-4a3b-8f58-111111111111'
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

describe('sendOrderToInkaclick', () => {
  it('sends server-to-server with a bearer token and the order id as idempotency key', async () => {
    const f = vi.fn().mockResolvedValue(json(201, { id: ID }))
    const out = await sendOrderToInkaclick(order, cfg, f)
    expect(out).toEqual({ kind: 'sent', httpStatus: 201, inkaclickId: ID })
    const [url, init] = f.mock.calls[0]
    expect(url).toBe(cfg.url)
    expect(init.headers.authorization).toBe('Bearer secret-token-value')
    expect(init.headers['idempotency-key']).toBe(order.id)
    expect(JSON.parse(init.body)).toMatchObject({ source: 'wacrm', external_order_id: order.id })
  })

  it('a 200 without the order id is NOT success (retry), HTTP 200 does not prove persistence', async () => {
    const out = await sendOrderToInkaclick(order, cfg, vi.fn().mockResolvedValue(json(200, { ok: true })))
    expect(out).toMatchObject({ kind: 'retry', code: 'bad_receiver_response' })
  })

  it('the same order sent again (409 with the id) is success, not a duplicate', async () => {
    const out = await sendOrderToInkaclick(order, cfg, vi.fn().mockResolvedValue(json(409, { id: ID, code: 'already_exists' })))
    expect(out).toEqual({ kind: 'sent', httpStatus: 409, inkaclickId: ID })
  })

  it('timeout -> retry', async () => {
    const f = vi.fn().mockImplementation((_u, init) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' })))))
    const out = await sendOrderToInkaclick(order, { ...cfg, timeoutMs: 5 }, f)
    expect(out).toMatchObject({ kind: 'retry', httpStatus: null, code: 'timeout' })
  })

  it('network failure -> retry', async () => {
    expect(await sendOrderToInkaclick(order, cfg, vi.fn().mockRejectedValue(new TypeError('fetch failed')))).toMatchObject({ kind: 'retry', code: 'network_error' })
  })

  it.each([500, 502, 503, 429, 408])('%i -> retry', async (status) => {
    expect(await sendOrderToInkaclick(order, cfg, vi.fn().mockResolvedValue(json(status, {})))).toMatchObject({ kind: 'retry', httpStatus: status })
  })

  it('honours Retry-After (seconds, capped at 1 h)', async () => {
    const out = await sendOrderToInkaclick(order, cfg, vi.fn().mockResolvedValue(json(429, {}, { 'retry-after': '120' })))
    expect(out).toMatchObject({ kind: 'retry', retryAfterMs: 120_000 })
    const capped = await sendOrderToInkaclick(order, cfg, vi.fn().mockResolvedValue(json(503, {}, { 'retry-after': '999999' })))
    expect(capped).toMatchObject({ retryAfterMs: 3_600_000 })
  })

  it.each([400, 401, 403, 404, 422])('%i -> rejected (a person must look), never retried', async (status) => {
    expect(await sendOrderToInkaclick(order, cfg, vi.fn().mockResolvedValue(json(status, { code: 'invalid_phone' })))).toMatchObject({ kind: 'rejected', httpStatus: status, code: 'invalid_phone' })
  })

  it('error details never echo the response body, the token or customer data', async () => {
    const body = { code: 'Cliente Sintetico 12345678', message: 'telefono 51900000001 invalido', echo: cfg.token }
    const out = await sendOrderToInkaclick(order, cfg, vi.fn().mockResolvedValue(json(422, body)))
    const text = JSON.stringify(out)
    for (const secret of ['Cliente Sintetico', '12345678', '51900000001', cfg.token]) expect(text).not.toContain(secret)
    expect(out).toMatchObject({ kind: 'rejected', code: 'http_422' })
  })
})

describe('lookupInkaclickOrder', () => {
  it('returns the row id when the receiver holds the external id', async () => {
    const f = vi.fn().mockResolvedValue(json(200, { id: ID }))
    expect(await lookupInkaclickOrder(order.id, cfg, f)).toBe(ID)
    expect(f.mock.calls[0][0]).toContain(`external_order_id=${order.id}`)
  })
  it('returns null on 404, errors or a malformed answer', async () => {
    expect(await lookupInkaclickOrder(order.id, cfg, vi.fn().mockResolvedValue(json(404, {})))).toBeNull()
    expect(await lookupInkaclickOrder(order.id, cfg, vi.fn().mockRejectedValue(new Error('x')))).toBeNull()
    expect(await lookupInkaclickOrder(order.id, cfg, vi.fn().mockResolvedValue(json(200, { id: 'nope' })))).toBeNull()
  })
})
