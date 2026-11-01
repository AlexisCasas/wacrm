import { describe, expect, it, vi } from 'vitest'
import { readInkaclickConfig, runOrderOutbox } from './outbox'
import type { OrderRow } from './payload'

const ID = '7d3c1c1e-0f5b-4a3b-8f58-111111111111'
const cfg = { url: 'https://receiver.example.invalid/orders', token: 'secret-token-value' }
const row = (attempts = 1): OrderRow & { attempts: number } => ({
  id: '0b8e9f4e-5a52-4d0e-9d6e-3c7c4f0a1111', confirmed_at: '2026-11-01T03:05:09.000Z', customer_name: 'Cliente Sintetico', dni: null, phone: '51900000001',
  product: 'Nivel laser', quantity: 1, price: '99.90', order_description: null, agency: 'Shalom', destination: 'Arequipa', seller_name: 'Vendedor Uno',
  order_status: 'Pedido confirmado', department: null, attempts,
})
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function fakeAdmin(due: unknown[], finishStatus: string, sent: unknown[] = []) {
  const rpc = vi.fn(async (name: string) => {
    if (name === 'claim_order_deliveries') return { data: due, error: null }
    if (name === 'finish_order_delivery') return { data: finishStatus, error: null }
    return { data: true, error: null }
  })
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'lt', 'limit']) chain[m] = () => chain
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: sent, error: null })
  return { admin: { rpc, from: vi.fn(() => chain) } as never, rpc }
}

describe('readInkaclickConfig (global switch)', () => {
  it('is off unless explicitly enabled and fully configured', () => {
    expect(readInkaclickConfig({ INKACLICK_ORDERS_URL: 'https://x', INKACLICK_ORDERS_TOKEN: 't' } as never)).toBeNull()
    expect(readInkaclickConfig({ INKACLICK_ORDERS_ENABLED: 'true', INKACLICK_ORDERS_URL: 'https://x' } as never)).toBeNull()
    expect(readInkaclickConfig({ INKACLICK_ORDERS_ENABLED: 'true', INKACLICK_ORDERS_URL: 'https://x', INKACLICK_ORDERS_TOKEN: 't' } as never)).toEqual({ url: 'https://x', token: 't' })
  })
})

describe('runOrderOutbox', () => {
  it('does nothing, and leases nothing, when the integration is off', async () => {
    const { admin, rpc } = fakeAdmin([row()], 'sent')
    expect(await runOrderOutbox(admin, null)).toMatchObject({ claimed: 0, sent: 0 })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('reports a successful delivery with the receiver id', async () => {
    const { admin, rpc } = fakeAdmin([row()], 'sent')
    const r = await runOrderOutbox(admin, cfg, { fetchImpl: vi.fn().mockResolvedValue(json(201, { id: ID })) })
    expect(r).toMatchObject({ claimed: 1, sent: 1 })
    expect(rpc).toHaveBeenCalledWith('finish_order_delivery', expect.objectContaining({ p_outcome: 'sent', p_attempt: 1, p_inkaclick_id: ID, p_retry_at: null }))
  })

  it('a timeout is rescheduled with backoff (attempt 3 waits ~2 min), not failed', async () => {
    const { admin, rpc } = fakeAdmin([row(3)], 'pending')
    const now = Date.parse('2026-11-01T00:00:00.000Z')
    const r = await runOrderOutbox(admin, cfg, { fetchImpl: vi.fn().mockRejectedValue(new TypeError('fetch failed')), now: () => now, random: () => 0.5 })
    expect(r).toMatchObject({ retried: 1, sent: 0 })
    expect(rpc).toHaveBeenCalledWith('finish_order_delivery', expect.objectContaining({ p_outcome: 'retry', p_error_code: 'network_error', p_retry_at: new Date(now + 120_000).toISOString() }))
  })

  it('4xx is rejected (failed), 5xx retried, exhausted attempts are dead', async () => {
    expect(await runOrderOutbox(fakeAdmin([row()], 'failed').admin, cfg, { fetchImpl: vi.fn().mockResolvedValue(json(422, { code: 'invalid_phone' })) })).toMatchObject({ rejected: 1 })
    expect(await runOrderOutbox(fakeAdmin([row()], 'pending').admin, cfg, { fetchImpl: vi.fn().mockResolvedValue(json(503, {})) })).toMatchObject({ retried: 1 })
    expect(await runOrderOutbox(fakeAdmin([row(8)], 'dead').admin, cfg, { fetchImpl: vi.fn().mockResolvedValue(json(503, {})) })).toMatchObject({ dead: 1 })
  })

  it('never sends the secret anywhere but the receiver, and passes sanitised errors only', async () => {
    const { admin, rpc } = fakeAdmin([row()], 'failed')
    await runOrderOutbox(admin, cfg, { fetchImpl: vi.fn().mockResolvedValue(json(422, { code: 'Cliente Sintetico', message: '51900000001' })) })
    const text = JSON.stringify(rpc.mock.calls)
    for (const s of [cfg.token, 'Cliente Sintetico', '51900000001']) expect(text).not.toContain(s)
  })

  it('acknowledges only what the receiver confirms by external id', async () => {
    const sent = [{ id: 'o-1', inkaclick_order_id: ID }, { id: 'o-2', inkaclick_order_id: ID }]
    const { admin, rpc } = fakeAdmin([], 'sent', sent)
    const fetchImpl = vi.fn().mockImplementation(async (u: string) => (u.includes('o-1') ? json(200, { id: ID }) : json(404, {})))
    const r = await runOrderOutbox(admin, cfg, { fetchImpl })
    expect(r.reconciled).toBe(1)
    expect(rpc).toHaveBeenCalledWith('acknowledge_order_delivery', { p_order: 'o-1', p_inkaclick_id: ID })
    expect(rpc).not.toHaveBeenCalledWith('acknowledge_order_delivery', expect.objectContaining({ p_order: 'o-2' }))
  })

  it('delivers on one run and reconciles sent -> acknowledged on a LATER run (only once the order has been sent for a minute)', async () => {
    const NOW = Date.parse('2026-11-01T15:00:00.000Z')
    const lt = vi.fn()
    const sentRows = { current: [] as unknown[] }
    const rpc = vi.fn(async (name: string) => {
      if (name === 'claim_order_deliveries') return { data: sentRows.current.length ? [] : [row(1)], error: null }
      if (name === 'finish_order_delivery') return { data: 'sent', error: null }
      return { data: true, error: null }
    })
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'limit']) chain[m] = () => chain
    chain.lt = (...a: unknown[]) => { lt(...a); return chain }
    chain.then = (resolve: (v: unknown) => void) => resolve({ data: sentRows.current, error: null })
    const admin = { rpc, from: vi.fn(() => chain) } as never
    const fetchImpl = vi.fn().mockImplementation(async (_u: string, init?: RequestInit) => (init?.method === 'POST' ? json(201, { id: ID }) : json(200, { id: ID })))

    // Run 1: the order is delivered; nothing has been sent for a minute yet, so nothing is reconciled and no GET is made.
    const first = await runOrderOutbox(admin, cfg, { fetchImpl, now: () => NOW })
    expect(first).toMatchObject({ claimed: 1, sent: 1, reconciled: 0 })
    expect(lt).toHaveBeenCalledWith('sent_at', new Date(NOW - 60_000).toISOString())
    expect(rpc).not.toHaveBeenCalledWith('acknowledge_order_delivery', expect.anything())

    // Run 2, a minute later: the database now lists it as sent for more than 60 s; the receiver confirms it by external id.
    sentRows.current = [{ id: row().id, inkaclick_order_id: ID }]
    const second = await runOrderOutbox(admin, cfg, { fetchImpl, now: () => NOW + 61_000 })
    expect(second).toMatchObject({ claimed: 0, sent: 0, reconciled: 1 })
    expect(rpc).toHaveBeenCalledWith('acknowledge_order_delivery', { p_order: row().id, p_inkaclick_id: ID })
    // The reconciliation is a GET by external id; it never posts the order again.
    expect(fetchImpl.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toHaveLength(1)
  })

  it('surfaces a claim failure instead of swallowing it', async () => {
    const admin = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } }), from: vi.fn() } as never
    await expect(runOrderOutbox(admin, cfg)).rejects.toThrow('claim_order_deliveries failed')
  })
})
