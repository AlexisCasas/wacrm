import { beforeEach, describe, expect, it, vi } from 'vitest'

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SELLER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const CONTACT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

const rpc = vi.fn()
const requireRole = vi.fn()
vi.mock('@/lib/auth/account', () => ({ requireRole: (...a: unknown[]) => requireRole(...a), toErrorResponse: (e: Error) => new Response(JSON.stringify({ error: e.message }), { status: e.message === 'forbidden' ? 403 : 500 }) }))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ rpc, from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { delivery_status: 'pending' } }) }) }) }) }) }),
}))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => ({ success: true }), rateLimitResponse: () => new Response('{}', { status: 429 }), RATE_LIMITS: { send: {} } }))

import { POST } from './route'

const valid = { request_key: 'form-1', seller_id: SELLER, contact_id: CONTACT, customer_name: 'Cliente Sintetico', phone: '900000001', product: 'Nivel laser', quantity: 1, price: '99.9', destination: 'Arequipa' }
const post = (body: unknown) => POST(new Request('http://x/api/orders/confirm', { method: 'POST', body: JSON.stringify(body) }))

beforeEach(() => {
  rpc.mockReset()
  requireRole.mockReset()
  requireRole.mockResolvedValue({ supabase: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { full_name: 'Asesor Uno' } }) }) }) }) }) }, accountId: ACCOUNT, userId: USER })
})

describe('POST /api/orders/confirm', () => {
  it('requires the agent role (viewers are refused before anything is written)', async () => {
    requireRole.mockRejectedValue(new Error('forbidden'))
    expect((await post(valid)).status).toBe(403)
    expect(requireRole).toHaveBeenCalledWith('agent')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('creates the order scoped to the SESSION account, ignoring any account_id in the body; seller and confirmer are distinct', async () => {
    rpc.mockResolvedValue({ data: [{ order_id: 'o-1', created: true }], error: null })
    const res = await post({ ...valid, account_id: OTHER })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ order_id: 'o-1', created: true, delivery_status: 'pending' })
    const args = rpc.mock.calls[0][1]
    expect(args).toMatchObject({ p_account: ACCOUNT, p_actor: USER, p_actor_name: 'Asesor Uno', p_seller: SELLER, p_request_key: 'form-1' })
    expect(args.p_account).not.toBe(OTHER)
    expect(args.p_fields).toMatchObject({ phone: '51900000001', price: '99.90', quantity: 1, agency: 'Shalom' })
  })

  it('the same request_key again is 200 with created=false (double click / retry)', async () => {
    rpc.mockResolvedValue({ data: [{ order_id: 'o-1', created: false }], error: null })
    const res = await post(valid)
    expect(res.status).toBe(200)
    expect((await res.json()).created).toBe(false)
  })

  it('validation errors are 422 and nothing is created', async () => {
    const res = await post({ ...valid, price: '0', phone: '123' })
    expect(res.status).toBe(422)
    expect((await res.json()).errors).toMatchObject({ price: 'invalid_price', phone: 'invalid_peru_phone' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('request_key and seller are mandatory', async () => {
    expect((await post({ ...valid, request_key: '' })).status).toBe(400)
    expect((await post({ ...valid, seller_id: 'nope' })).status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('a contact or seller of another account is a 422 that reveals nothing', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'contact does not belong to the account', code: 'P0001' } })
    const res = await post(valid)
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'invalid_reference' })
  })

  it('warns about a malformed DNI but still creates the order', async () => {
    rpc.mockResolvedValue({ data: [{ order_id: 'o-2', created: true }], error: null })
    const res = await post({ ...valid, dni: '12' })
    expect(res.status).toBe(201)
    expect((await res.json()).warnings).toEqual({ dni: 'not_8_digits' })
  })
})
