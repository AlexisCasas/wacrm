import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildExt, buildPerfRows, mergeRange, metaWindow, sumTotals } from './performance'

// Cross-check of the APP read model against the REAL output of meta_ads_performance on the disposable PostgreSQL used by qa/meta-ads/run-sql-qa.sh.
// Skipped in normal runs: set META_ADS_QA_JSON=<round1.json written by that script> to execute it.
const file = process.env.META_ADS_QA_JSON
type Doc = { today: string; windows: Record<string, { since: string; until: string }>; perf: Record<string, Record<'campaign' | 'adset' | 'ad', unknown[]>> }
const AD1 = '120232883780380285', AD2 = '120239084979500285', AD3 = '120256299148760285', AD4 = '120255157385110285'
const C1 = '120256298878110285', C2 = '120256297069270285', S1 = '120256298878120285', S2 = '120256297702420285'

describe.skipIf(!file)('app read model vs real PostgreSQL output', () => {
  const doc = (): Doc => JSON.parse(readFileSync(file as string, 'utf8')) as Doc
  const now = Date.parse('2026-11-10T16:00:00Z') // 2026-11-10 in America/Bogota = the fixed "today" of the SQL QA

  it('the SQL windows are exactly what the app computes: N complete days before today, today excluded', () => {
    for (const n of [7, 30, 90]) expect(doc().windows[String(n)]).toEqual(metaWindow(n, 'America/Bogota', now))
    expect(doc().windows['7']).toEqual({ since: '2026-11-03', until: '2026-11-09' })
    expect(doc().windows['30']).toEqual({ since: '2026-10-11', until: '2026-11-09' })
    expect(doc().windows['90']).toEqual({ since: '2026-08-12', until: '2026-11-09' })
  })
  it('7D per ad: sums, CTR, CPC, CPM; zero clicks and zero impressions give null, never NaN/Infinity', () => {
    const ads = new Map(buildPerfRows(doc().perf['7'].ad).map((r) => [r.id, r]))
    expect([...ads.keys()].sort()).toEqual([AD1, AD2, AD4, AD3].sort())
    expect(ads.get(AD1)).toMatchObject({ name: 'Anuncio Uno', spend: 70, impressions: 7000, clicks: 140, ctr: 2, cpc: 0.5, cpm: 10, status: 'ACTIVE' })
    expect(ads.get(AD2)).toMatchObject({ spend: 12, impressions: 1500, clicks: 0, ctr: 0, cpc: null, cpm: 8 })
    expect(ads.get(AD3)).toMatchObject({ spend: 0, impressions: 0, clicks: 0, ctr: null, cpc: null, cpm: null, status: null })
    expect(ads.get(AD4)).toMatchObject({ name: null, spend: 1.5, impressions: 100, clicks: 2, ctr: 2, cpc: 0.75, cpm: 15 })
  })
  it('campaigns and ad sets are keyed by Meta id even though both campaigns (and both ad sets) share the same name', () => {
    const camps = buildPerfRows(doc().perf['7'].campaign)
    expect(camps.map((c) => c.id).sort()).toEqual([C1, C2].sort())
    expect(new Set(camps.map((c) => c.name)).size).toBe(1)
    expect(camps.find((c) => c.id === C2)).toMatchObject({ spend: 13.5, impressions: 1600, clicks: 2, ctr: 0.125, cpc: 6.75, cpm: 8.4375, status: 'PAUSED' })
    const sets = buildPerfRows(doc().perf['7'].adset)
    expect(sets.map((s) => s.id).sort()).toEqual([S1, S2].sort())
    expect(sets.find((s) => s.id === S2)).toMatchObject({ campaign_id: C2, spend: 13.5, ctr: 0.125 })
  })
  it('totals are the same at every level and ratios come from the totals (not averages)', () => {
    const d = doc()
    const expected: Record<string, [number, number, number]> = { '7': [83.5, 8600, 142], '30': [317.5, 32100, 602], '90': [921.5, 92600, 1802] }
    for (const n of ['7', '30', '90']) {
      const [spend, impressions, clicks] = expected[n]
      for (const lvl of ['campaign', 'adset', 'ad'] as const) expect(sumTotals(buildPerfRows(d.perf[n][lvl]))).toMatchObject({ spend, impressions, clicks })
    }
    expect(sumTotals(buildPerfRows(d.perf['7'].ad))).toMatchObject({ ctr: 1.6512, cpc: 0.588, cpm: 9.7093 })
  })
  it('no reach, no token and no NaN/Infinity anywhere in the real output', () => {
    const text = readFileSync(file as string, 'utf8')
    expect(text).not.toMatch(/reach|token|NaN|Infinity/i)
    for (const n of ['7', '30', '90']) for (const lvl of ['campaign', 'adset', 'ad'] as const) for (const r of buildPerfRows(doc().perf[n][lvl])) for (const v of Object.values(r)) if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true)
  })
})


// Range cache (reach / frequency / link + outbound clicks / actions) as returned by the REAL meta_ads_range_metrics on the disposable PostgreSQL.
const rangeFile = process.env.META_ADS_QA_RANGE_JSON
type RangeDoc = { range: Record<string, Record<'account' | 'campaign' | 'adset' | 'ad', Record<string, unknown>[]>> }
describe.skipIf(!rangeFile)('app extended read model vs real PostgreSQL range output', () => {
  const doc = (): RangeDoc => JSON.parse(readFileSync(rangeFile as string, 'utf8')) as RangeDoc
  it('REACH is Meta\'s aggregate (5200), not the 5600 daily sum; the account keeps its own aggregate (6000)', () => {
    const d = doc().range['7']
    const ad1 = d.ad.find((r) => r.id === AD1)!
    expect(ad1.reach).toBe(5200)
    expect(ad1.reach).not.toBe(5600)
    expect(d.account[0].reach).toBe(6000)
  })
  it('FREQUENCY, link clicks and outbound clicks arrive as separate fields and the app maps them without recomputation', () => {
    const e = buildExt(doc().range['7'].ad.find((r) => r.id === AD1), 7000)
    expect(e).toMatchObject({ reach: 5200, frequency: 1.3462, link_clicks: 120, outbound_clicks: 100 })
    expect(Math.abs((e.frequency as number) - 7000 / 5200)).toBeLessThan(0.0001)
  })
  it('the five messaging action_types map to their labelled slots; lead aliases stay separate; other types are listed; nothing is NaN', () => {
    const e = buildExt(doc().range['7'].ad.find((r) => r.id === AD1), 7000)
    expect(e.messaging).toEqual({ conversations_started: 40, connections: 55, first_replies: 30, depth_2: 20, depth_3: 10 })
    expect(e.other_results.filter((o) => o.lead_alias).map((o) => o.action_type).sort()).toEqual(['lead', 'onsite_conversion.lead_grouped', 'onsite_web_lead'])
    expect(e.other_results.some((o) => o.action_type === 'video_view' && o.value === 900)).toBe(true)
    for (const o of e.other_results) expect(Number.isFinite(o.value)).toBe(true)
  })
  it('7D / 30D / 90D each return their own window values (reach 5200 / 20000 / 40000) and mergeRange attaches them by id', () => {
    const d = doc().range
    expect(['7', '30', '90'].map((n) => d[n].ad.find((r) => r.id === AD1)?.reach)).toEqual([5200, 20000, 40000])
    const rows = mergeRange(buildPerfRows([{ id: AD1, spend: 70, impressions: 7000, clicks: 140 }, { id: AD2, spend: 13.5, impressions: 1600, clicks: 2 }]), d['7'].ad)
    expect(rows.find((r) => r.id === AD1)?.ext?.reach).toBe(5200)
    expect(rows.find((r) => r.id === AD2)?.ext).toBeNull() // no cached range row for this ad in the window: null, never a derived value
  })
})
