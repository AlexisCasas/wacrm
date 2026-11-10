import {
  fetchAccountTotals, fetchAdsetsPage, fetchCampaignsPage, fetchCatalogPage, fetchInsightsPage, fetchRangePage,
  type AccountTotals, type InsightRow, type ListPageOutcome, type MetaAd, type MetaAdset, type MetaCampaign, type RangeLevel, type RangeRow, type RangeVariant,
} from './client'

// Meta Ads sync engine: catalog (ads), ad sets, campaigns and DAILY INSIGHTS (level=ad, time_increment=1) + reconciliation against Meta's account totals.
// Fully decoupled from the webhook, the inbox, flows and the sales/attribution logic: it only reads meta_ads_settings and writes the meta_ads_* tables.
// Global switch: META_ADS_ENABLED=true. Per-account switch: meta_ads_settings.enabled (OFF by default). Any failure stays inside this module.
// Every pass is fully paginated and upserted idempotently. Nothing valid is ever deleted: an error leaves the cached data exactly as it was.

export type Job = 'campaigns' | 'adsets' | 'catalog' | 'insights' | 'ranges'
export const JOBS: Job[] = ['campaigns', 'adsets', 'catalog', 'insights', 'ranges']
export const RANGE_DAYS = [7, 30, 90] as const
export const RANGE_LEVELS: RangeLevel[] = ['account', 'campaign', 'adset', 'ad']
export const MAX_PAGES = 100
export const RUN_BUDGET_MS = 90_000
export const LEASE_SECONDS = 300
export const BACKFILL_DAYS = 90
export const CHUNK_DAYS = 7
export const REFRESH_DAYS = 3
export const MAX_CHUNKS_PER_RUN = 6
export const BACKFILL_NEXT_RUN_MS = 3 * 60_000
export const RECONCILE_EVERY_MS = 20 * 3_600_000
export const RECONCILE_WINDOWS = [7, 30, 90] as const

export interface SyncAccount {
  account_id: string
  ad_account_id: string
  access_token_enc: string
  api_version: string
  currency: string
  account_timezone: string
  catalog_interval_minutes: number
  insights_interval_minutes: number
}
export interface Coverage { coveredFrom: string | null; coveredTo: string | null }
export interface Reconciliation {
  windowDays: number
  dateFrom: string
  dateTo: string
  local: { spend: string; impressions: number; clicks: number }
  meta: AccountTotals
  ok: boolean
}

export interface SyncStore {
  listAccounts(): Promise<SyncAccount[]>
  ensureState(accountId: string, job: Job): Promise<void>
  /** Atomic: only one runner gets the lease, and only when the job is due and not paused. */
  claim(accountId: string, job: Job, nowIso: string, leaseUntilIso: string): Promise<{ claimed: boolean; failures: number } & Coverage>
  upsertAds(accountId: string, ads: MetaAd[], nowIso: string): Promise<void>
  upsertAdsets(accountId: string, rows: MetaAdset[], nowIso: string): Promise<void>
  upsertCampaigns(accountId: string, rows: MetaCampaign[], nowIso: string): Promise<void>
  upsertInsights(accountId: string, rows: InsightRow[], currency: string, nowIso: string): Promise<void>
  /** Stores Meta's aggregated window for each entity (+ its actions). One row per (account, level, entity, days): a new window REPLACES the previous one. */
  upsertRange(accountId: string, level: RangeLevel, days: number, since: string, until: string, rows: RangeRow[], currency: string, nowIso: string): Promise<void>
  /** Called ONLY after a unit finished all its pages: removes what that pass did not refresh (entities that disappeared; action types only when the pass fetched actions). */
  pruneRange(accountId: string, level: RangeLevel, days: number, beforeIso: string, includeActions: boolean): Promise<void>
  finishOk(accountId: string, job: Job, v: { nowIso: string; nextRunAtIso: string; rows: number; pages: number } & Partial<Coverage>): Promise<void>
  finishError(accountId: string, job: Job, v: { nowIso: string; nextRunAtIso: string; failures: number; code: string; paused: boolean } & Partial<Coverage>): Promise<void>
  setTokenStatus(accountId: string, status: 'valid' | 'invalid', nowIso: string): Promise<void>
  localTotals(accountId: string, since: string, until: string): Promise<{ spend: string; impressions: number; clicks: number }>
  /** window_days -> checked_at of the latest reconciliation of each window. */
  reconciledAt(accountId: string): Promise<Partial<Record<number, string>>>
  saveReconciliation(accountId: string, rec: Reconciliation, nowIso: string): Promise<void>
}

export interface JobSummary { synced: number; skipped: number; failed: number; rows: number }
export interface SyncRunResult {
  enabled: boolean
  accounts: number
  synced: number
  skipped: number
  failed: number
  rows: number
  jobs: Record<Job, JobSummary>
}

export function metaAdsGloballyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.META_ADS_ENABLED === 'true'
}

/** Exponential backoff from 5 minutes, capped at 6 hours, never sooner than Meta asked. */
export function retryDelayMs(failures: number, retryAfterMs?: number, random: () => number = Math.random): number {
  const base = Math.min(5 * 60_000 * 2 ** Math.max(failures - 1, 0), 6 * 3_600_000)
  return Math.max(Math.round(base * (0.8 + random() * 0.4)), retryAfterMs ?? 0)
}

// ---- dates (Meta dates are calendar days in the ad account's timezone) ----------------------------------------------------------------------
export function dateInTz(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
}
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

class JobFailure extends Error {
  constructor(readonly code: string, readonly kind: 'auth' | 'retry' | 'rejected' | 'internal', readonly retryAfterMs?: number, readonly progress?: Partial<Coverage>) {
    super(code)
  }
}
interface Ctx {
  acct: SyncAccount
  token: string
  store: SyncStore
  fetchImpl?: typeof fetch
  now: () => number
  startedMs: number
  claim: { failures: number } & Coverage
  nowIso: () => string
}
interface JobDone { rows: number; pages: number; nextRunInMs?: number; coverage?: Partial<Coverage> }

const overBudget = (c: Ctx) => c.now() - c.startedMs > RUN_BUDGET_MS

/** Walks a paginated list to its LAST page. Throws JobFailure on any Meta error, cursor loop, page cap or time budget. */
async function paginate<T>(
  c: Ctx,
  fetchPage: (after: string | null) => Promise<ListPageOutcome<T>>,
  keyOf: (t: T) => string,
  onItems: (items: T[]) => Promise<void>,
  progress?: () => Partial<Coverage>,
): Promise<{ rows: number; pages: number }> {
  let after: string | null = null
  const cursors = new Set<string>()
  const seen = new Set<string>()
  let pages = 0
  while (true) {
    if (pages >= MAX_PAGES) throw new JobFailure('max_pages', 'internal', undefined, progress?.())
    if (overBudget(c)) throw new JobFailure('time_budget', 'internal', undefined, progress?.())
    let out: ListPageOutcome<T>
    try {
      out = await fetchPage(after)
    } catch {
      out = { kind: 'retry', httpStatus: null, code: 'unexpected' }
    }
    if (out.kind === 'auth') throw new JobFailure(out.code, 'auth', undefined, progress?.())
    if (out.kind === 'retry') throw new JobFailure(out.code, 'retry', out.retryAfterMs, progress?.())
    if (out.kind === 'rejected') throw new JobFailure(out.code, 'rejected', 3_600_000, progress?.())
    pages++
    const fresh = out.items.filter((t) => {
      const k = keyOf(t)
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    await onItems(fresh)
    if (!out.after) return { rows: seen.size, pages }
    if (cursors.has(out.after)) throw new JobFailure('cursor_loop', 'internal', undefined, progress?.())
    cursors.add(out.after)
    after = out.after
  }
}

const edge = (c: Ctx) => ({ apiVersion: c.acct.api_version, adAccountId: c.acct.ad_account_id })

async function runCatalog(c: Ctx): Promise<JobDone> {
  const page = async (after: string | null): Promise<ListPageOutcome<MetaAd>> => {
    const o = await fetchCatalogPage({ ...edge(c), after }, c.token, c.fetchImpl)
    return o.kind === 'ok' ? { kind: 'ok', items: o.ads, after: o.after } : o
  }
  return paginate<MetaAd>(c, page, (a) => a.ad_id, (items) => c.store.upsertAds(c.acct.account_id, items, c.nowIso()))
}
async function runAdsets(c: Ctx): Promise<JobDone> {
  return paginate(c, (after) => fetchAdsetsPage({ ...edge(c), after }, c.token, c.fetchImpl), (a) => a.adset_id, (items) => c.store.upsertAdsets(c.acct.account_id, items, c.nowIso()))
}
async function runCampaigns(c: Ctx): Promise<JobDone> {
  return paginate(c, (after) => fetchCampaignsPage({ ...edge(c), after }, c.token, c.fetchImpl), (a) => a.campaign_id, (items) => c.store.upsertCampaigns(c.acct.account_id, items, c.nowIso()))
}

const cents = (v: string | number) => Math.round(Number(v) * 100)

/**
 * Insights: first run = newest 7 days, then BACKFILL downwards in 7-day blocks to 90 days (resumable: coverage is saved after every block);
 * maintenance = re-fetch the last 3 days + today every run (Meta restates recent days), filling any gap since the last run. Then reconciliation.
 */
async function runInsights(c: Ctx): Promise<JobDone> {
  const { acct } = c
  const today = dateInTz(c.now(), acct.account_timezone)
  const target = addDays(today, -BACKFILL_DAYS)
  let from = c.claim.coveredFrom
  let to = c.claim.coveredTo
  let pages = 0
  let rows = 0
  const cov = (): Partial<Coverage> => ({ coveredFrom: from, coveredTo: to })

  const fetchRange = async (since: string, until: string) => {
    const r = await paginate(
      c,
      (after) => fetchInsightsPage({ ...edge(c), since, until, after }, c.token, c.fetchImpl),
      (i) => `${i.ad_id}|${i.date}`,
      (items) => c.store.upsertInsights(acct.account_id, items, acct.currency, c.nowIso()),
      cov,
    )
    pages += r.pages
    rows += r.rows
  }

  // 1) maintenance / first block: oldest -> newest so coverage stays contiguous.
  const maintStart = from && to ? addDays(to < today ? to : today, -REFRESH_DAYS) : addDays(today, -(CHUNK_DAYS - 1))
  for (let s = maintStart; s <= today; ) {
    const e = addDays(s, CHUNK_DAYS - 1) < today ? addDays(s, CHUNK_DAYS - 1) : today
    await fetchRange(s, e)
    from = from && from < s ? from : s
    to = to && to > e ? to : e
    s = addDays(e, 1)
  }

  // 2) backfill downwards, newest -> oldest, as far as this run's budget allows.
  let chunks = 0
  while (from && from > target && chunks < MAX_CHUNKS_PER_RUN && !overBudget(c)) {
    const s = addDays(from, -CHUNK_DAYS) > target ? addDays(from, -CHUNK_DAYS) : target
    await fetchRange(s, addDays(from, -1))
    from = s
    chunks++
  }
  const backfillPending = !!from && from > target

  // 3) reconciliation of the windows already covered (each window as soon as it is fully stored, then about once a day).
  if (!overBudget(c)) await reconcile(c, today, from, to, cov)

  return { rows, pages, coverage: cov(), nextRunInMs: backfillPending ? BACKFILL_NEXT_RUN_MS : undefined }
}

async function reconcile(c: Ctx, today: string, from: string | null, to: string | null, cov: () => Partial<Coverage>) {
  if (!from || !to) return
  const done = await c.store.reconciledAt(c.acct.account_id)
  for (const n of RECONCILE_WINDOWS) {
    const since = addDays(today, -n)
    const until = addDays(today, -1)
    if (from > since || to < until) continue // window not fully stored yet
    const prev = done[n]
    if (prev && c.now() - Date.parse(prev) < RECONCILE_EVERY_MS) continue // each window: when it first becomes complete, then about once a day
    const meta = await fetchAccountTotals({ ...edge(c), since, until }, c.token, c.fetchImpl)
    if (meta.kind === 'auth') throw new JobFailure(meta.code, 'auth', undefined, cov())
    if (meta.kind === 'retry') throw new JobFailure(meta.code, 'retry', meta.retryAfterMs, cov())
    if (meta.kind === 'rejected') throw new JobFailure(meta.code, 'rejected', 3_600_000, cov())
    const local = await c.store.localTotals(c.acct.account_id, since, until)
    // Equality is expected: spend to the cent, impressions and clicks exactly. A difference is recorded (ok=false), never hidden.
    const ok = cents(local.spend) === cents(meta.totals.spend) && local.impressions === meta.totals.impressions && local.clicks === meta.totals.clicks
    await c.store.saveReconciliation(c.acct.account_id, { windowDays: n, dateFrom: since, dateTo: until, local, meta: meta.totals, ok }, c.nowIso())
  }
}

/**
 * Ranges: Meta's AGGREGATED numbers for the 7/30/90 complete days before today (reach and frequency are not additive, so they are never rebuilt from the daily rows),
 * per level (account, campaign, adset, ad), one request group per (window, level): 12 groups, fully paginated, upserted idempotently.
 * If Meta rejects the optional fields (actions / link / outbound clicks) the unit is retried with the base metrics only, so reach/frequency still sync.
 * A unit that is rejected even then does not stop the others; the job then ends as an error (data stored so far stays) and is retried later.
 */
async function runRanges(c: Ctx): Promise<JobDone> {
  const { acct } = c
  const today = dateInTz(c.now(), acct.account_timezone)
  let rows = 0
  let pages = 0
  let rejectedCode: string | null = null
  for (const days of RANGE_DAYS) {
    const since = addDays(today, -days)
    const until = addDays(today, -1)
    for (const level of RANGE_LEVELS) {
      const unitStart = c.nowIso()
      const attempt = async (variant: RangeVariant) => {
        const seen = new Set<string>()
        const r = await paginate<RangeRow>(
          c,
          (after) => fetchRangePage({ ...edge(c), level, since, until, variant, after }, c.token, c.fetchImpl),
          (x) => x.entity_id,
          async (items) => {
            for (const it of items) seen.add(it.entity_id)
            await c.store.upsertRange(acct.account_id, level, days, since, until, variant === 'full' ? items : items.map((i) => ({ ...i, inline_link_clicks: null, outbound_clicks: null, actions: [] })), acct.currency, c.nowIso())
          },
        )
        pages += r.pages
        rows += r.rows
        await c.store.pruneRange(acct.account_id, level, days, unitStart, variant === 'full')
      }
      try {
        await attempt('full')
      } catch (e) {
        if (!(e instanceof JobFailure) || e.kind !== 'rejected') throw e // auth / rate limit / outage abort the job (handled by the engine)
        try {
          await attempt('base')
        } catch (e2) {
          if (!(e2 instanceof JobFailure) || e2.kind !== 'rejected') throw e2
          rejectedCode = e2.code
        }
      }
    }
  }
  if (rejectedCode) throw new JobFailure(`range_partial_${rejectedCode}`, 'rejected', 3_600_000)
  return { rows, pages }
}

const RUNNERS: Record<Job, (c: Ctx) => Promise<JobDone>> = { campaigns: runCampaigns, adsets: runAdsets, catalog: runCatalog, insights: runInsights, ranges: runRanges }

type JobOutcome = { kind: 'synced'; rows: number } | { kind: 'skipped' } | { kind: 'failed'; stopAccount: boolean }

async function runJob(
  store: SyncStore,
  acct: SyncAccount,
  job: Job,
  deps: { fetchImpl?: typeof fetch; decryptToken: (enc: string) => string; now: () => number; random?: () => number },
): Promise<JobOutcome> {
  const startedMs = deps.now()
  const nowIso = () => new Date(deps.now()).toISOString()
  await store.ensureState(acct.account_id, job)
  const claim = await store.claim(acct.account_id, job, new Date(startedMs).toISOString(), new Date(startedMs + LEASE_SECONDS * 1000).toISOString())
  if (!claim.claimed) return { kind: 'skipped' }

  const fail = async (code: string, retryAfterMs?: number, forcePause = false, progress?: Partial<Coverage>): Promise<JobOutcome> => {
    const failures = claim.failures + 1
    await store.finishError(acct.account_id, job, {
      nowIso: nowIso(), nextRunAtIso: new Date(deps.now() + retryDelayMs(failures, retryAfterMs, deps.random)).toISOString(), failures, code, paused: forcePause, ...progress,
    })
    return { kind: 'failed', stopAccount: forcePause }
  }

  let token: string
  try {
    token = deps.decryptToken(acct.access_token_enc)
  } catch {
    await store.setTokenStatus(acct.account_id, 'invalid', nowIso())
    return fail('token_unreadable', undefined, true)
  }

  const ctx: Ctx = { acct, token, store, fetchImpl: deps.fetchImpl, now: deps.now, startedMs, claim, nowIso }
  try {
    const done = await RUNNERS[job](ctx)
    // A full pass finished: only now is the data "synced", and only now is the token known to be good.
    await store.setTokenStatus(acct.account_id, 'valid', nowIso())
    const interval = (job === 'insights' || job === 'ranges' ? acct.insights_interval_minutes : acct.catalog_interval_minutes) * 60_000
    await store.finishOk(acct.account_id, job, { nowIso: nowIso(), nextRunAtIso: new Date(deps.now() + (done.nextRunInMs ?? interval)).toISOString(), rows: done.rows, pages: done.pages, ...done.coverage })
    return { kind: 'synced', rows: done.rows }
  } catch (e) {
    if (!(e instanceof JobFailure)) throw e
    if (e.kind === 'auth') {
      await store.setTokenStatus(acct.account_id, 'invalid', nowIso())
      return fail(e.code, undefined, true, e.progress)
    }
    const o = await fail(e.code, e.retryAfterMs, false, e.progress)
    // Rate limits / outages: do not keep hitting Meta with the account's other jobs in this run. A rejected request (bad endpoint/params) is job-specific.
    return { kind: 'failed', stopAccount: e.kind === 'retry' && o.kind === 'failed' }
  }
}

export async function runMetaAdsSync(
  store: SyncStore,
  opts: { enabled?: boolean; fetchImpl?: typeof fetch; decryptToken?: (enc: string) => string; now?: () => number; random?: () => number; jobs?: Job[] } = {},
): Promise<SyncRunResult> {
  const zero = (): JobSummary => ({ synced: 0, skipped: 0, failed: 0, rows: 0 })
  const result: SyncRunResult = { enabled: opts.enabled ?? metaAdsGloballyEnabled(), accounts: 0, synced: 0, skipped: 0, failed: 0, rows: 0, jobs: { campaigns: zero(), adsets: zero(), catalog: zero(), insights: zero(), ranges: zero() } }
  if (!result.enabled) return result // global switch off: nothing is read and nothing is called
  const decryptToken = opts.decryptToken ?? (await import('@/lib/whatsapp/encryption')).decrypt
  const now = opts.now ?? Date.now

  for (const acct of await store.listAccounts()) {
    result.accounts++
    for (const job of opts.jobs ?? JOBS) {
      try {
        const o = await runJob(store, acct, job, { fetchImpl: opts.fetchImpl, decryptToken, now, random: opts.random })
        const s = result.jobs[job]
        if (o.kind === 'synced') { s.synced++; s.rows += o.rows; result.synced++; result.rows += o.rows }
        else if (o.kind === 'skipped') { s.skipped++; result.skipped++ }
        else { s.failed++; result.failed++; if (o.stopAccount) break }
      } catch (error) {
        // One job/account never blocks the rest; only the error name is logged (no messages, which could carry request details).
        result.jobs[job].failed++
        result.failed++
        console.error('[meta-ads-sync] job error:', job, error instanceof Error ? error.name : 'unknown')
      }
    }
  }
  return result
}
