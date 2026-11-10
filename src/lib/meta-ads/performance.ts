import { addDays, dateInTz } from './sync'

// Read model for the "Rendimiento Meta Ads" section. Every figure comes from the cached Meta insights (meta_ads_insights_daily) via meta_ads_performance;
// nothing here uses WACRM timestamps, orders or attribution. Ratios are derived from the TOTALS of each row (never an average of daily ratios).
// Reach is intentionally absent: it is not additive, so no sum of daily reach is ever shown.

export const META_DAYS = [7, 30, 90] as const
export type MetaDays = (typeof META_DAYS)[number]

/** The N complete Meta days before today (the ad account's calendar), like Meta's own last_Nd presets: [today-N, today-1]. Today is partial, so it is excluded. */
export function metaWindow(days: number, timeZone: string, nowMs: number): { since: string; until: string } {
  const today = dateInTz(nowMs, timeZone)
  return { since: addDays(today, -days), until: addDays(today, -1) }
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000
export interface Ratios { ctr: number | null; cpc: number | null; cpm: number | null }
/** CTR = clicks / impressions * 100, CPC = spend / clicks, CPM = spend / impressions * 1000. A zero denominator gives null (the UI shows "—"), never NaN/Infinity. */
export function ratios(t: { spend: number; impressions: number; clicks: number }): Ratios {
  return {
    ctr: t.impressions > 0 ? r4((t.clicks / t.impressions) * 100) : null,
    cpc: t.clicks > 0 ? r4(t.spend / t.clicks) : null,
    cpm: t.impressions > 0 ? r4((t.spend / t.impressions) * 1000) : null,
  }
}

export interface PerfMetrics extends Ratios { spend: number; impressions: number; clicks: number }
export interface PerfRow extends PerfMetrics {
  /** Meta id (campaign_id / adset_id / ad_id depending on the view): the technical key. Names are display only. */
  id: string
  name: string | null
  status: string | null
  campaign_id: string | null
  campaign_name: string | null
  adset_id: string | null
  adset_name: string | null
}

const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}
const txt = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null)
const money2 = (n: number) => Math.round(n * 100) / 100

export function metrics(spend: number, impressions: number, clicks: number): PerfMetrics {
  const s = money2(spend)
  return { spend: s, impressions, clicks, ...ratios({ spend, impressions, clicks }) }
}

/** Rows of meta_ads_performance for one level, biggest spend first (ties by id). Rows without a valid id are dropped. */
export function buildPerfRows(rows: unknown[] | null | undefined): PerfRow[] {
  if (!Array.isArray(rows)) return []
  const out: PerfRow[] = []
  for (const r of rows) {
    const x = r as Record<string, unknown>
    const id = txt(x.id)
    if (!id) continue
    out.push({
      id, name: txt(x.name), status: txt(x.status),
      campaign_id: txt(x.campaign_id), campaign_name: txt(x.campaign_name), adset_id: txt(x.adset_id), adset_name: txt(x.adset_name),
      ...metrics(num(x.spend), num(x.impressions), num(x.clicks)),
    })
  }
  return out.sort((a, b) => b.spend - a.spend || a.id.localeCompare(b.id))
}

/** Totals over the rows of ONE level (campaigns, ad sets and ads all add up to the same totals). Ratios are recomputed from the sums. */
export function sumTotals(rows: PerfRow[]): PerfMetrics {
  let spend = 0
  let impressions = 0
  let clicks = 0
  for (const r of rows) {
    spend += r.spend
    impressions += r.impressions
    clicks += r.clicks
  }
  return metrics(spend, impressions, clicks)
}

export type SyncState = 'ok' | 'syncing' | 'error' | 'paused' | 'pending'
export interface MetaPerformanceAvailable {
  available: true
  period: { days: number; since: string; until: string; timezone: string; currency: string }
  /** Last completed insights pass. */
  synced_at: string
  sync: { state: SyncState; covered_from: string | null; covered_to: string | null; /** the stored days do not yet cover the whole period */ partial: boolean }
  reconciliation: { ok: boolean; checked_at: string; date_from: string; date_to: string } | null
  totals: PerfMetrics
  campaigns: PerfRow[]
  adsets: PerfRow[]
  ads: PerfRow[]
}
export type MetaPerformance = MetaPerformanceAvailable | { available: false; reason: 'not_configured' | 'not_synced' | 'unavailable' }

export function syncState(row: { status?: string | null; last_success_at?: string | null }, partial: boolean): SyncState {
  if (row.status === 'paused') return 'paused'
  if (row.status === 'error') return 'error'
  if (!row.last_success_at) return 'pending'
  return partial ? 'syncing' : 'ok'
}
