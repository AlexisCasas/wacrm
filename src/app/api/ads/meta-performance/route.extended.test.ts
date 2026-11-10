import { beforeEach, describe, expect, it, vi } from 'vitest'

const requireRole = vi.fn()
const rpc = vi.fn()
vi.mock('@/lib/auth/account', () => ({ requireRole: (...a: unknown[]) => requireRole(...a), toErrorResponse: () => new Response('{}', { status: 500 }) }))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (t: string) => ({
      select: () => ({
        eq: () => (t === 'meta_ads_settings' ? { maybeSingle: async () => ({ data: { account_timezone: 'America/Bogota', currency: 'PEN' }, error: null }) } : Promise.resolve({ data: [{ job: 'insights', status: 'ok', last_success_at: '2026-11-10T16:00:00Z', covered_from: '2026-08-12', covered_to: '2026-11-10' }], error: null })),
      }),
    }),
  }),
}))
import { GET } from './route'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const C1 = '120256298878110285', AD1 = '120232883780380285'
const perf = (level: string) => [{ id: level === 'campaign' ? C1 : AD1, name: 'N', status: 'ACTIVE', campaign_id: C1, campaign_name: 'C', adset_id: null, adset_name: null, spend: 70, impressions: 7000, clicks: 140 }]
const rangeRow = (level: string) => (level === 'account' ? [{ id: '409949686293101', reach: 6000, frequency: 1.4333, inline_link_clicks: 120, outbound_clicks: 100, actions: { 'onsite_conversion.messaging_conversation_started_7d': 40, lead: 1, onsite_web_lead: 1 } }] : [{ id: level === 'campaign' ? C1 : AD1, reach: 5200, frequency: 1.3462, actions: {} }])
const get = (days = 7) => GET(new Request(`http://x/api/ads/meta-performance?days=${days}`))

beforeEach(() => {
  for (const f of [requireRole, rpc]) f.mockReset()
  requireRole.mockResolvedValue({
    supabase: { rpc, from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }), in: async () => ({ data: [], error: null }) }) }) }) },
    accountId: A, userId: 'u',
  })
  rpc.mockImplementation(async (n: string, a: { p_level: string }) => ({ data: n === 'meta_ads_range_metrics' ? rangeRow(a.p_level) : perf(a.p_level), error: null }))
})

describe('GET /api/ads/meta-performance — extended layer', () => {
  it('adds Meta\'s aggregated reach / frequency / clicks / messaging to the base section for the requested window', async () => {
    const body = await (await get(7)).json()
    expect(body.extended).toMatchObject({ available: true, summary: { reach: 6000, frequency: 1.4333, link_clicks: 120, outbound_clicks: 100 } })
    expect(body.extended.summary.messaging.conversations_started).toBe(40)
    expect(body.ads[0].ext.reach).toBe(5200)
    expect(rpc).toHaveBeenCalledWith('meta_ads_range_metrics', expect.objectContaining({ p_account: A, p_days: 7, p_since: body.period.since, p_until: body.period.until, p_level: 'account' }))
    // base figures are the same as without the extension
    expect(body.totals).toMatchObject({ spend: 70, impressions: 7000, clicks: 140, ctr: 2 })
    // lead aliases are NOT combined
    expect(body.extended.summary.other_results.filter((o: { lead_alias: boolean }) => o.lead_alias).map((o: { value: number }) => o.value)).toEqual([1, 1])
  })
  it('works for 7, 30 and 90 (each asks the cache for its own window)', async () => {
    const seen = new Set<string>()
    for (const d of [7, 30, 90]) {
      const body = await (await get(d)).json()
      expect(body.extended.available).toBe(true)
      seen.add(`${body.period.since}..${body.period.until}`)
    }
    expect(seen.size).toBe(3)
  })
  it('FALLBACK TO CHECKPOINT: extended RPC missing / failing / throwing / empty => 200 with the base section and extended = null', async () => {
    const base = async () => { const r = await get(); expect(r.status).toBe(200); return r.json() }
    rpc.mockImplementation(async (n: string, a: { p_level: string }) => (n === 'meta_ads_range_metrics' ? { data: null, error: { message: 'function does not exist' } } : { data: perf(a.p_level), error: null }))
    let body = await base()
    expect(body).toMatchObject({ available: true, extended: null, totals: { spend: 70 } })
    expect(body.ads[0].ext).toBeUndefined()
    rpc.mockImplementation(async (n: string, a: { p_level: string }) => { if (n === 'meta_ads_range_metrics') throw new Error('boom'); return { data: perf(a.p_level), error: null } })
    body = await base()
    expect(body.extended).toBeNull()
    rpc.mockImplementation(async (n: string, a: { p_level: string }) => ({ data: n === 'meta_ads_range_metrics' ? [] : perf(a.p_level), error: null }))
    body = await base()
    expect(body.extended).toBeNull()
    expect(JSON.stringify(body)).not.toMatch(/reach/i)
  })
  it('Meta completely down (stored data only): the base section keeps serving the last valid data', async () => {
    rpc.mockImplementation(async (n: string, a: { p_level: string }) => (n === 'meta_ads_range_metrics' ? { data: [], error: null } : { data: perf(a.p_level), error: null }))
    const body = await (await get()).json()
    expect(body.available).toBe(true)
    expect(body.ads).toHaveLength(1)
  })
  it('never exposes a token', async () => {
    expect(JSON.stringify(await (await get()).json())).not.toMatch(/token|access_token|Bearer/i)
  })
})
