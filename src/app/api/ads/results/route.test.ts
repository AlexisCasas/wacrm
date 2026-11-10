import { beforeEach, describe, expect, it, vi } from 'vitest'

const requireRole = vi.fn()
const rpc = vi.fn()
const capi = vi.fn()
const writes = vi.fn()

vi.mock('@/lib/auth/account', () => ({
  requireRole: (...a: unknown[]) => requireRole(...a),
  toErrorResponse: (e: Error) => new Response(JSON.stringify({ error: e.message }), { status: e.message === 'forbidden' ? 403 : e.message === 'unauthorized' ? 401 : 500 }),
}))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (t: string) => ({
      select: () => ({ eq: (_c: string, v: string) => ({ maybeSingle: () => capi(t, v) }) }),
      insert: writes, update: writes, upsert: writes, delete: writes,
    }),
    rpc: writes,
  }),
}))
import { GET } from './route'

const get = (qs = '') => GET(new Request(`http://x/api/ads/results${qs}`))
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
beforeEach(() => {
  for (const f of [requireRole, rpc, capi, writes]) f.mockReset()
  requireRole.mockResolvedValue({ supabase: { rpc }, accountId: A, userId: 'u' })
  rpc.mockResolvedValue({ data: [], error: null })
  capi.mockResolvedValue({ data: null, error: null })
})

describe('GET /api/ads/results', () => {
  it('no data: empty report, integration shown as disabled, ROAS and verified sales unavailable', async () => {
    const body = await (await get()).json()
    expect(body.ads).toEqual([])
    expect(body.unattributed).toBeNull()
    expect(body.totals).toMatchObject({ contacts: 0, orders: 0, order_amount: 0 })
    expect(body.meta_capi).toEqual({ enabled: false, test_mode: false })
    expect(body.verified_sales.available).toBe(false)
    expect(body.roas.available).toBe(false)
  })
  it('uses the SESSION account for both the report and the settings lookup, never a query parameter', async () => {
    await get('?account_id=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    expect(rpc).toHaveBeenCalledWith('ads_results_report', expect.objectContaining({ p_account: A }))
    expect(capi).toHaveBeenCalledWith('meta_capi_settings', A)
  })
  it('integration enabled in test mode is reported without leaking ids or the test code', async () => {
    capi.mockResolvedValue({ data: { enabled: true, test_event_code: 'TEST123' }, error: null })
    const text = await (await get()).text()
    expect(JSON.parse(text).meta_capi).toEqual({ enabled: true, test_mode: true })
    expect(text).not.toContain('TEST123')
  })
  it('a caller without permission (viewer) gets 403 and nothing is queried', async () => {
    requireRole.mockRejectedValue(new Error('forbidden'))
    expect((await get()).status).toBe(403)
    expect(rpc).not.toHaveBeenCalled()
    expect(capi).not.toHaveBeenCalled()
    expect(requireRole).toHaveBeenCalledWith('agent')
  })
  it('unauthenticated: 401', async () => {
    requireRole.mockRejectedValue(new Error('unauthorized'))
    expect((await get()).status).toBe(401)
  })
  it('rejects an invalid or oversized period', async () => {
    expect((await get('?from=2026-12-01&to=2026-11-01')).status).toBe(400)
    expect((await get('?from=garbage')).status).toBe(400)
    expect((await get('?from=2020-01-01&to=2026-01-01')).status).toBe(400)
  })
  it('a database error (e.g. migration not applied yet) is a generic 500; the sending state is still read-only', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42883', message: 'secret detail' } })
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret')
    expect(writes).not.toHaveBeenCalled()
  })
  it('never writes anything', async () => {
    await get()
    expect(writes).not.toHaveBeenCalled()
  })
  it('sold-products helper is called with the SESSION account only; original report fields unchanged; nothing is written', async () => {
    rpc.mockImplementation(async (name: string) => (name === 'ads_results_report'
      ? { data: [{ source_id: 'AD1', headline: 'H', contacts: 4, buyers: 1, orders: 2, order_amount: 200, units: 3, products: [] }], error: null }
      : { data: [{ product: 'Laser', buyers: 1, orders: 2, units: 3, sales: 200, legacy_orders: 0 }], error: null }))
    const body = await (await get('?account_id=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).json()
    expect(rpc).toHaveBeenCalledWith('ads_results_by_product', expect.objectContaining({ p_account: A }))
    expect(rpc.mock.calls.map((c) => c[0]).sort()).toEqual(['ads_results_by_product', 'ads_results_report'])
    expect(body.ads[0]).toMatchObject({ contacts: 4, buyers: 1, orders: 2, order_amount: 200, conversion_pct: 25 })
    expect(Object.keys(body.ads[0]).sort()).toEqual(['buyers', 'contacts', 'conversion_pct', 'headline', 'order_amount', 'orders', 'products', 'source_id', 'units'])
    expect(body.product_sales).toEqual([expect.objectContaining({ product: 'Laser', avg_ticket: 200 })])
    expect(writes).not.toHaveBeenCalled()
  })
  it('helper missing/failing never breaks the original report', async () => {
    rpc.mockImplementation(async (name: string) => (name === 'ads_results_report'
      ? { data: [{ source_id: 'AD1', contacts: 1, buyers: 0, orders: 0, order_amount: 0, units: 0 }], error: null }
      : { data: null, error: { message: 'function does not exist' } }))
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ads).toHaveLength(1)
    expect(body.product_sales).toBeNull()
  })
  it('no network call of any kind (no Meta)', async () => {
    const f = vi.fn(async () => { throw new Error('NETWORK') })
    vi.stubGlobal('fetch', f)
    await get()
    expect(f).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
