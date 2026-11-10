import { describe, expect, it, vi } from 'vitest'
import { loadExtended } from './extended'
import { buildPerfRows } from './performance'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const C1 = '120256298878110285', S1 = '120256298878120285', AD1 = '120232883780380285', AD2 = '120239084979500285'
const base = {
  accountId: A, days: 7, since: '2026-11-03', until: '2026-11-09', impressions: 8600,
  campaigns: buildPerfRows([{ id: C1, name: 'C', spend: 70, impressions: 7000, clicks: 140 }]),
  adsets: buildPerfRows([{ id: S1, name: 'S', spend: 70, impressions: 7000, clicks: 140 }]),
  ads: buildPerfRows([{ id: AD1, name: 'A1', spend: 70, impressions: 7000, clicks: 140 }, { id: AD2, name: 'A2', spend: 13.5, impressions: 1600, clicks: 2 }]),
}
const range = (level: string) => ({
  account: [{ id: '409949686293101', reach: 6000, frequency: 1.4333, inline_link_clicks: 120, outbound_clicks: 100, actions: { 'onsite_conversion.messaging_conversation_started_7d': 40, video_view: 900 } }],
  campaign: [{ id: C1, reach: 5200, frequency: 1.3462, actions: {} }], adset: [{ id: S1, reach: 5200, actions: {} }],
  ad: [{ id: AD1, reach: 5200, frequency: 1.3462, inline_link_clicks: 120, outbound_clicks: 100, actions: { 'onsite_conversion.messaging_first_reply': 30 } }],
} as Record<string, unknown[]>)[level]
const mk = (over: { rpc?: (name: string, a: { p_level: string }) => unknown; tables?: Record<string, unknown> } = {}) => {
  const calls: { table: string; ids: string[]; account: string }[] = []
  const supabase = {
    rpc: vi.fn(async (n: string, a: { p_level: string }) => (over.rpc ? over.rpc(n, a) : { data: range(a.p_level), error: null })),
    from: (table: string) => ({ select: () => ({ eq: (_c: string, account: string) => ({ in: async (_k: string, ids: string[]) => { calls.push({ table, ids, account }); return over.tables?.[table] ?? { data: [], error: null } } }) }) }),
  }
  return { supabase: supabase as never, calls, rpc: supabase.rpc }
}

describe('loadExtended', () => {
  it('asks the cache for the 4 levels of EXACTLY the requested window and account; merges reach / frequency / link / outbound / actions by Meta id', async () => {
    const m = mk()
    const r = await loadExtended(m.supabase, base)
    expect(m.rpc).toHaveBeenCalledTimes(4)
    for (const level of ['account', 'campaign', 'adset', 'ad']) expect(m.rpc).toHaveBeenCalledWith('meta_ads_range_metrics', { p_account: A, p_days: 7, p_since: '2026-11-03', p_until: '2026-11-09', p_level: level })
    expect(r!.summary).toMatchObject({ reach: 6000, frequency: 1.4333, link_clicks: 120, outbound_clicks: 100 })
    expect(r!.summary!.messaging.conversations_started).toBe(40)
    expect(r!.ads.find((a) => a.id === AD1)!.ext).toMatchObject({ reach: 5200, link_clicks: 120 })
    expect(r!.ads.find((a) => a.id === AD1)!.ext!.messaging.first_replies).toBe(30)
    expect(r!.ads.find((a) => a.id === AD2)!.ext).toBeNull() // no cached range for this ad: "—", never derived
    // the account reach is its own figure, not the sum of the ads' reach
    expect(r!.summary!.reach).not.toBe(r!.ads.reduce((s, a) => s + (a.ext?.reach ?? 0), 0))
  })
  it('FALLBACK: the RPC failing (missing function / permission), throwing, or nothing cached for this window => null (base section only)', async () => {
    expect(await loadExtended(mk({ rpc: async () => ({ data: null, error: { message: 'function does not exist' } }) }).supabase, base)).toBeNull()
    expect(await loadExtended(mk({ rpc: async (_n, a) => (a.p_level === 'ad' ? { data: null, error: { message: 'x' } } : { data: [], error: null }) }).supabase, base)).toBeNull()
    expect(await loadExtended(mk({ rpc: async () => ({ data: [], error: null }) }).supabase, base)).toBeNull()
    await expect(loadExtended(mk({ rpc: async () => { throw new Error('network') } }).supabase, base)).rejects.toThrow() // the route catches this and serves the base section
  })
  it('catalog details are fetched only for the visible ids of the SESSION account, mapped per level; ads use meta_created_time / meta_updated_time', async () => {
    const m = mk({ tables: {
      meta_ads_campaigns: { data: [{ campaign_id: C1, objective: 'MESSAGES', buying_type: 'AUCTION', daily_budget: 5000, lifetime_budget: null, start_time: '2026-11-01T15:00:00Z', stop_time: null, updated_time: '2026-11-09T20:00:00Z' }], error: null },
      meta_ads_adsets: { data: [{ adset_id: S1, optimization_goal: 'CONVERSATIONS', billing_event: 'IMPRESSIONS', bid_strategy: null, daily_budget: null, lifetime_budget: null, start_time: null, end_time: null, updated_time: null }], error: null },
      meta_ads_ads: { data: [{ ad_id: AD1, meta_created_time: '2026-11-01T10:00:00Z', meta_updated_time: '2026-11-09T10:00:00Z' }], error: null },
    } })
    const r = await loadExtended(m.supabase, base)
    expect(m.calls.map((c) => c.table).sort()).toEqual(['meta_ads_ads', 'meta_ads_adsets', 'meta_ads_campaigns'])
    expect(m.calls.every((c) => c.account === A)).toBe(true)
    expect(m.calls.find((c) => c.table === 'meta_ads_ads')!.ids).toEqual([AD1, AD2])
    expect(r!.campaigns[0].detail).toMatchObject({ objective: 'MESSAGES', buying_type: 'AUCTION', daily_budget: 5000 })
    expect(r!.adsets[0].detail).toMatchObject({ optimization_goal: 'CONVERSATIONS', billing_event: 'IMPRESSIONS', bid_strategy: null })
    expect(r!.ads.find((a) => a.id === AD1)!.detail).toEqual({ created_time: '2026-11-01T10:00:00Z', updated_time: '2026-11-09T10:00:00Z' })
    expect(r!.ads.find((a) => a.id === AD2)!.detail).toBeNull()
  })
  it('a failing details lookup keeps the extended metrics (details are optional)', async () => {
    const m = mk({ tables: { meta_ads_campaigns: { data: null, error: { message: 'x' } } } })
    const r = await loadExtended(m.supabase, base)
    expect(r!.summary!.reach).toBe(6000)
    expect(r!.campaigns[0].ext!.reach).toBe(5200)
  })
  it('placeholder ids ("(sin id)") are never looked up in the catalog', async () => {
    const m = mk()
    await loadExtended(m.supabase, { ...base, ads: buildPerfRows([{ id: '(sin id)', spend: 1, impressions: 1, clicks: 1 }, { id: AD1, spend: 1, impressions: 1, clicks: 1 }]) })
    expect(m.calls.find((c) => c.table === 'meta_ads_ads')!.ids).toEqual([AD1])
  })
})
