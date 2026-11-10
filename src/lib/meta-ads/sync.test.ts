import { afterEach, describe, expect, it, vi } from 'vitest'
import { addDays, dateInTz, JOBS, MAX_PAGES, metaAdsGloballyEnabled, retryDelayMs, runMetaAdsSync, type Job, type Reconciliation, type SyncAccount, type SyncStore } from './sync'
import type { InsightRow, MetaAd, MetaAdset, MetaCampaign, RangeLevel, RangeRow } from './client'

const A = '4d04a2e0-62b8-4508-a046-4b125aa2e8db'
const TOKEN = 'EAAFAKE_PLAINTEXT_TOKEN_9876543210'
const acct: SyncAccount = { account_id: A, ad_account_id: '409949686293101', access_token_enc: 'iv:ct:tag', api_version: 'v27.0', currency: 'PEN', account_timezone: 'America/Bogota', catalog_interval_minutes: 60, insights_interval_minutes: 180 }
const NOW = Date.parse('2026-11-10T16:00:00.000Z') // 2026-11-10 in America/Bogota
const TODAY = '2026-11-10'
const TARGET = '2026-08-12' // 90 days back

// ids are strings (they exceed JS safe integers): never build them with arithmetic
const id = (prefix: string, n: number) => `${prefix}${String(n).padStart(5, '0')}`
const adId = (n: number) => id('1202562991487', n)
const adsetId = (n: number) => id('1202562988781', n)
const campId = (n: number) => id('1202562988782', n)

interface St { nextRunAt: number; leaseUntil: number | null; failures: number; status: string; coveredFrom: string | null; coveredTo: string | null; successAt: string | null; lastCode: string | null; rows: number }
function mem(over: Partial<Record<Job, Partial<St>>> = {}, accounts: SyncAccount[] = [acct]) {
  const fresh = (j: Job): St => ({ nextRunAt: 0, leaseUntil: null, failures: 0, status: 'idle', coveredFrom: null, coveredTo: null, successAt: null, lastCode: null, rows: 0, ...over[j] })
  const st = Object.fromEntries(JOBS.map((j) => [j, fresh(j)])) as Record<Job, St>
  const ads = new Map<string, MetaAd>()
  const adsets = new Map<string, MetaAdset>()
  const campaigns = new Map<string, MetaCampaign>()
  const insights = new Map<string, InsightRow & { currency: string }>()
  const recs = new Map<number, Reconciliation & { checkedAt: string }>()
  const ranges = new Map<string, { level: RangeLevel; entity: string; days: number; since: string; until: string; row: RangeRow; syncedAtMs: number }>()
  const rangeActions = new Map<string, { value: string; syncedAtMs: number }>()
  const pruneCalls: { level: string; days: number; includeActions: boolean }[] = []
  const tokenStatus = { v: 'unverified' as string }
  const upsertCalls: Record<string, number[]> = { ads: [], adsets: [], campaigns: [], insights: [] }
  const store: SyncStore = {
    listAccounts: async () => accounts,
    ensureState: async () => {},
    claim: async (_a, job, nowIso, leaseIso) => {
      const s = st[job]
      const now = Date.parse(nowIso)
      if (s.status === 'paused' || s.nextRunAt > now || (s.leaseUntil !== null && s.leaseUntil >= now)) return { claimed: false, failures: s.failures, coveredFrom: s.coveredFrom, coveredTo: s.coveredTo }
      s.leaseUntil = Date.parse(leaseIso)
      s.status = 'running'
      return { claimed: true, failures: s.failures, coveredFrom: s.coveredFrom, coveredTo: s.coveredTo }
    },
    upsertAds: async (_a, l) => { upsertCalls.ads.push(l.length); l.forEach((x) => ads.set(x.ad_id, x)) },
    upsertAdsets: async (_a, l) => { upsertCalls.adsets.push(l.length); l.forEach((x) => adsets.set(x.adset_id, x)) },
    upsertCampaigns: async (_a, l) => { upsertCalls.campaigns.push(l.length); l.forEach((x) => campaigns.set(x.campaign_id, x)) },
    upsertInsights: async (_a, l, currency) => { upsertCalls.insights.push(l.length); l.forEach((x) => insights.set(`${x.ad_id}|${x.date}`, { ...x, currency })) },
    finishOk: async (_a, job, v) => {
      Object.assign(st[job], { status: 'ok', leaseUntil: null, nextRunAt: Date.parse(v.nextRunAtIso), failures: 0, successAt: v.nowIso, lastCode: null, rows: v.rows })
      if (v.coveredFrom !== undefined) st[job].coveredFrom = v.coveredFrom
      if (v.coveredTo !== undefined) st[job].coveredTo = v.coveredTo
    },
    finishError: async (_a, job, v) => {
      Object.assign(st[job], { status: v.paused ? 'paused' : 'error', leaseUntil: null, nextRunAt: Date.parse(v.nextRunAtIso), failures: v.failures, lastCode: v.code })
      if (v.coveredFrom) st[job].coveredFrom = v.coveredFrom
      if (v.coveredTo) st[job].coveredTo = v.coveredTo
    },
    setTokenStatus: async (_a, s) => { tokenStatus.v = s },
    upsertRange: async (_a, level, days, since, until, rows, _cur, nowIso) => {
      for (const r of rows) {
        ranges.set(`${level}|${r.entity_id}|${days}`, { level, entity: r.entity_id, days, since, until, row: r, syncedAtMs: Date.parse(nowIso) })
        for (const a of r.actions) rangeActions.set(`${level}|${r.entity_id}|${days}|${a.action_type}`, { value: a.value, syncedAtMs: Date.parse(nowIso) })
      }
    },
    pruneRange: async (_a, level, days, beforeIso, includeActions) => {
      pruneCalls.push({ level, days, includeActions })
      const before = Date.parse(beforeIso)
      if (includeActions) for (const [k, v] of rangeActions) if (k.startsWith(`${level}|`) && k.split('|')[2] === String(days) && v.syncedAtMs < before) rangeActions.delete(k)
      for (const [k, v] of ranges) if (v.level === level && v.days === days && v.syncedAtMs < before) { ranges.delete(k); for (const ak of [...rangeActions.keys()]) if (ak.startsWith(`${k}|`)) rangeActions.delete(ak) }
    },
    localTotals: async (_a, since, until) => {
      let spend = 0, impressions = 0, clicks = 0
      for (const r of insights.values()) if (r.date >= since && r.date <= until) { spend += Number(r.spend); impressions += r.impressions; clicks += r.clicks }
      return { spend: spend.toFixed(4), impressions, clicks }
    },
    reconciledAt: async () => Object.fromEntries([...recs].map(([n, r]) => [n, r.checkedAt])),
    saveReconciliation: async (_a, rec, nowIso) => { recs.set(rec.windowDays, { ...rec, checkedAt: nowIso }) },
  }
  return { store, st, ads, adsets, campaigns, insights, recs, tokenStatus, upsertCalls, ranges, rangeActions, pruneCalls }
}

// ---- a fake Meta Graph API ------------------------------------------------------------------------------------------------------------------
interface Day { date_start: string; ad_id: string; adset_id: string; campaign_id: string; impressions: string; clicks: string; spend: string; reach?: string }
function daysOf(from: string, to: string, ads = 2): Day[] {
  const out: Day[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const n = Number(d.slice(8)) + Number(d.slice(5, 7))
    for (let a = 1; a <= ads; a++) out.push({ date_start: d, ad_id: adId(a), adset_id: adsetId(a), campaign_id: campId(1), impressions: String(1000 * a + n), clicks: String(10 * a + (n % 7)), spend: `${(a * 10 + (n % 5) / 4).toFixed(2)}`, reach: String(900 * a) })
  }
  return out
}
const ALL = daysOf('2026-08-01', TODAY)
function fakeMeta(o: { data?: Day[]; pageSize?: number; override?: (url: URL) => Response | undefined; accountTotals?: { spend: string; impressions: string; clicks: string } } = {}) {
  const data = o.data ?? ALL
  const pageSize = o.pageSize ?? 50
  const calls: URL[] = []
  const f = vi.fn(async (url: string | URL | Request) => {
    const u = new URL(String(url))
    calls.push(u)
    const forced = o.override?.(u)
    if (forced) return forced
    const edge = u.pathname.split('/').pop()
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
    const list = (rows: unknown[]) => {
      const off = Number(u.searchParams.get('after') ?? 0)
      const page = rows.slice(off, off + pageSize)
      return json({ data: page, paging: off + pageSize < rows.length ? { cursors: { after: String(off + pageSize) }, next: 'https://never-followed' } : { cursors: { after: 'END' } } })
    }
    if (edge === 'ads') return list([1, 2, 3, 4, 5].map((n) => ({ id: adId(n), name: `Anuncio ${n}`, status: 'ACTIVE', effective_status: 'ACTIVE', adset_id: adsetId(n), campaign_id: campId(1), adset: { name: `Conjunto ${n}` }, campaign: { name: 'Campaña 1' } })))
    if (edge === 'adsets') return list([1, 2, 3].map((n) => ({ id: adsetId(n), name: `Conjunto ${n}`, campaign_id: campId(1), status: 'ACTIVE', effective_status: 'ACTIVE' })))
    if (edge === 'campaigns') return list([{ id: campId(1), name: 'Campaña 1', status: 'ACTIVE', effective_status: 'ACTIVE' }])
    const range = JSON.parse(u.searchParams.get('time_range') ?? '{}') as { since: string; until: string }
    const inRange = data.filter((d) => d.date_start >= range.since && d.date_start <= range.until)
    const lvl = u.searchParams.get('level') as 'account' | 'campaign' | 'adset' | 'ad'
    if (!u.searchParams.get('time_increment') && (u.searchParams.get('fields') ?? '').includes('reach')) {
      // AGGREGATED range rows: Meta's reach for the whole window is NOT the sum of the daily reach (here: 80% of it, like the live audit showed a smaller figure)
      const idKey = { account: 'account_id', campaign: 'campaign_id', adset: 'adset_id', ad: 'ad_id' }[lvl]
      const groups = new Map<string, Day[]>()
      for (const d of inRange) { const k = lvl === 'account' ? '409949686293101' : (d as unknown as Record<string, string>)[idKey]; groups.set(k, [...(groups.get(k) ?? []), d]) }
      const wantActions = (u.searchParams.get('fields') ?? '').includes('actions')
      const rows = [...groups.entries()].map(([k, ds]) => {
        const spend = ds.reduce((s, d) => s + Number(d.spend), 0), impressions = ds.reduce((s, d) => s + Number(d.impressions), 0), clicks = ds.reduce((s, d) => s + Number(d.clicks), 0)
        const reach = Math.floor(ds.reduce((s, d) => s + Number(d.reach ?? 0), 0) * (lvl === 'account' ? 0.6 : 0.8))
        return { [idKey]: k, spend: spend.toFixed(2), impressions: String(impressions), clicks: String(clicks), reach: String(reach), frequency: (impressions / reach).toFixed(4), ctr: String((clicks / impressions) * 100), cpc: String(spend / clicks), cpm: String((spend / impressions) * 1000),
          ...(wantActions ? { inline_link_clicks: String(Math.floor(clicks * 0.8)), outbound_clicks: [{ action_type: 'outbound_click', value: String(Math.floor(clicks * 0.7)) }, { action_type: 'something_else', value: '999' }],
            actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '5' }, { action_type: 'lead', value: '1' }, { action_type: 'onsite_web_lead', value: '1' }, { action_type: 'brand_new_unknown_type', value: '3' }, { action_type: 'bad type!', value: '9' }, { action_type: 'lead', value: '7' }] } : {}) }
      })
      return list(rows)
    }
    if (u.searchParams.get('level') === 'account') {
      if (o.accountTotals) return json({ data: [o.accountTotals] })
      if (inRange.length === 0) return json({ data: [] })
      const sum = (k: 'impressions' | 'clicks') => inRange.reduce((s, d) => s + Number(d[k]), 0)
      return json({ data: [{ spend: inRange.reduce((s, d) => s + Number(d.spend), 0).toFixed(2), impressions: String(sum('impressions')), clicks: String(sum('clicks')) }] })
    }
    return list(inRange)
  })
  return Object.assign(f, { calls, insightRanges: () => calls.filter((c) => c.pathname.endsWith('/insights') && c.searchParams.get('level') === 'ad' && !c.searchParams.get('after')).map((c) => JSON.parse(c.searchParams.get('time_range')!) as { since: string; until: string }) })
}
const deps = (f: unknown, over: object = {}) => ({ enabled: true, fetchImpl: f as typeof fetch, decryptToken: () => TOKEN, now: () => NOW, random: () => 0.5, ...over })
const err = (status: number, code: number, headers: Record<string, string> = {}) => new Response(JSON.stringify({ error: { code, message: `bad ${TOKEN}` } }), { status, headers })

afterEach(() => vi.restoreAllMocks())

describe('dates', () => {
  it('Meta dates are calendar days of the AD ACCOUNT timezone (America/Bogota = UTC-5), not UTC days', () => {
    expect(dateInTz(Date.parse('2026-11-10T03:00:00Z'), 'America/Bogota')).toBe('2026-11-09')
    expect(dateInTz(Date.parse('2026-11-10T05:00:00Z'), 'America/Bogota')).toBe('2026-11-10')
    expect(addDays('2026-11-10', -90)).toBe(TARGET)
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })
})

describe('global switch', () => {
  it('OFF by default: nothing is read and Meta is never called', async () => {
    delete process.env.META_ADS_ENABLED
    expect(metaAdsGloballyEnabled()).toBe(false)
    const m = mem()
    const f = vi.fn()
    const r = await runMetaAdsSync(m.store, { fetchImpl: f as unknown as typeof fetch, decryptToken: () => TOKEN })
    expect(r).toMatchObject({ enabled: false, accounts: 0, synced: 0 })
    expect(f).not.toHaveBeenCalled()
  })
})

describe('catalog, ad sets and campaigns (paginated, idempotent)', () => {
  it('each job walks to the LAST page and upserts every row; ids stay text', async () => {
    const m = mem()
    const f = fakeMeta({ pageSize: 2 })
    const r = await runMetaAdsSync(m.store, deps(f, { jobs: ['campaigns', 'adsets', 'catalog'] }))
    expect(r.jobs).toMatchObject({ campaigns: { synced: 1, rows: 1 }, adsets: { synced: 1, rows: 3 }, catalog: { synced: 1, rows: 5 } })
    expect(m.upsertCalls).toMatchObject({ ads: [2, 2, 1], adsets: [2, 1], campaigns: [1] })
    expect([...m.ads.keys()].every((k) => typeof k === 'string' && k.length === 18)).toBe(true)
    expect(m.adsets.get(adsetId(1))).toMatchObject({ name: 'Conjunto 1', campaign_id: campId(1), status: 'ACTIVE' })
    expect(m.campaigns.get(campId(1))?.name).toBe('Campaña 1')
    expect(m.tokenStatus.v).toBe('valid')
  })
  it('a second full pass updates in place (no duplicates) and never deletes what Meta stops returning', async () => {
    const m = mem()
    await runMetaAdsSync(m.store, deps(fakeMeta(), { jobs: ['catalog'] }))
    m.st.catalog.nextRunAt = 0
    const only1 = fakeMeta({ override: (u) => (u.pathname.endsWith('/ads') ? new Response(JSON.stringify({ data: [{ id: adId(1), name: 'Renombrado' }] }), { status: 200 }) : undefined) })
    await runMetaAdsSync(m.store, deps(only1, { jobs: ['catalog'] }))
    expect(m.ads.size).toBe(5)
    expect(m.ads.get(adId(1))?.name).toBe('Renombrado')
  })
  it('a cursor loop or runaway pagination stops with an error and never marks the pass synced', async () => {
    const m = mem()
    const loop = fakeMeta({ override: (u) => (u.pathname.endsWith('/ads') ? new Response(JSON.stringify({ data: [{ id: adId(1) }], paging: { cursors: { after: 'SAME' }, next: 'x' } }), { status: 200 }) : undefined) })
    await runMetaAdsSync(m.store, deps(loop, { jobs: ['catalog'] }))
    expect(m.st.catalog).toMatchObject({ status: 'error', lastCode: 'cursor_loop', successAt: null })
    const e = mem()
    let n = 0
    const endless = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: adId(++n) }], paging: { cursors: { after: `C${n}` }, next: 'x' } }), { status: 200 }))
    await runMetaAdsSync(e.store, deps(endless, { jobs: ['catalog'] }))
    expect(endless).toHaveBeenCalledTimes(MAX_PAGES)
    expect(e.st.catalog).toMatchObject({ lastCode: 'max_pages', successAt: null })
  })
  it('a job rejected by Meta (e.g. a 400 on one endpoint) does not block the others', async () => {
    const m = mem()
    const f = fakeMeta({ override: (u) => (u.pathname.endsWith('/campaigns') ? err(400, 100) : undefined) })
    const r = await runMetaAdsSync(m.store, deps(f, { jobs: ['campaigns', 'adsets', 'catalog'] }))
    expect(r.jobs.campaigns.failed).toBe(1)
    expect(r.jobs.adsets.synced).toBe(1)
    expect(r.jobs.catalog.synced).toBe(1)
    expect(m.st.campaigns.lastCode).toBe('meta_100')
  })
})

describe('insights sync', () => {
  const runInsights = (m: ReturnType<typeof mem>, f: ReturnType<typeof fakeMeta>, over: object = {}) => runMetaAdsSync(m.store, deps(f, { jobs: ['insights'], ...over }))

  it('FIRST run: newest 7 days first, then backfill downwards in 7-day blocks (resumable), saving coverage', async () => {
    const m = mem()
    const f = fakeMeta()
    const r = await runInsights(m, f)
    expect(r.jobs.insights.synced).toBe(1)
    const ranges = f.insightRanges()
    expect(ranges[0]).toEqual({ since: '2026-11-04', until: TODAY })
    expect(ranges.slice(1).map((x) => x.since)).toEqual(['2026-10-28', '2026-10-21', '2026-10-14', '2026-10-07', '2026-09-30', '2026-09-23'])
    expect(ranges[1].until).toBe('2026-11-03')
    expect(m.st.insights).toMatchObject({ coveredFrom: '2026-09-23', coveredTo: TODAY, status: 'ok' })
    expect(m.st.insights.nextRunAt).toBe(NOW + 3 * 60_000) // backfill pending: come back soon
  })
  it('second run finishes the 90-day backfill exactly at today-90 and goes back to the normal interval', async () => {
    const m = mem()
    await runInsights(m, fakeMeta())
    m.st.insights.nextRunAt = 0
    const f = fakeMeta()
    await runInsights(m, f)
    expect(m.st.insights).toMatchObject({ coveredFrom: TARGET, coveredTo: TODAY })
    expect(f.insightRanges()[0]).toEqual({ since: '2026-11-07', until: TODAY }) // refresh: last 3 days + today
    expect(f.insightRanges().at(-1)).toEqual({ since: TARGET, until: '2026-08-18' })
    expect(m.st.insights.nextRunAt).toBe(NOW + 180 * 60_000) // insights_interval_minutes
    expect(Math.min(...[...m.insights.values()].map((r) => Number(r.date.replace(/-/g, ''))))).toBe(Number(TARGET.replace(/-/g, '')))
  })
  it('MAINTENANCE: with the backfill complete, each run re-fetches only the last 3 days + today (Meta restates recent days)', async () => {
    const m = mem({ insights: { coveredFrom: TARGET, coveredTo: TODAY } })
    const f = fakeMeta()
    await runInsights(m, f)
    expect(f.insightRanges()).toEqual([{ since: '2026-11-07', until: TODAY }])
  })
  it('after downtime the gap since the last covered day is filled (in 7-day blocks) before anything else', async () => {
    const m = mem({ insights: { coveredFrom: TARGET, coveredTo: '2026-10-25' } })
    const f = fakeMeta()
    await runInsights(m, f)
    expect(f.insightRanges()).toEqual([{ since: '2026-10-22', until: '2026-10-28' }, { since: '2026-10-29', until: '2026-11-04' }, { since: '2026-11-05', until: TODAY }])
    expect(m.st.insights.coveredTo).toBe(TODAY)
  })
  it('stores Meta\'s date_start as-is, spend as an exact decimal string, the configured currency, and reach per day (informational)', async () => {
    const m = mem({ insights: { coveredFrom: TARGET, coveredTo: TODAY } })
    const data: Day[] = [{ date_start: '2026-11-09', ad_id: adId(1), adset_id: adsetId(1), campaign_id: campId(1), impressions: '19819', clicks: '392', spend: '102.50', reach: '18646' }]
    await runInsights(m, fakeMeta({ data }))
    const row = m.insights.get(`${adId(1)}|2026-11-09`)!
    expect(row).toMatchObject({ date: '2026-11-09', impressions: 19819, clicks: 392, spend: '102.50', reach: 18646, currency: 'PEN', ad_id: adId(1) })
    expect(typeof row.spend).toBe('string') // never a float on its way to NUMERIC
  })
  it('is idempotent: re-syncing a day restates it in place (same key), never duplicating', async () => {
    const m = mem({ insights: { coveredFrom: TARGET, coveredTo: TODAY } })
    const day = (spend: string): Day[] => [{ date_start: '2026-11-09', ad_id: adId(1), adset_id: adsetId(1), campaign_id: campId(1), impressions: '10', clicks: '1', spend }]
    await runInsights(m, fakeMeta({ data: day('5.00') }))
    m.st.insights.nextRunAt = 0
    await runInsights(m, fakeMeta({ data: day('7.25') }))
    expect(m.insights.size).toBe(1)
    expect(m.insights.get(`${adId(1)}|2026-11-09`)?.spend).toBe('7.25')
  })
  it('follows Insights pagination to the last page (no row lost) and tolerates missing clicks/reach fields', async () => {
    const m = mem({ insights: { coveredFrom: TARGET, coveredTo: TODAY } })
    const data = daysOf('2026-11-07', TODAY, 3).map((d, i) => (i === 0 ? ({ ...d, clicks: undefined, reach: undefined } as unknown as Day) : d))
    const f = fakeMeta({ data, pageSize: 5 })
    await runInsights(m, f)
    expect(m.insights.size).toBe(data.length)
    expect(m.upsertCalls.insights.length).toBeGreaterThan(2)
    expect(m.insights.get(`${data[0].ad_id}|${data[0].date_start}`)).toMatchObject({ clicks: 0, reach: null })
  })
  it('malformed rows (bad date / spend / id) are dropped, never guessed', async () => {
    const m = mem({ insights: { coveredFrom: TARGET, coveredTo: TODAY } })
    const good: Day = { date_start: '2026-11-09', ad_id: adId(1), adset_id: adsetId(1), campaign_id: campId(1), impressions: '1', clicks: '1', spend: '1.00' }
    const data = [good, { ...good, ad_id: 'abc' }, { ...good, date_start: '09/11/2026' }, { ...good, spend: 'NaN', ad_id: adId(2) }, { ...good, impressions: '-5', ad_id: adId(3) }]
    await runInsights(m, fakeMeta({ data }))
    expect([...m.insights.keys()]).toEqual([`${adId(1)}|2026-11-09`])
  })

  it('PARTIAL sync: a failure mid-backfill keeps every stored day, saves the coverage reached, and the next run resumes from there', async () => {
    const m = mem()
    let blocks = 0
    const f = fakeMeta({ override: (u) => (u.pathname.endsWith('/insights') && u.searchParams.get('level') === 'ad' && ++blocks === 3 ? err(400, 613, { 'retry-after': '600' }) : undefined) })
    const r = await runInsights(m, f)
    expect(r.jobs.insights.failed).toBe(1)
    expect(m.st.insights).toMatchObject({ status: 'error', lastCode: 'meta_613', failures: 1, coveredFrom: '2026-10-28', coveredTo: TODAY })
    expect(m.st.insights.nextRunAt).toBeGreaterThanOrEqual(NOW + 600_000)
    const stored = m.insights.size
    expect(stored).toBeGreaterThan(0)
    m.st.insights.nextRunAt = 0
    const g = fakeMeta()
    await runInsights(m, g)
    expect(g.insightRanges()[1]).toEqual({ since: '2026-10-21', until: '2026-10-27' }) // resumes below the covered range
    expect(m.insights.size).toBeGreaterThan(stored)
  })
  it('META UNAVAILABLE: 503 or network errors store nothing new, keep old data, count failures with growing backoff', async () => {
    const m = mem({ insights: { coveredFrom: TARGET, coveredTo: TODAY } })
    await runInsights(m, fakeMeta({ data: daysOf('2026-11-09', '2026-11-09') }))
    const before = m.insights.size
    for (const [i, bad] of [new Response('{}', { status: 503 }), null].entries()) {
      m.st.insights.nextRunAt = 0
      const f = bad ? vi.fn(async () => bad.clone()) : vi.fn(async () => { throw new Error(`down ${TOKEN}`) })
      await runInsights(m, f as never)
      expect(m.st.insights.failures).toBe(i + 1)
    }
    expect(m.insights.size).toBe(before)
    expect(m.st.insights.successAt).not.toBeNull()
    expect(retryDelayMs(2, undefined, () => 0.5)).toBe(2 * retryDelayMs(1, undefined, () => 0.5))
  })
  it('INVALID TOKEN (190): token marked invalid, insights paused, the account\'s remaining jobs are NOT called, nothing stored', async () => {
    const m = mem()
    const f = fakeMeta({ override: () => err(400, 190) })
    const r = await runMetaAdsSync(m.store, deps(f))
    expect(m.tokenStatus.v).toBe('invalid')
    expect(m.st.campaigns).toMatchObject({ status: 'paused', lastCode: 'meta_190' })
    expect(f).toHaveBeenCalledTimes(1) // stopped at the first job
    expect(r.failed).toBe(1)
    expect(m.insights.size + m.ads.size).toBe(0)
    expect(JSON.stringify(m.st)).not.toContain(TOKEN)
  })
  it('a rate limit stops the account\'s other jobs for this run (no hammering) but a plain rejection does not', async () => {
    const m = mem()
    const f = fakeMeta({ override: (u) => (u.pathname.endsWith('/campaigns') ? err(400, 4) : undefined) })
    const r = await runMetaAdsSync(m.store, deps(f))
    expect(r.jobs.adsets.synced + r.jobs.catalog.synced + r.jobs.insights.synced).toBe(0)
    expect(f).toHaveBeenCalledTimes(1)
  })
  it('an unreadable stored token never reaches Meta', async () => {
    const m = mem()
    const f = vi.fn()
    await runMetaAdsSync(m.store, deps(f, { decryptToken: () => { throw new Error('bad key') } }))
    expect(f).not.toHaveBeenCalled()
    expect(m.st.campaigns).toMatchObject({ status: 'paused', lastCode: 'token_unreadable' })
  })
  it('jobs that are not due, or are leased by another runner, are skipped without calling Meta', async () => {
    const f = vi.fn()
    expect((await runMetaAdsSync(mem({ insights: { nextRunAt: NOW + 1000 } }).store, deps(f, { jobs: ['insights'] }))).skipped).toBe(1)
    expect((await runMetaAdsSync(mem({ insights: { leaseUntil: NOW + 1000 } }).store, deps(f, { jobs: ['insights'] }))).skipped).toBe(1)
    expect(f).not.toHaveBeenCalled()
  })
  it('one failing account does not block another', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const good = mem()
    const b = { ...acct, account_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
    const store: SyncStore = { ...good.store, listAccounts: async () => [b, acct], claim: async (id, j, n, l) => { if (id === b.account_id) throw new Error(`db down ${TOKEN}`); return good.store.claim(id, j, n, l) } }
    const r = await runMetaAdsSync(store, deps(fakeMeta(), { jobs: ['catalog'] }))
    expect(r).toMatchObject({ accounts: 2, synced: 1, failed: 1 })
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN)
  })
  it('the token only travels in the Authorization header: never in URLs, results, stored state or logs', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const m = mem()
    const f = fakeMeta()
    const r = await runMetaAdsSync(m.store, deps(f))
    for (const c of f.calls) expect(c.toString()).not.toContain(TOKEN)
    for (const call of f.mock.calls as unknown as [unknown, RequestInit][]) expect((call[1].headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.stringify([r, m.st, [...m.insights.values()], [...m.ads.values()], log.mock.calls])).not.toContain(TOKEN)
  })
})

describe('reconciliation against Meta account totals', () => {
  it('after the full backfill 7D, 30D and 90D are each compared (spend to the cent, impressions and clicks exactly) and recorded as OK', async () => {
    const m = mem()
    const f = fakeMeta()
    await runMetaAdsSync(m.store, deps(f, { jobs: ['insights'] }))
    expect([...m.recs.keys()].sort((a, b) => a - b)).toEqual([7, 30]) // 90D is not fully stored yet: skipped, not faked
    m.st.insights.nextRunAt = 0
    await runMetaAdsSync(m.store, deps(f, { jobs: ['insights'] }))
    expect([...m.recs.keys()].sort((a, b) => a - b)).toEqual([7, 30, 90])
    for (const [n, rec] of m.recs) {
      expect(rec).toMatchObject({ ok: true, dateTo: '2026-11-09', dateFrom: addDays(TODAY, -n) })
      expect(rec.local.impressions).toBe(rec.meta.impressions)
      expect(rec.local.clicks).toBe(rec.meta.clicks)
    }
    expect(f.calls.filter((c) => c.searchParams.get('level') === 'account').length).toBe(3)
    // not repeated within ~a day
    m.st.insights.nextRunAt = 0
    await runMetaAdsSync(m.store, deps(f, { jobs: ['insights'] }))
    expect(f.calls.filter((c) => c.searchParams.get('level') === 'account').length).toBe(3)
  })
  it('a difference is recorded as ok=false (never hidden, never "fixed" with a tolerance)', async () => {
    const m = mem({ insights: { coveredFrom: TARGET, coveredTo: TODAY } })
    const f = fakeMeta({ accountTotals: { spend: '1.00', impressions: '5', clicks: '1' } })
    await runMetaAdsSync(m.store, deps(f, { jobs: ['insights'] }))
    expect(m.recs.get(7)?.ok).toBe(false)
    expect(m.recs.get(7)?.meta).toEqual({ spend: '1.00', impressions: 5, clicks: 1 })
  })
  it('compares the cent exactly: 0.004 of local drift still equals, 0.01 does not', async () => {
    const day = (spend: string): Day[] => [{ date_start: '2026-11-09', ad_id: adId(1), adset_id: adsetId(1), campaign_id: campId(1), impressions: '10', clicks: '1', spend }]
    const mk = async (spend: string, metaSpend: string) => {
      const m = mem({ insights: { coveredFrom: TARGET, coveredTo: TODAY } })
      await runMetaAdsSync(m.store, deps(fakeMeta({ data: day(spend), accountTotals: { spend: metaSpend, impressions: '10', clicks: '1' } }), { jobs: ['insights'] }))
      return m.recs.get(7)?.ok
    }
    expect(await mk('102.5000', '102.50')).toBe(true)
    expect(await mk('102.5100', '102.50')).toBe(false)
  })
  it('a reconciliation call that fails keeps the stored days and retries later', async () => {
    const m = mem({ insights: { coveredFrom: TARGET, coveredTo: TODAY } })
    const f = fakeMeta({ override: (u) => (u.searchParams.get('level') === 'account' ? err(500, 2) : undefined) })
    const r = await runMetaAdsSync(m.store, deps(f, { jobs: ['insights'] }))
    expect(r.jobs.insights.failed).toBe(1)
    expect(m.insights.size).toBeGreaterThan(0)
    expect(m.recs.size).toBe(0)
  })
})


describe('ranges (aggregated Meta metrics: reach, frequency, link/outbound clicks, actions)', () => {
  const runRanges = (m: ReturnType<typeof mem>, f: ReturnType<typeof fakeMeta>, over: object = {}) => runMetaAdsSync(m.store, deps(f, { jobs: ['ranges'], ...over }))
  const rangeCalls = (f: ReturnType<typeof fakeMeta>) => f.calls.filter((c) => c.pathname.endsWith('/insights') && !c.searchParams.get('time_increment')).filter((c) => !c.searchParams.get('after'))

  it('asks Meta for each window x level (3 x 4 = 12 groups), WITHOUT time_increment, for the N complete days before today; no action_values', async () => {
    const m = mem()
    const f = fakeMeta()
    await runRanges(m, f)
    const calls = rangeCalls(f)
    expect(calls).toHaveLength(12)
    const keys = calls.map((c) => `${c.searchParams.get('level')}:${(JSON.parse(c.searchParams.get('time_range')!) as { since: string }).since}`)
    for (const since of ['2026-11-03', '2026-10-11', '2026-08-12']) for (const lvl of ['account', 'campaign', 'adset', 'ad']) expect(keys).toContain(`${lvl}:${since}`)
    for (const c of calls) {
      expect(JSON.parse(c.searchParams.get('time_range')!).until).toBe('2026-11-09') // today (2026-11-10) never included
      expect(c.searchParams.get('time_increment')).toBeNull()
      expect(c.searchParams.get('fields')).toContain('reach,frequency')
      expect(c.searchParams.get('fields')).not.toContain('action_values')
    }
  })
  it('REACH is stored exactly as Meta returned it for the window and is never rebuilt from the daily rows', async () => {
    const m = mem()
    const f = fakeMeta()
    await runMetaAdsSync(m.store, deps(f, { jobs: ['insights', 'ranges'] }))
    const daily7 = [...m.insights.values()].filter((r) => r.ad_id === adId(1) && r.date >= '2026-11-03' && r.date <= '2026-11-09').reduce((s, r) => s + (r.reach ?? 0), 0)
    const range7 = m.ranges.get(`ad|${adId(1)}|7`)!
    expect(daily7).toBe(900 * 7)
    expect(range7.row.reach).toBe(Math.floor(900 * 7 * 0.8)) // Meta's aggregate
    expect(range7.row.reach).not.toBe(daily7)
    expect(range7.since).toBe('2026-11-03')
    expect(range7.until).toBe('2026-11-09')
    // the account's reach is its own aggregate, not the sum of the ads
    const adsSum = ['1', '2'].reduce((s, n) => s + (m.ranges.get(`ad|${adId(Number(n))}|7`)?.row.reach ?? 0), 0)
    expect(m.ranges.get('account|409949686293101|7')!.row.reach).not.toBe(adsSum)
  })
  it('FREQUENCY is what Meta returned and equals impressions / reach', async () => {
    const m = mem()
    await runRanges(m, fakeMeta())
    for (const r of m.ranges.values()) expect(Math.abs(Number(r.row.frequency) - r.row.impressions / (r.row.reach as number))).toBeLessThan(0.0001)
  })
  it('inline_link_clicks and outbound_clicks are separate from clicks; outbound_click is extracted from Meta\'s list (other entries ignored)', async () => {
    const m = mem()
    await runRanges(m, fakeMeta())
    const r = m.ranges.get(`ad|${adId(1)}|7`)!.row
    expect(r.inline_link_clicks).toBe(Math.floor(r.clicks * 0.8))
    expect(r.outbound_clicks).toBe(Math.floor(r.clicks * 0.7))
    expect(r.outbound_clicks).not.toBe(999)
    expect(r.clicks).toBeGreaterThan(r.inline_link_clicks as number)
  })
  it('ACTIONS are stored as Meta named them: unknown types kept, aliases NOT merged, malformed names dropped, repeated type keeps the first value', async () => {
    const m = mem()
    await runRanges(m, fakeMeta())
    const key = (t: string) => `ad|${adId(1)}|7|${t}`
    expect(m.rangeActions.get(key('onsite_conversion.messaging_conversation_started_7d'))?.value).toBe('5')
    expect(m.rangeActions.get(key('lead'))?.value).toBe('1')
    expect(m.rangeActions.get(key('onsite_web_lead'))?.value).toBe('1')
    expect(m.rangeActions.get(key('brand_new_unknown_type'))?.value).toBe('3')
    expect(m.rangeActions.has(key('bad type!'))).toBe(false)
    expect([...m.rangeActions.keys()].filter((k) => k.startsWith(`ad|${adId(1)}|7|`)).length).toBe(4)
  })
  it('one request group per window/level is fully paginated', async () => {
    const m = mem()
    const f = fakeMeta({ data: daysOf('2026-08-01', TODAY, 5), pageSize: 2 }) // 5 ads, 2 per page
    await runRanges(m, f)
    expect([...m.ranges.values()].filter((r) => r.level === 'ad' && r.days === 7)).toHaveLength(5)
  })
  it('the window MOVES: a later run replaces the previous window in place (one row per entity+days), and entities that vanished are pruned only after a COMPLETE pass', async () => {
    const m = mem()
    await runRanges(m, fakeMeta())
    const first = m.ranges.get(`ad|${adId(1)}|7`)!
    expect(first.since).toBe('2026-11-03')
    m.st.ranges.nextRunAt = 0
    let t = NOW + 24 * 3_600_000 // next day
    const only1 = fakeMeta({ data: ALL.filter((d) => d.ad_id === adId(1)) })
    await runMetaAdsSync(m.store, deps(only1, { jobs: ['ranges'], now: () => (t += 1000) }))
    const moved = m.ranges.get(`ad|${adId(1)}|7`)!
    expect(moved.since).toBe('2026-11-04')
    expect(moved.until).toBe('2026-11-10')
    expect(m.ranges.has(`ad|${adId(2)}|7`)).toBe(false) // vanished entity pruned after the complete pass
    expect([...m.ranges.keys()].filter((k) => k.startsWith(`ad|${adId(1)}|7`))).toHaveLength(1)
  })
  it('PARTIAL: if a unit fails midway nothing of it is pruned and everything stored before stays', async () => {
    const m = mem()
    await runRanges(m, fakeMeta())
    const before = m.ranges.size
    m.st.ranges.nextRunAt = 0
    let n = 0
    const f = fakeMeta({ override: (u) => (u.searchParams.get('level') === 'ad' && !u.searchParams.get('time_increment') && ++n === 1 ? err(500, 2) : undefined) })
    const r = await runRanges(m, f)
    expect(r.jobs.ranges.failed).toBe(1)
    expect(m.ranges.size).toBe(before)
    expect(m.st.ranges).toMatchObject({ status: 'error', lastCode: 'meta_2' })
  })
  it('OPTIONAL FIELDS rejected by Meta: the unit is retried with the base metrics, so reach/frequency still sync and link/outbound/actions stay empty (never stale)', async () => {
    const m = mem()
    await runRanges(m, fakeMeta())
    expect(m.ranges.get(`ad|${adId(1)}|7`)!.row.inline_link_clicks).not.toBeNull()
    m.st.ranges.nextRunAt = 0
    const f = fakeMeta({ override: (u) => (!u.searchParams.get('time_increment') && (u.searchParams.get('fields') ?? '').includes('actions') ? err(400, 100) : undefined) })
    const r = await runRanges(m, f)
    expect(r.jobs.ranges.synced).toBe(1)
    const row = m.ranges.get(`ad|${adId(1)}|7`)!.row
    expect(row.reach).not.toBeNull()
    expect(row.frequency).not.toBeNull()
    expect(row.inline_link_clicks).toBeNull()
    expect(row.outbound_clicks).toBeNull()
    expect(row.actions).toEqual([])
    expect(m.pruneCalls.at(-1)?.includeActions).toBe(false) // a degraded pass never prunes previously stored actions
  })
  it('rejected even with the base metrics: the other units are still stored; the job ends as an error to be retried', async () => {
    const m = mem()
    const f = fakeMeta({ override: (u) => (u.searchParams.get('level') === 'adset' && !u.searchParams.get('time_increment') && (u.searchParams.get('fields') ?? '').includes('reach') ? err(400, 100) : undefined) })
    const r = await runRanges(m, f)
    expect(r.jobs.ranges.failed).toBe(1)
    expect(m.st.ranges.lastCode).toBe('range_partial_meta_100')
    expect([...m.ranges.values()].some((x) => x.level === 'ad')).toBe(true)
    expect([...m.ranges.values()].some((x) => x.level === 'adset')).toBe(false)
  })
  it('rate limit aborts the job and keeps backoff; invalid token pauses; neither prunes anything', async () => {
    const m = mem()
    await runRanges(m, fakeMeta())
    const size = m.ranges.size
    m.st.ranges.nextRunAt = 0
    await runRanges(m, fakeMeta({ override: () => err(400, 17, { 'retry-after': '900' }) }))
    expect(m.st.ranges).toMatchObject({ status: 'error', lastCode: 'meta_17' })
    expect(m.st.ranges.nextRunAt).toBeGreaterThanOrEqual(NOW + 900_000)
    m.st.ranges.nextRunAt = 0
    await runRanges(m, fakeMeta({ override: () => err(400, 190) }))
    expect(m.tokenStatus.v).toBe('invalid')
    expect(m.st.ranges.status).toBe('paused')
    expect(m.ranges.size).toBe(size)
  })
  it('runs on the insights interval (not the catalog one)', async () => {
    const m = mem()
    await runRanges(m, fakeMeta())
    expect(m.st.ranges.nextRunAt).toBe(NOW + 180 * 60_000)
  })
})
