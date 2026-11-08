import { beforeEach, describe, expect, it, vi } from 'vitest'

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SELLER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const CONTACT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

const rpc = vi.fn()
const requireRole = vi.fn()
const featureRead = vi.fn()
const featureEq = vi.fn()
const catalogRead = vi.fn()
const catalogEq = vi.fn()
vi.mock('@/lib/auth/account', () => ({ requireRole: (...a: unknown[]) => requireRole(...a), toErrorResponse: (e: Error) => new Response(JSON.stringify({ error: e.message }), { status: e.message === 'forbidden' ? 403 : 500 }) }))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc,
    from: (table: string) => table === 'order_integration_settings'
      ? { select: () => ({ eq: (...args: unknown[]) => { featureEq(...args); return { maybeSingle: featureRead } } }) }
      : table === 'audio_guide_products' ? { select: () => {
          const chain = { eq: (...args: unknown[]) => { catalogEq(...args); return chain }, in: () => catalogRead() }
          return chain
        } }
      : { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { delivery_status: 'pending' } }) }) }) }) },
  }),
}))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => ({ success: true }), rateLimitResponse: () => new Response('{}', { status: 429 }), RATE_LIMITS: { send: {} } }))

import { POST } from './route'

const valid = { request_key: 'form-1', seller_user_id: SELLER, contact_id: CONTACT, customer_name: 'Cliente Sintetico', phone: '900000001', product: 'Nivel laser', quantity: 1, price: '99.9', destination: 'Arequipa' }
const post = (body: unknown) => POST(new Request('http://x/api/orders/confirm', { method: 'POST', body: JSON.stringify(body) }))

beforeEach(() => {
  rpc.mockReset()
  requireRole.mockReset()
  featureRead.mockReset()
  featureEq.mockReset()
  catalogRead.mockReset()
  catalogEq.mockReset()
  featureRead.mockResolvedValue({ data: { multiproduct_enabled: false, product_tags_required: false }, error: null })
  catalogRead.mockResolvedValue({ data: [], error: null })
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
    expect((await post({ ...valid, seller_user_id: 'nope' })).status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('a contact or seller of another account is a 422 that reveals nothing', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'contact does not belong to the account', code: 'P0001' } })
    const res = await post(valid)
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'invalid_reference' })
  })

  it('refuses with 403 when the feature is off for the account or the confirmer lacks the role (SQL second layer)', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'feature_disabled', code: '42501' } })
    const off = await post(valid)
    expect(off.status).toBe(403)
    expect(await off.json()).toEqual({ error: 'feature_disabled' })
    rpc.mockResolvedValue({ data: null, error: { message: 'actor_not_allowed', code: '42501' } })
    const role = await post(valid)
    expect(role.status).toBe(403)
    expect(await role.json()).toEqual({ error: 'forbidden' })
  })

  it('a seller who is not a member of the account is a 422 that reveals nothing', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'seller is not a member of the account', code: 'P0001' } })
    const res = await post(valid)
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'invalid_reference' })
  })

  it('the seller may be a different person from the confirmer: both ids travel separately', async () => {
    rpc.mockResolvedValue({ data: [{ order_id: 'o-3', created: true }], error: null })
    await post(valid)
    const args = rpc.mock.calls[0][1]
    expect(args.p_actor).toBe(USER)
    expect(args.p_seller).toBe(SELLER)
    expect(args.p_actor).not.toBe(args.p_seller)
  })

  const multi = [
    { product_name: 'Guitarra', quantity: 1, unit_price: '190' },
    { product_name: 'Violin', quantity: 2, unit_price: '80' },
  ]

  it('blocks structured items for an account without the flag, even if the caller claims a different account', async () => {
    const res = await post({ ...valid, items: multi, account_id: OTHER })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'multiproduct_disabled' })
    expect(featureEq).toHaveBeenCalledWith('account_id', ACCOUNT)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('allows structured items only after the current account flag is enabled, preserving the old payload fields', async () => {
    featureRead.mockResolvedValue({ data: { multiproduct_enabled: true }, error: null })
    rpc.mockResolvedValue({ data: [{ order_id: 'o-multi', created: true }], error: null })
    const res = await post({ ...valid, items: multi })
    expect(res.status).toBe(201)
    expect(rpc.mock.calls[0][1].p_fields).toMatchObject({
      product: '1 x Guitarra\n2 x Violin', quantity: 3, price: '350.00',
      items: [{ product_name: 'Guitarra', quantity: 1, unit_price: '190.00' }, { product_name: 'Violin', quantity: 2, unit_price: '80.00' }],
    })
  })

  it('fails closed if the feature-setting lookup fails and handles a SQL-level race to disabled', async () => {
    featureRead.mockResolvedValue({ data: null, error: { code: '42P01' } })
    expect((await post({ ...valid, items: multi })).status).toBe(500)
    expect(rpc).not.toHaveBeenCalled()
    featureRead.mockResolvedValue({ data: { multiproduct_enabled: true }, error: null })
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'multiproduct_disabled' } })
    const res = await post({ ...valid, items: multi })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'multiproduct_disabled' })
  })

  const PRODUCT_CATALOG_ID = '11111111-1111-4111-8111-111111111111'
  const OTHER_CATALOG_ID = '22222222-2222-4222-8222-222222222222'

  it('rejects free-text single orders when the strict account flag is enabled', async () => {
    featureRead.mockResolvedValue({ data: { multiproduct_enabled: true, product_tags_required: true }, error: null })
    const response = await post({ ...valid, product: 'Cargador Xiomi' })
    expect(response.status).toBe(422)
    expect((await response.json()).errors).toMatchObject({ product: 'invalid_catalog_product' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('snapshots authoritative audio-guide product names for strict single and multiple orders', async () => {
    featureRead.mockResolvedValue({ data: { multiproduct_enabled: true, product_tags_required: true }, error: null })
    catalogRead.mockResolvedValue({ data: [{ id: PRODUCT_CATALOG_ID, display_name: 'Cargador Xiaomi', active: true }, { id: OTHER_CATALOG_ID, display_name: 'Guitarra VOZZEX', active: true }], error: null })
    rpc.mockResolvedValue({ data: [{ order_id: 'o-1', created: true }], error: null })
    const single = await post({ ...valid, product: 'Cargador Xiomi', catalog_product_id: PRODUCT_CATALOG_ID })
    expect(single.status).toBe(201)
    expect(rpc.mock.calls[0][1].p_fields.product).toBe('Cargador Xiaomi')
    expect(catalogEq).toHaveBeenCalledWith('account_id', ACCOUNT)
    expect(catalogEq).toHaveBeenCalledWith('active', true)

    rpc.mockClear()
    const multiSelected = [
      { product_name: 'fake', catalog_product_id: PRODUCT_CATALOG_ID, quantity: 1, unit_price: '95' },
      { product_name: 'not matching', catalog_product_id: OTHER_CATALOG_ID, quantity: 2, unit_price: '150' },
    ]
    const several = await post({ ...valid, items: multiSelected })
    expect(several.status).toBe(201)
    expect(rpc.mock.calls[0][1].p_fields).toMatchObject({
      product: '1 x Cargador Xiaomi\n2 x Guitarra VOZZEX', quantity: 3, price: '395.00',
      items: [{ product_name: 'Cargador Xiaomi', catalog_product_id: PRODUCT_CATALOG_ID },
              { product_name: 'Guitarra VOZZEX', catalog_product_id: OTHER_CATALOG_ID }],
    })
  })

  it('rejects an inactive, absent, or other-account audio-guide product without writing', async () => {
    featureRead.mockResolvedValue({ data: { multiproduct_enabled: true, product_tags_required: true }, error: null })
    catalogRead.mockResolvedValue({ data: [], error: null })
    const res = await post({ ...valid, catalog_product_id: OTHER_CATALOG_ID })
    expect(res.status).toBe(422)
    expect((await res.json()).errors).toMatchObject({ product: 'invalid_catalog_product' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('warns about a malformed DNI but still creates the order', async () => {
    rpc.mockResolvedValue({ data: [{ order_id: 'o-2', created: true }], error: null })
    const res = await post({ ...valid, dni: '12' })
    expect(res.status).toBe(201)
    expect((await res.json()).warnings).toEqual({ dni: 'not_8_digits' })
  })
})
