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
/** Meta-reported messaging results (action_types confirmed by the live audit). They are Meta's numbers, NOT WACRM contacts, leads, buyers or orders. */
export const MESSAGING_ACTION_TYPES = {
  conversations_started: 'onsite_conversion.messaging_conversation_started_7d',
  connections: 'onsite_conversion.total_messaging_connection',
  first_replies: 'onsite_conversion.messaging_first_reply',
  depth_2: 'onsite_conversion.messaging_user_depth_2_message_send',
  depth_3: 'onsite_conversion.messaging_user_depth_3_message_send',
} as const
export type MessagingKey = keyof typeof MESSAGING_ACTION_TYPES
export const MESSAGING_LABELS: Record<MessagingKey, string> = {
  conversations_started: 'Conversaciones iniciadas (Meta)',
  connections: 'Conexiones de mensajería (Meta)',
  first_replies: 'Primeras respuestas (Meta)',
  depth_2: 'Llegaron a 2 mensajes (Meta)',
  depth_3: 'Llegaron a 3 mensajes (Meta)',
}
export const MESSAGING_TOOLTIP = 'Resultado atribuido por Meta Ads. No equivale a contactos únicos de WACRM.'
const MESSAGING_BY_TYPE = new Map<string, MessagingKey>(Object.entries(MESSAGING_ACTION_TYPES).map(([k, t]) => [t, k as MessagingKey]))

/** Human descriptions for the action_types seen in the live audit. Anything else is shown with its technical name only (never guessed). */
export const ACTION_DESCRIPTIONS: Record<string, string> = {
  link_click: 'Clics en enlace (acción link_click)',
  video_view: 'Reproducciones de video',
  view_content: 'Vistas de contenido',
  post_engagement: 'Interacciones con la publicación',
  post_reaction: 'Reacciones',
  comment: 'Comentarios',
  post: 'Veces compartido',
  'onsite_conversion.post_save': 'Guardados',
  landing_page_view: 'Vistas de la página de destino',
  lead: 'Lead (lead)',
  'onsite_conversion.lead_grouped': 'Leads agrupados (onsite_conversion.lead_grouped)',
  onsite_web_lead: 'Lead web onsite (onsite_web_lead)',
}
/** Lead-like action types can describe the SAME event under several names: they are listed one by one and NEVER added together. */
export const isLeadAlias = (actionType: string) => /lead/i.test(actionType)

export interface OtherResult { action_type: string; description: string; value: number; lead_alias: boolean }
export interface ExtMetrics {
  /** Meta's aggregated reach for the whole window (never a sum of daily reach). null = Meta did not return it. */
  reach: number | null
  frequency: number | null
  link_clicks: number | null
  outbound_clicks: number | null
  messaging: Record<MessagingKey, number | null>
  other_results: OtherResult[]
}
/** Secondary catalog details (expandable row). Budgets are Meta minor currency units. */
export interface PerfDetail {
  objective?: string | null
  buying_type?: string | null
  optimization_goal?: string | null
  billing_event?: string | null
  bid_strategy?: string | null
  daily_budget?: number | null
  lifetime_budget?: number | null
  start_time?: string | null
  stop_time?: string | null
  end_time?: string | null
  created_time?: string | null
  updated_time?: string | null
}

export interface PerfRow extends PerfMetrics {
  /** Aggregated Meta metrics of the window. undefined = the extended cache is not available (checkpoint behaviour); null = available but none for this entity. */
  ext?: ExtMetrics | null
  detail?: PerfDetail | null
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

const nOrNull = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** One row of meta_ads_range_metrics -> what the UI shows. Nothing is summed here: reach / frequency / link / outbound come straight from Meta's window. */
export function buildExt(raw: unknown, impressions: number): ExtMetrics {
  const x = (raw ?? {}) as Record<string, unknown>
  const reach = nOrNull(x.reach)
  let frequency = nOrNull(x.frequency)
  if (frequency === null && reach !== null && reach > 0) frequency = r4(impressions / reach)
  const actions = x.actions && typeof x.actions === 'object' && !Array.isArray(x.actions) ? (x.actions as Record<string, unknown>) : {}
  const messaging: Record<MessagingKey, number | null> = { conversations_started: null, connections: null, first_replies: null, depth_2: null, depth_3: null }
  const other: OtherResult[] = []
  for (const [type, value] of Object.entries(actions)) {
    const v = nOrNull(value)
    if (v === null) continue
    const key = MESSAGING_BY_TYPE.get(type)
    if (key) messaging[key] = v
    else other.push({ action_type: type, description: ACTION_DESCRIPTIONS[type] ?? 'Otro resultado reportado por Meta', value: v, lead_alias: isLeadAlias(type) })
  }
  other.sort((a, b) => b.value - a.value || a.action_type.localeCompare(b.action_type))
  return { reach, frequency, link_clicks: nOrNull(x.inline_link_clicks), outbound_clicks: nOrNull(x.outbound_clicks), messaging, other_results: other }
}

/** Attaches the aggregated metrics to rows by Meta id. A row without a range entry gets ext = null ("—"), never a derived value. */
export function mergeRange(rows: PerfRow[], rangeRows: unknown[]): PerfRow[] {
  const byId = new Map<string, unknown>()
  for (const r of rangeRows) {
    const id = txt((r as Record<string, unknown>)?.id)
    if (id) byId.set(id, r)
  }
  return rows.map((row) => ({ ...row, ext: byId.has(row.id) ? buildExt(byId.get(row.id), row.impressions) : null }))
}

const DETAIL_KEYS: Record<'campaign' | 'adset' | 'ad', (keyof PerfDetail)[]> = {
  campaign: ['objective', 'buying_type', 'daily_budget', 'lifetime_budget', 'start_time', 'stop_time', 'updated_time'],
  adset: ['optimization_goal', 'billing_event', 'bid_strategy', 'daily_budget', 'lifetime_budget', 'start_time', 'end_time', 'updated_time'],
  ad: ['created_time', 'updated_time'],
}
/** @param catalog rows of the catalog table of that level, with its id column named `idKey`. */
export function attachDetails(rows: PerfRow[], level: 'campaign' | 'adset' | 'ad', catalog: unknown[] | null | undefined, idKey: string): PerfRow[] {
  if (!Array.isArray(catalog)) return rows
  const byId = new Map<string, Record<string, unknown>>()
  for (const c of catalog) {
    const id = txt((c as Record<string, unknown>)?.[idKey])
    if (id) byId.set(id, c as Record<string, unknown>)
  }
  return rows.map((row) => {
    const c = byId.get(row.id)
    if (!c) return { ...row, detail: null }
    const d: PerfDetail = {}
    for (const k of DETAIL_KEYS[level]) {
      const v = c[k]
      d[k] = (k === 'daily_budget' || k === 'lifetime_budget' ? nOrNull(v) : txt(v)) as never
    }
    return { ...row, detail: d }
  })
}

/** Minor currency units -> major, using the currency's own number of decimals (PEN/USD: 2, JPY: 0). */
export function minorToMajor(minor: number, currency: string): number {
  let digits = 2
  try { digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2 } catch { /* unknown currency: assume 2 */ }
  return minor / 10 ** digits
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
  /** Aggregated Meta metrics (reach, frequency, link/outbound clicks, messaging results). Absent/null = that cache is not available: the section is exactly the checkpoint one. */
  extended?: { available: true; summary: ExtMetrics | null } | null
}
export type MetaPerformance = MetaPerformanceAvailable | { available: false; reason: 'not_configured' | 'not_synced' | 'unavailable' }

export function syncState(row: { status?: string | null; last_success_at?: string | null }, partial: boolean): SyncState {
  if (row.status === 'paused') return 'paused'
  if (row.status === 'error') return 'error'
  if (!row.last_success_at) return 'pending'
  return partial ? 'syncing' : 'ok'
}
