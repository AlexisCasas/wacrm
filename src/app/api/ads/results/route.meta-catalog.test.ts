import { beforeEach, describe, expect, it, vi } from 'vitest'

const requireRole = vi.fn()
const rpc = vi.fn()
const syncState = vi.fn()

vi.mock('@/lib/auth/account', () => ({
  requireRole: (...a: unknown[]) => requireRole(...a),
  toErrorResponse: (e: Error) => new Response(JSON.stringify({ error: e.message }), { status: 500 }),
}))
// capi settings lookup (1 eq) and meta_ads_sync_state lookup (2 eq) share the same fake admin
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (t: string) => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }), eq: () => ({ maybeSingle: () => syncState(t) }) }),
      }),
    }),
  }),
}))
import { GET } from './route'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ID = '120256299148760285'
const get = () => GET(new Request('http://x/api/ads/results'))
const reportRows = [{ source_id: ID, headline: 'InkaClick', contacts: 4, buyers: 1, orders: 1, order_amount: 99, units: 2, products: [] }]
const catalogRow = { ad_id: ID, name: 'Rectificadora Video', adset_id: '1', adset_name: 'Conjunto A', campaign_id: '2', campaign_name: 'Campaña A', status: 'ACTIVE', effective_status: 'ACTIVE', last_synced_at: '2026-11-10T16:00:00Z' }

beforeEach(() => {
  for (const f of [requireRole, rpc, syncState]) f.mockReset()
  requireRole.mockResolvedValue({ supabase: { rpc }, accountId: A, userId: 'u' })
  rpc.mockImplementation(async (name: string) => (name === 'ads_results_report' ? { data: reportRows, error: null } : { data: [], error: null }))
  syncState.mockResolvedValue({ data: { last_success_at: '2026-11-10T16:00:00Z' }, error: null })
})

// `period` embeds "now", so it is excluded when comparing two responses.
const norm = (body: Record<string, unknown>) => JSON.stringify({ ...body, period: undefined })
const baseline = async () => {
  syncState.mockResolvedValue({ data: null, error: null })
  return norm(await (await get()).json())
}

describe('GET /api/ads/results — Meta catalog enrichment', () => {
  it('adds the real name and keeps the source_id; asks the catalog only for the ads on screen, scoped to the SESSION account', async () => {
    rpc.mockImplementation(async (name: string) => (name === 'ads_results_report' ? { data: reportRows, error: null } : name === 'ads_results_meta_catalog' ? { data: [catalogRow], error: null } : { data: [], error: null }))
    const body = await (await get()).json()
    expect(rpc).toHaveBeenCalledWith('ads_results_meta_catalog', { p_account: A, p_ad_ids: [ID] })
    expect(body.ads[0].source_id).toBe(ID)
    expect(body.ads[0].meta.name).toBe('Rectificadora Video')
    expect(body.meta_catalog).toEqual({ available: true, synced_at: '2026-11-10T16:00:00Z' })
    expect(JSON.stringify(body)).not.toMatch(/token|access_token/i)
  })
  it('synced catalog but the ad is not in it => "not synced" (meta null), source_id kept', async () => {
    const body = await (await get()).json()
    expect(body.ads[0]).toMatchObject({ source_id: ID, meta: null })
  })
  it('FALLBACK: Meta never synced => the response is IDENTICAL to a deployment without the integration', async () => {
    const without = await baseline()
    expect(without).not.toContain('meta_catalog')
    expect(without).not.toContain('"meta"')
  })
  it('FALLBACK: the catalog RPC errors, is missing (migration not applied) or throws => report unchanged, still 200', async () => {
    const expected = await baseline()
    for (const impl of [
      async (n: string) => (n === 'ads_results_report' ? { data: reportRows, error: null } : n === 'ads_results_meta_catalog' ? { data: null, error: { message: 'function does not exist' } } : { data: [], error: null }),
      async (n: string) => { if (n === 'ads_results_meta_catalog') throw new Error('network'); return n === 'ads_results_report' ? { data: reportRows, error: null } : { data: [], error: null } },
    ]) {
      rpc.mockImplementation(impl)
      syncState.mockResolvedValue({ data: { last_success_at: '2026-11-10T16:00:00Z' }, error: null })
      const res = await get()
      expect(res.status).toBe(200)
      expect(norm(await res.json())).toBe(expected)
    }
  })
  it('FALLBACK: the sync-state lookup fails => report unchanged, still 200', async () => {
    const expected = await baseline()
    rpc.mockImplementation(async (name: string) => (name === 'ads_results_report' ? { data: reportRows, error: null } : name === 'ads_results_meta_catalog' ? { data: [catalogRow], error: null } : { data: [], error: null }))
    syncState.mockResolvedValue({ data: null, error: { message: 'relation does not exist' } })
    const res = await get()
    expect(res.status).toBe(200)
    expect(norm(await res.json())).toBe(expected)
  })
  it('nothing on screen => no catalog lookup at all', async () => {
    rpc.mockImplementation(async () => ({ data: [], error: null }))
    await get()
    expect(rpc).not.toHaveBeenCalledWith('ads_results_meta_catalog', expect.anything())
  })
})
