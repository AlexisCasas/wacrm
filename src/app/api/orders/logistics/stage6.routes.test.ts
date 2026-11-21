import { beforeEach, describe, expect, it, vi } from 'vitest'

const getCurrentAccount = vi.fn()
const resolveAccess = vi.fn()
const startPackaging = vi.fn()
const sendPackagingTemplate = vi.fn()
const resolveDispatch = vi.fn()

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: () => getCurrentAccount(),
  toErrorResponse: (e: Error) => new Response(JSON.stringify({ error: e.message }), { status: e.message === 'Unauthorized' ? 401 : 500 }),
}))
vi.mock('@/lib/orders/confirmed-orders', () => ({ resolveConfirmedOrdersAccess: (c: unknown) => resolveAccess(c) }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ admin: true }) }))
vi.mock('@/lib/orders/logistics/packaging', () => ({
  startPackaging: (...a: unknown[]) => startPackaging(...a),
  sendPackagingTemplate: (...a: unknown[]) => sendPackagingTemplate(...a),
  resolveDispatch: (...a: unknown[]) => resolveDispatch(...a),
}))

import { POST } from './orders/[orderId]/packaging/route'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const OTHER = '55555555-5555-4555-8555-555555555555'
const ORDER = '22222222-2222-4222-8222-222222222222'
const DISPATCH = '88888888-8888-4888-8888-888888888888'
const ctx = (role = 'agent') => ({ supabase: {}, userId: 'user-1', accountId: ACCOUNT, role })
const params = { params: Promise.resolve({ orderId: ORDER }) }
const post = (body: unknown) => POST(new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), params)

beforeEach(() => {
  getCurrentAccount.mockResolvedValue(ctx())
  resolveAccess.mockResolvedValue({ kind: 'ok', operationalRole: 'logistics' })
  startPackaging.mockResolvedValue({ ok: true, status: 200, body: { status: 'packing', changed: true } })
  sendPackagingTemplate.mockResolvedValue({ ok: true, status: 200, body: { status: 'sent', order_status: 'ready_for_dispatch', dispatch_id: DISPATCH } })
  resolveDispatch.mockResolvedValue({ ok: true, status: 200, body: { status: 'sent', order_status: 'ready_for_dispatch', changed: true } })
})

const actions = [{ action: 'start' }, { action: 'send_template', request_key: 'k' }, { action: 'resolve', dispatch_id: DISPATCH, resolution: 'confirmed_sent' }]
const services = () => [startPackaging, sendPackagingTemplate, resolveDispatch]

describe.each(actions)('packaging action %j · authority', (body) => {
  it('no session -> 401; flag OFF -> 403; commercial / no area / viewer -> 403 (a shared chat grants nothing)', async () => {
    getCurrentAccount.mockRejectedValueOnce(new Error('Unauthorized'))
    expect((await post(body)).status).toBe(401)
    resolveAccess.mockResolvedValueOnce({ kind: 'disabled' })
    const off = await post(body)
    expect(off.status).toBe(403)
    expect(await off.json()).toEqual({ error: 'feature_disabled' })
    resolveAccess.mockResolvedValueOnce({ kind: 'forbidden' })
    expect((await post(body)).status).toBe(403)
    getCurrentAccount.mockResolvedValueOnce(ctx('viewer'))
    expect((await post(body)).status).toBe(403)
    for (const s of services()) expect(s).not.toHaveBeenCalled()
  })
})

describe('wiring', () => {
  it('start: session account / actor and the order from the URL', async () => {
    await post({ action: 'start', account_id: OTHER })
    const [callCtx, , orderId] = startPackaging.mock.calls[0]
    expect(callCtx).toMatchObject({ accountId: ACCOUNT, userId: 'user-1' })
    expect(orderId).toBe(ORDER)
    expect(JSON.stringify(startPackaging.mock.calls[0])).not.toContain(OTHER)
  })

  it('send_template: only the request_key is read from the body (no template, language, params, conversation or account from the browser)', async () => {
    await post({ action: 'send_template', request_key: 'k-9', template_name: 'evil', template_language: 'xx', params: ['x'], conversation_id: OTHER, account_id: OTHER, header_url: 'http://evil' })
    const [callCtx, , orderId, key] = sendPackagingTemplate.mock.calls[0]
    expect(callCtx).toMatchObject({ accountId: ACCOUNT, userId: 'user-1' })
    expect([orderId, key]).toEqual([ORDER, 'k-9'])
    expect(sendPackagingTemplate.mock.calls[0]).toHaveLength(4)
    expect(JSON.stringify(sendPackagingTemplate.mock.calls[0])).not.toMatch(/evil|xx|http/)
  })

  it('resolve: dispatch id and resolution only', async () => {
    await post({ action: 'resolve', dispatch_id: DISPATCH, resolution: 'confirmed_not_sent', account_id: OTHER })
    expect(resolveDispatch.mock.calls[0][3]).toEqual({ dispatchId: DISPATCH, resolution: 'confirmed_not_sent' })
    expect(JSON.stringify(resolveDispatch.mock.calls[0])).not.toContain(OTHER)
  })

  it('unknown action / non-object body -> 400', async () => {
    expect((await post({ action: 'delete' })).status).toBe(400)
    expect((await POST(new Request('http://x', { method: 'POST', body: 'nope' }), params)).status).toBe(400)
    for (const s of services()) expect(s).not.toHaveBeenCalled()
  })

  it('refusals keep status, code and the dispatch reference', async () => {
    sendPackagingTemplate.mockResolvedValue({ ok: false, status: 409, error: 'send_uncertain', extra: { dispatch_id: DISPATCH, status: 'uncertain', order_status: 'packing' } })
    const res = await post({ action: 'send_template', request_key: 'k' })
    expect([res.status, await res.json()]).toEqual([409, { error: 'send_uncertain', dispatch_id: DISPATCH, status: 'uncertain', order_status: 'packing' }])
  })
})
