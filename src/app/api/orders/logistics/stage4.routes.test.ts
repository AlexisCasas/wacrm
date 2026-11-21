import { beforeEach, describe, expect, it, vi } from 'vitest'

const getCurrentAccount = vi.fn()
const resolveAccess = vi.fn()
const processBulkDocument = vi.fn()
const associateDocument = vi.fn()
const searchPendingOrders = vi.fn()

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: () => getCurrentAccount(),
  toErrorResponse: (e: Error) => new Response(JSON.stringify({ error: e.message }), { status: e.message === 'Unauthorized' ? 401 : 500 }),
}))
vi.mock('@/lib/orders/confirmed-orders', () => ({ resolveConfirmedOrdersAccess: (c: unknown) => resolveAccess(c), sanitizeSearch: (s: string | null) => s ?? '', CONFIRMED_ORDER_COLUMNS: 'id' }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ admin: true }) }))
vi.mock('@/lib/orders/logistics/bulk', () => ({
  processBulkDocument: (...a: unknown[]) => processBulkDocument(...a),
  associateDocument: (...a: unknown[]) => associateDocument(...a),
  searchPendingOrders: (...a: unknown[]) => searchPendingOrders(...a),
}))

import { POST as ASSOCIATE } from './documents/[id]/associate/route'
import { POST as PROCESS } from './documents/[id]/process/route'
import { GET as PENDING } from './orders/pending/route'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const OTHER = '55555555-5555-4555-8555-555555555555'
const DOC = '33333333-3333-4333-8333-333333333333'
const ORDER = '22222222-2222-4222-8222-222222222222'
const ctx = (role = 'agent') => ({ supabase: {}, userId: 'user-1', accountId: ACCOUNT, role })
const idParams = { params: Promise.resolve({ id: DOC }) }
const json = (body: unknown) => new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const handlers: Array<[string, () => Promise<Response>]> = [
  ['process', () => PROCESS(new Request('http://x', { method: 'POST' }), idParams)],
  ['associate', () => ASSOCIATE(json({ order_id: ORDER }), idParams)],
  ['pending orders', () => PENDING(new Request('http://x/api/orders/logistics/orders/pending?q=ana'))],
]
const services = () => [processBulkDocument, associateDocument, searchPendingOrders]

beforeEach(() => {
  getCurrentAccount.mockResolvedValue(ctx())
  resolveAccess.mockResolvedValue({ kind: 'ok', operationalRole: 'logistics' })
  processBulkDocument.mockResolvedValue({ ok: true, status: 200, body: { outcome: 'pending', reason: 'ambiguous', candidates: [] } })
  associateDocument.mockResolvedValue({ ok: true, status: 200, body: { changed: true, order_id: ORDER, document: {} } })
  searchPendingOrders.mockResolvedValue({ ok: true, status: 200, body: { orders: [] } })
})

describe.each(handlers)('%s endpoint authority', (_name, call) => {
  it('no session -> 401', async () => {
    getCurrentAccount.mockRejectedValue(new Error('Unauthorized'))
    expect((await call()).status).toBe(401)
    for (const s of services()) expect(s).not.toHaveBeenCalled()
  })

  it('flag OFF -> 403 feature_disabled; commercial / no area / viewer -> 403 (a shared chat grants nothing)', async () => {
    resolveAccess.mockResolvedValue({ kind: 'disabled' })
    const off = await call()
    expect(off.status).toBe(403)
    expect(await off.json()).toEqual({ error: 'feature_disabled' })
    resolveAccess.mockResolvedValue({ kind: 'forbidden' })
    expect((await call()).status).toBe(403)
    resolveAccess.mockResolvedValue({ kind: 'ok', operationalRole: 'logistics' })
    getCurrentAccount.mockResolvedValue(ctx('viewer'))
    expect((await call()).status).toBe(403)
    for (const s of services()) expect(s).not.toHaveBeenCalled()
  })
})

describe('wiring', () => {
  it('process: session account / actor, the document id from the URL, the provider resolved server side (not_configured by default)', async () => {
    await PROCESS(new Request('http://x', { method: 'POST', body: JSON.stringify({ account_id: OTHER }) }), idParams)
    const [callCtx, , deps, id] = processBulkDocument.mock.calls[0]
    expect(callCtx).toMatchObject({ accountId: ACCOUNT, userId: 'user-1' })
    expect(id).toBe(DOC)
    expect(deps.provider.name).toBe('not_configured')
    expect(JSON.stringify(processBulkDocument.mock.calls[0])).not.toContain(OTHER)
  })

  it('associate: only order_id is read from the body; account / actor come from the session', async () => {
    await ASSOCIATE(json({ order_id: ORDER, account_id: OTHER, actor: OTHER, method: 'auto' }), idParams)
    const [callCtx, , id, orderId] = associateDocument.mock.calls[0]
    expect(callCtx).toMatchObject({ accountId: ACCOUNT, userId: 'user-1' })
    expect([id, orderId]).toEqual([DOC, ORDER])
    expect(JSON.stringify(associateDocument.mock.calls[0])).not.toContain(OTHER)
  })

  it('associate: a body that is not an object is a 400', async () => {
    expect((await ASSOCIATE(new Request('http://x', { method: 'POST', body: 'nope' }), idParams)).status).toBe(400)
    expect(associateDocument).not.toHaveBeenCalled()
  })

  it('pending orders: forwards q, never an account', async () => {
    await PENDING(new Request(`http://x/api/orders/logistics/orders/pending?q=ana&account_id=${OTHER}`))
    expect(searchPendingOrders.mock.calls[0][0].accountId).toBe(ACCOUNT)
    expect(searchPendingOrders.mock.calls[0][1]).toBe('ana')
    expect(JSON.stringify(searchPendingOrders.mock.calls[0])).not.toContain(OTHER)
  })

  it('refusals keep their status (404 for another account, 409 for a locked order)', async () => {
    associateDocument.mockResolvedValue({ ok: false, status: 404, error: 'not_found' })
    expect((await ASSOCIATE(json({ order_id: ORDER }), idParams)).status).toBe(404)
    processBulkDocument.mockResolvedValue({ ok: false, status: 409, error: 'in_progress' })
    expect((await PROCESS(new Request('http://x', { method: 'POST' }), idParams)).status).toBe(409)
  })
})
