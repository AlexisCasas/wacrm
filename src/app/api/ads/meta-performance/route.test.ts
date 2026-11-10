import { beforeEach, describe, expect, it, vi } from 'vitest'

const requireRole = vi.fn()
const rpc = vi.fn()
const settings = vi.fn()
const states = vi.fn()
const recon = vi.fn()

vi.mock('@/lib/auth/account', () => ({
  requireRole: (...a: unknown[]) => requireRole(...a),
  toErrorResponse: (e: Error) => new Response(JSON.stringify({ error: e.message }), { status: e.message === 'forbidden' ? 403 : 401 }),
}))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (t: string) => ({
      select: () => ({ eq: (_c: string, v: string) => (t === 'meta_ads_settings' ? { maybeSingle: () => settings(v) } : states(t, v)) }),
    }),
  }),
}))
import { GET } from './route'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const get = (qs = '?days=7') => GET(new Request(`http://x/api/ads/meta-performance${qs}`))
const C1 = '120256298878110285', S1 = '120256298878120285', AD1 = '120232883780380285', AD2 = '120239084979500285'
const perf = (level: string) => {
  const ads = [
    { id: AD1, name: '288V', status: 'ACTIVE', campaign_id: C1, campaign_name: 'Campaña', adset_id: S1, adset_name: 'Conjunto', spend: '102.50', impressions: 19819, clicks: 392 },
    { id: AD2, name: 'Pulverizador', status: 'PAUSED', campaign_id: C1, campaign_name: 'Campaña', adset_id: S1, adset_name: 'Conjunto', spend: 102.65, impressions: 20157, clicks: 511 },
  ]
  if (level === 'ad') return ads
  return [{ id: level === 'campaign' ? C1 : S1, name: level === 'campaign' ? 'Campaña' : 'Conjunto', status: 'ACTIVE', campaign_id: C1, campaign_name: 'Campaña', adset_id: level === 'campaign' ? null : S1, adset_name: null, spend: 205.15, impressions: 39976, clicks: 903 }]
}

beforeEach(() => {
  for (const f of [requireRole, rpc, settings, states, recon]) f.mockReset()
  recon.mockResolvedValue({ data: { ok: true, checked_at: '2026-11-10T16:00:00Z', date_from: '2026-11-03', date_to: '2026-11-09' }, error: null })
  requireRole.mockResolvedValue({
    supabase: { rpc, from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => recon() }) }) }) }) },
    accountId: A, userId: 'u',
  })
  settings.mockResolvedValue({ data: { account_timezone: 'America/Bogota', currency: 'PEN' }, error: null })
  states.mockResolvedValue({ data: [{ job: 'catalog', status: 'ok' }, { job: 'insights', status: 'ok', last_success_at: '2026-11-10T16:00:00Z', covered_from: '2026-08-12', covered_to: '2026-11-10' }], error: null })
  rpc.mockImplementation(async (_n: string, a: { p_level: string }) => ({ data: perf(a.p_level), error: null }))
})

describe('GET /api/ads/meta-performance', () => {
  it('returns campaigns, ad sets and ads from the cache for the SESSION account over the Meta window, with ratios computed from totals', async () => {
    const body = await (await get('?days=7')).json()
    expect(body.available).toBe(true)
    expect(body.period.days).toBe(7)
    expect(body.period.since < body.period.until).toBe(true)
    expect(rpc).toHaveBeenCalledTimes(3)
    expect(rpc).toHaveBeenCalledWith('meta_ads_performance', expect.objectContaining({ p_account: A, p_level: 'campaign', p_from: body.period.since, p_to: body.period.until }))
    expect(body.campaigns).toHaveLength(1)
    expect(body.adsets).toHaveLength(1)
    expect(body.ads.map((a: { id: string }) => a.id)).toEqual([AD2, AD1]) // by spend desc, keyed by id
    expect(body.totals).toMatchObject({ spend: 205.15, impressions: 39976, clicks: 903 })
    expect(body.totals.ctr).toBe(2.2589)
    expect(body.synced_at).toBe('2026-11-10T16:00:00Z')
    expect(body.sync).toMatchObject({ state: 'ok', partial: false })
    expect(body.reconciliation.ok).toBe(true)
    expect(JSON.stringify(body)).not.toMatch(/reach|token/i)
  })
  it('7, 30 and 90 are accepted; anything else is 400 and nothing is queried', async () => {
    for (const d of [7, 30, 90]) expect((await get(`?days=${d}`)).status).toBe(200)
    rpc.mockClear()
    for (const q of ['?days=14', '?days=abc', '?days=0']) expect((await get(q)).status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })
  it('periods differ per filter (longer = earlier since)', async () => {
    const since = async (d: number) => (await (await get(`?days=${d}`)).json()).period.since as string
    const [a, b, c] = [await since(7), await since(30), await since(90)]
    expect(a > b && b > c).toBe(true)
  })
  it('partial coverage (backfill in progress) is reported, not hidden', async () => {
    states.mockResolvedValue({ data: [{ job: 'insights', status: 'ok', last_success_at: '2026-11-10T16:00:00Z', covered_from: '2026-11-04', covered_to: '2026-11-10' }], error: null })
    const body = await (await get('?days=30')).json()
    expect(body.sync).toMatchObject({ state: 'syncing', partial: true, covered_from: '2026-11-04' })
  })
  it('a failing last sync still serves the stored data, flagged as error', async () => {
    states.mockResolvedValue({ data: [{ job: 'insights', status: 'error', last_success_at: '2026-11-09T16:00:00Z', covered_from: '2026-08-12', covered_to: '2026-11-10' }], error: null })
    const body = await (await get()).json()
    expect(body).toMatchObject({ available: true, sync: { state: 'error' } })
    expect(body.ads).toHaveLength(2)
  })
  it('FALLBACK: not configured / never synced / RPC error / unexpected failure => 200 { available:false }, never an error', async () => {
    settings.mockResolvedValueOnce({ data: null, error: null })
    expect(await (await get()).json()).toEqual({ available: false, reason: 'not_configured' })
    states.mockResolvedValueOnce({ data: [{ job: 'insights', status: 'idle', last_success_at: null }], error: null })
    expect(await (await get()).json()).toEqual({ available: false, reason: 'not_synced' })
    states.mockResolvedValueOnce({ data: [], error: null })
    expect(await (await get()).json()).toEqual({ available: false, reason: 'not_synced' })
    rpc.mockImplementationOnce(async () => ({ data: null, error: { message: 'function does not exist' } }))
    expect(await (await get()).json()).toEqual({ available: false, reason: 'unavailable' })
    settings.mockRejectedValueOnce(new Error('db down'))
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ available: false, reason: 'unavailable' })
  })
  it('no permission (viewer) => 403 and nothing is queried; unauthenticated => 401', async () => {
    requireRole.mockRejectedValueOnce(new Error('forbidden'))
    expect((await get()).status).toBe(403)
    requireRole.mockRejectedValueOnce(new Error('unauthorized'))
    expect((await get()).status).toBe(401)
    expect(rpc).not.toHaveBeenCalled()
    expect(requireRole).toHaveBeenCalledWith('agent')
  })
  it('a reconciliation lookup that fails does not break the section', async () => {
    recon.mockRejectedValueOnce(new Error('x'))
    const body = await (await get()).json()
    expect(body.available).toBe(true)
    expect(body.reconciliation).toBeNull()
  })
})
