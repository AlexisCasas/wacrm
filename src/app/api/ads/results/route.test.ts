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
})
