// Meta Marketing API, AD CATALOG ONLY. Official reference: https://developers.facebook.com/docs/marketing-api/reference/ad-account/ads/
//   GET https://graph.facebook.com/{version}/act_{AD_ACCOUNT_ID}/ads?fields=...&limit=...&after=...   (Authorization: Bearer <token>)
// The catalog edge of the ad account is the ONLY source: no GET /{ad_id}, no ?ids=... (those returned HTTP 400 with this token).
// Never logs or returns the token or Meta's free-text error message (only Meta's numeric codes). The token travels in the Authorization
// header, never in the URL, so it cannot end up in access logs or error messages. Pagination uses the opaque `after` cursor only; the
// `paging.next` URL Meta returns is never followed.

export interface MetaAd {
  ad_id: string
  name: string | null
  adset_id: string | null
  adset_name: string | null
  campaign_id: string | null
  campaign_name: string | null
  status: string | null
  effective_status: string | null
  meta_created_time: string | null
  meta_updated_time: string | null
}

export type CatalogPageOutcome =
  | { kind: 'ok'; ads: MetaAd[]; after: string | null }
  | { kind: 'retry'; httpStatus: number | null; code: string; retryAfterMs?: number }
  | { kind: 'rejected'; httpStatus: number; code: string }
  | { kind: 'auth'; httpStatus: number; code: string }

export const CATALOG_FIELDS =
  'id,name,status,effective_status,created_time,updated_time,adset_id,campaign_id,adset{name},campaign{name}'
export const CATALOG_PAGE_SIZE = 200

export function catalogPageUrl(opts: { apiVersion: string; adAccountId: string; after?: string | null; limit?: number }): string {
  const q = new URLSearchParams({ fields: CATALOG_FIELDS, limit: String(opts.limit ?? CATALOG_PAGE_SIZE) })
  if (opts.after) q.set('after', opts.after)
  return `https://graph.facebook.com/${opts.apiVersion}/act_${opts.adAccountId}/ads?${q.toString()}`
}

// Graph API error codes: 190 = invalid/expired token, 10 and 200-299 = missing permission, 4/17/32/613 and 80000-80014 = rate limits.
const AUTH_CODES = new Set([190, 10])
const RATE_CODES = new Set([4, 17, 32, 613])
const isAuthCode = (code: number | null) => code !== null && (AUTH_CODES.has(code) || (code >= 200 && code <= 299))
const isRateCode = (code: number | null) => code !== null && (RATE_CODES.has(code) || (code >= 80000 && code <= 80014))

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
const time = (v: unknown): string | null => {
  const s = str(v)
  return s && !Number.isNaN(new Date(s).getTime()) ? new Date(s).toISOString() : null
}

/** Maps one Graph ad object to our row. Anything without a numeric id is dropped (never guessed). */
export function parseAd(raw: unknown): MetaAd | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  if (!id || !/^[0-9]{6,25}$/.test(id)) return null
  const adset = r.adset && typeof r.adset === 'object' ? (r.adset as Record<string, unknown>) : null
  const campaign = r.campaign && typeof r.campaign === 'object' ? (r.campaign as Record<string, unknown>) : null
  return {
    ad_id: id,
    name: str(r.name),
    adset_id: str(r.adset_id),
    adset_name: str(adset?.name),
    campaign_id: str(r.campaign_id),
    campaign_name: str(campaign?.name),
    status: str(r.status),
    effective_status: str(r.effective_status),
    meta_created_time: time(r.created_time),
    meta_updated_time: time(r.updated_time),
  }
}

function retryAfterFrom(res: Response): number | undefined {
  const header = Number(res.headers.get('retry-after'))
  let ms = Number.isFinite(header) && header > 0 ? header * 1000 : 0
  try {
    // x-business-use-case-usage: { "<id>": [ { estimated_time_to_regain_access: <minutes> } ] }
    const raw = res.headers.get('x-business-use-case-usage')
    if (raw) {
      for (const list of Object.values(JSON.parse(raw) as Record<string, unknown>)) {
        for (const e of Array.isArray(list) ? list : []) {
          const m = Number((e as { estimated_time_to_regain_access?: unknown }).estimated_time_to_regain_access)
          if (Number.isFinite(m) && m > 0) ms = Math.max(ms, m * 60_000)
        }
      }
    }
  } catch {
    // malformed usage header: ignore
  }
  return ms > 0 ? ms : undefined
}

type GraphFailure =
  | { kind: 'retry'; httpStatus: number | null; code: string; retryAfterMs?: number }
  | { kind: 'rejected'; httpStatus: number; code: string }
  | { kind: 'auth'; httpStatus: number; code: string }
export type GraphOutcome = { kind: 'ok'; body: unknown; httpStatus: number } | GraphFailure

/** One authenticated GET against the Graph API. Errors are reduced to {kind, code}: Meta's text and the token are never kept. */
export async function graphGet(url: string, token: string, fetchImpl: typeof fetch = fetch, timeoutMs = 20_000): Promise<GraphOutcome> {
  let res: Response
  try {
    res = await fetchImpl(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    return { kind: 'retry', httpStatus: null, code: 'network' }
  }

  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // non-JSON body: handled below by status
  }

  if (!res.ok) {
    let gcode: number | null = null
    const err = (body as { error?: { code?: unknown } } | null)?.error
    if (typeof err?.code === 'number') gcode = err.code
    const code = gcode !== null ? `meta_${gcode}` : `http_${res.status}`
    if (res.status === 401 || isAuthCode(gcode)) return { kind: 'auth', httpStatus: res.status, code }
    if (res.status === 429 || isRateCode(gcode)) return { kind: 'retry', httpStatus: res.status, code, retryAfterMs: retryAfterFrom(res) }
    if (res.status >= 500 || gcode === 1 || gcode === 2) return { kind: 'retry', httpStatus: res.status, code, retryAfterMs: retryAfterFrom(res) }
    return { kind: 'rejected', httpStatus: res.status, code }
  }
  return { kind: 'ok', body, httpStatus: res.status }
}

export type ListPageOutcome<T> = { kind: 'ok'; items: T[]; after: string | null } | GraphFailure

/** A paginated Graph list. Only a `next` link means "there is another page"; the opaque `after` cursor is the only paging input we ever send. */
async function graphListPage<T>(url: string, token: string, parse: (raw: unknown) => T | null, fetchImpl: typeof fetch, timeoutMs: number): Promise<ListPageOutcome<T>> {
  const out = await graphGet(url, token, fetchImpl, timeoutMs)
  if (out.kind !== 'ok') return out
  const data = (out.body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return { kind: 'rejected', httpStatus: out.httpStatus, code: 'bad_shape' }
  const paging = (out.body as { paging?: { cursors?: { after?: unknown }; next?: unknown } } | null)?.paging
  return { kind: 'ok', items: data.map(parse).filter((x): x is T => x !== null), after: paging?.next ? str(paging.cursors?.after) : null }
}

export async function fetchCatalogPage(
  opts: { apiVersion: string; adAccountId: string; after?: string | null; limit?: number },
  token: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 20_000,
): Promise<CatalogPageOutcome> {
  const out = await graphListPage(catalogPageUrl(opts), token, parseAd, fetchImpl, timeoutMs)
  return out.kind === 'ok' ? { kind: 'ok', ads: out.items, after: out.after } : out
}

// ---- Ad sets and campaigns (names, status + the secondary details confirmed by the live audit; keyed by Meta ids) -----------------------------
export interface MetaCampaign {
  campaign_id: string
  name: string | null
  status: string | null
  effective_status: string | null
  objective: string | null
  buying_type: string | null
  /** Meta's minor currency units (PEN: centimos), integers. */
  daily_budget: number | null
  lifetime_budget: number | null
  start_time: string | null
  stop_time: string | null
  created_time: string | null
  updated_time: string | null
}
export interface MetaAdset {
  adset_id: string
  name: string | null
  campaign_id: string | null
  status: string | null
  effective_status: string | null
  optimization_goal: string | null
  billing_event: string | null
  bid_strategy: string | null
  daily_budget: number | null
  lifetime_budget: number | null
  start_time: string | null
  end_time: string | null
  created_time: string | null
  updated_time: string | null
}
export const ADSET_FIELDS = 'id,name,campaign_id,status,effective_status,optimization_goal,billing_event,bid_strategy,daily_budget,lifetime_budget,start_time,end_time,created_time,updated_time'
export const CAMPAIGN_FIELDS = 'id,name,status,effective_status,objective,buying_type,daily_budget,lifetime_budget,start_time,stop_time,created_time,updated_time'
const validId = (v: unknown): string | null => {
  const s = str(v)
  return s && /^[0-9]{6,25}$/.test(s) ? s : null
}
/** Budgets arrive as integer strings in minor units. Anything else (null, empty, decimals) is "no budget". */
const budget = (v: unknown): number | null => {
  const s = typeof v === 'number' ? String(v) : str(v)
  if (!s || !/^\d{1,15}$/.test(s)) return null
  const n = Number(s)
  return Number.isSafeInteger(n) ? n : null
}
export function parseAdset(raw: unknown): MetaAdset | null {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  const id = validId(r?.id)
  if (!r || !id) return null
  return {
    adset_id: id, name: str(r.name), campaign_id: validId(r.campaign_id), status: str(r.status), effective_status: str(r.effective_status),
    optimization_goal: str(r.optimization_goal), billing_event: str(r.billing_event), bid_strategy: str(r.bid_strategy),
    daily_budget: budget(r.daily_budget), lifetime_budget: budget(r.lifetime_budget),
    start_time: time(r.start_time), end_time: time(r.end_time), created_time: time(r.created_time), updated_time: time(r.updated_time),
  }
}
export function parseCampaign(raw: unknown): MetaCampaign | null {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  const id = validId(r?.id)
  if (!r || !id) return null
  return {
    campaign_id: id, name: str(r.name), status: str(r.status), effective_status: str(r.effective_status),
    objective: str(r.objective), buying_type: str(r.buying_type), daily_budget: budget(r.daily_budget), lifetime_budget: budget(r.lifetime_budget),
    start_time: time(r.start_time), stop_time: time(r.stop_time), created_time: time(r.created_time), updated_time: time(r.updated_time),
  }
}
type EdgeOpts = { apiVersion: string; adAccountId: string; after?: string | null; limit?: number }
function edgeUrl(edge: string, fields: string, o: EdgeOpts): string {
  const q = new URLSearchParams({ fields, limit: String(o.limit ?? CATALOG_PAGE_SIZE) })
  if (o.after) q.set('after', o.after)
  return `https://graph.facebook.com/${o.apiVersion}/act_${o.adAccountId}/${edge}?${q.toString()}`
}
export const adsetsPageUrl = (o: EdgeOpts) => edgeUrl('adsets', ADSET_FIELDS, o)
export const campaignsPageUrl = (o: EdgeOpts) => edgeUrl('campaigns', CAMPAIGN_FIELDS, o)
export const fetchAdsetsPage = (o: EdgeOpts, token: string, f: typeof fetch = fetch, t = 20_000) => graphListPage(adsetsPageUrl(o), token, parseAdset, f, t)
export const fetchCampaignsPage = (o: EdgeOpts, token: string, f: typeof fetch = fetch, t = 20_000) => graphListPage(campaignsPageUrl(o), token, parseCampaign, f, t)

// ---- Insights (level=ad, one row per ad per day) ----------------------------------------------------------------------------------------
export interface InsightRow {
  ad_id: string
  ad_name: string | null
  adset_id: string | null
  adset_name: string | null
  campaign_id: string | null
  campaign_name: string | null
  /** Meta's `date_start`: a calendar day in the AD ACCOUNT's timezone. Stored as-is. */
  date: string
  impressions: number
  clicks: number
  /** Decimal STRING exactly as Meta sent it: it goes to a NUMERIC column, never through a float. */
  spend: string
  reach: number | null
}
export const INSIGHT_FIELDS = 'ad_id,ad_name,campaign_id,campaign_name,adset_id,adset_name,impressions,clicks,spend,reach,date_start,date_stop'
export const INSIGHT_PAGE_SIZE = 500
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const count = (v: unknown, dflt: number | null): number | null => {
  if (v === undefined || v === null || v === '') return dflt
  const n = typeof v === 'number' ? v : /^\d+$/.test(String(v)) ? Number(v) : NaN
  return Number.isSafeInteger(n) && n >= 0 ? n : NaN // NaN = malformed => the row is dropped, never guessed
}
export function parseInsight(raw: unknown): InsightRow | null {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  const adId = validId(r?.ad_id)
  const date = str(r?.date_start)
  if (!r || !adId || !date || !DATE_RE.test(date)) return null
  const impressions = count(r.impressions, 0)
  const clicks = count(r.clicks, 0)
  const reach = count(r.reach, null)
  const spendRaw = r.spend === undefined || r.spend === null || r.spend === '' ? '0' : String(r.spend)
  if (Number.isNaN(impressions) || Number.isNaN(clicks) || Number.isNaN(reach) || !/^\d+(\.\d+)?$/.test(spendRaw)) return null
  return {
    ad_id: adId, ad_name: str(r.ad_name), adset_id: validId(r.adset_id), adset_name: str(r.adset_name), campaign_id: validId(r.campaign_id), campaign_name: str(r.campaign_name),
    date, impressions: impressions as number, clicks: clicks as number, spend: spendRaw, reach,
  }
}
export function insightsPageUrl(o: { apiVersion: string; adAccountId: string; since: string; until: string; after?: string | null; limit?: number }): string {
  const q = new URLSearchParams({
    level: 'ad', time_increment: '1', fields: INSIGHT_FIELDS, limit: String(o.limit ?? INSIGHT_PAGE_SIZE),
    time_range: JSON.stringify({ since: o.since, until: o.until }),
  })
  if (o.after) q.set('after', o.after)
  return `https://graph.facebook.com/${o.apiVersion}/act_${o.adAccountId}/insights?${q.toString()}`
}
export const fetchInsightsPage = (o: Parameters<typeof insightsPageUrl>[0], token: string, f: typeof fetch = fetch, t = 30_000) =>
  graphListPage(insightsPageUrl(o), token, parseInsight, f, t)

// ---- Account-level totals, used ONLY to reconcile what we stored ------------------------------------------------------------------------
export interface AccountTotals { spend: string; impressions: number; clicks: number }
export type AccountTotalsOutcome = { kind: 'ok'; totals: AccountTotals } | GraphFailure
export function accountTotalsUrl(o: { apiVersion: string; adAccountId: string; since: string; until: string }): string {
  const q = new URLSearchParams({ level: 'account', fields: 'spend,impressions,clicks', time_range: JSON.stringify({ since: o.since, until: o.until }) })
  return `https://graph.facebook.com/${o.apiVersion}/act_${o.adAccountId}/insights?${q.toString()}`
}
export async function fetchAccountTotals(o: Parameters<typeof accountTotalsUrl>[0], token: string, fetchImpl: typeof fetch = fetch, timeoutMs = 30_000): Promise<AccountTotalsOutcome> {
  const out = await graphGet(accountTotalsUrl(o), token, fetchImpl, timeoutMs)
  if (out.kind !== 'ok') return out
  const data = (out.body as { data?: unknown } | null)?.data
  if (!Array.isArray(data) || data.length > 1) return { kind: 'rejected', httpStatus: out.httpStatus, code: 'bad_shape' }
  if (data.length === 0) return { kind: 'ok', totals: { spend: '0', impressions: 0, clicks: 0 } } // no delivery in the range
  const row = parseInsight({ ad_id: '000000', date_start: '2000-01-01', ...(data[0] as object) })
  return row ? { kind: 'ok', totals: { spend: row.spend, impressions: row.impressions, clicks: row.clicks } } : { kind: 'rejected', httpStatus: out.httpStatus, code: 'bad_shape' }
}

// ---- Aggregated RANGE insights (reach / frequency are NOT additive: they must come from Meta for the whole window) ------------------------------
export type RangeLevel = 'account' | 'campaign' | 'adset' | 'ad'
export interface MetaAction { action_type: string; value: string }
export interface RangeRow {
  level: RangeLevel
  /** Campaign / ad set / ad id; for level = account, the numeric Ad Account id. */
  entity_id: string
  /** Decimal string exactly as Meta sent it (goes to NUMERIC). */
  spend: string
  impressions: number
  clicks: number
  reach: number | null
  frequency: string | null
  ctr: string | null
  cpc: string | null
  cpm: string | null
  inline_link_clicks: number | null
  /** Value of the `outbound_click` entry of Meta's outbound_clicks list. */
  outbound_clicks: number | null
  /** Meta's `actions` list as-is (valid entries only). action_values is deliberately not requested: the audit found none. */
  actions: MetaAction[]
}
export const RANGE_FIELDS_FULL = 'spend,impressions,clicks,reach,frequency,ctr,cpc,cpm,inline_link_clicks,outbound_clicks,actions'
/** Fallback when Meta rejects the optional fields: the base metrics still sync. */
export const RANGE_FIELDS_BASE = 'spend,impressions,clicks,reach,frequency,ctr,cpc,cpm'
export type RangeVariant = 'full' | 'base'
const RANGE_ID_FIELD: Record<RangeLevel, string> = { account: 'account_id', campaign: 'campaign_id', adset: 'adset_id', ad: 'ad_id' }
const DEC_RE = /^\d+(\.\d+)?$/
const dec = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : DEC_RE.test(String(v)) ? String(v) : null)
const ACTION_TYPE_RE = /^[A-Za-z0-9_.:-]{1,120}$/

export function rangeUrl(o: { apiVersion: string; adAccountId: string; level: RangeLevel; since: string; until: string; variant: RangeVariant; after?: string | null; limit?: number }): string {
  const q = new URLSearchParams({
    level: o.level,
    fields: `${RANGE_ID_FIELD[o.level]},${o.variant === 'full' ? RANGE_FIELDS_FULL : RANGE_FIELDS_BASE}`,
    time_range: JSON.stringify({ since: o.since, until: o.until }), // NO time_increment: one aggregated row per entity for the whole window
    limit: String(o.limit ?? INSIGHT_PAGE_SIZE),
  })
  if (o.after) q.set('after', o.after)
  return `https://graph.facebook.com/${o.apiVersion}/act_${o.adAccountId}/insights?${q.toString()}`
}
export function parseActions(list: unknown): MetaAction[] {
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: MetaAction[] = []
  for (const a of list) {
    const x = a && typeof a === 'object' ? (a as Record<string, unknown>) : null
    const t = str(x?.action_type)
    const v = x?.value === undefined || x?.value === null ? null : String(x.value)
    if (!t || !ACTION_TYPE_RE.test(t) || v === null || !DEC_RE.test(v) || seen.has(t)) continue // malformed or repeated entries are dropped, never merged
    seen.add(t)
    out.push({ action_type: t, value: v })
  }
  return out
}
export function parseRangeRow(raw: unknown, level: RangeLevel, adAccountId: string): RangeRow | null {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  if (!r) return null
  const entity = level === 'account' ? (validId(String(r.account_id ?? '').replace(/^act_/, '')) ?? adAccountId) : validId(r[RANGE_ID_FIELD[level]])
  const spend = r.spend === undefined || r.spend === null || r.spend === '' ? '0' : String(r.spend)
  const impressions = count(r.impressions, 0)
  const clicks = count(r.clicks, 0)
  const reach = count(r.reach, null)
  const link = count(r.inline_link_clicks, null)
  if (!entity || !DEC_RE.test(spend) || Number.isNaN(impressions) || Number.isNaN(clicks) || Number.isNaN(reach) || Number.isNaN(link)) return null
  const outboundEntry = Array.isArray(r.outbound_clicks) ? (r.outbound_clicks as unknown[]).find((x) => (x as { action_type?: unknown })?.action_type === 'outbound_click') : undefined
  const outbound = outboundEntry ? count((outboundEntry as { value?: unknown }).value, null) : null
  if (Number.isNaN(outbound)) return null
  return {
    level, entity_id: entity, spend, impressions: impressions as number, clicks: clicks as number, reach, frequency: dec(r.frequency), ctr: dec(r.ctr), cpc: dec(r.cpc), cpm: dec(r.cpm),
    inline_link_clicks: link, outbound_clicks: outbound, actions: parseActions(r.actions),
  }
}
export const fetchRangePage = (o: Parameters<typeof rangeUrl>[0], token: string, f: typeof fetch = fetch, t = 30_000) =>
  graphListPage(rangeUrl(o), token, (raw) => parseRangeRow(raw, o.level, o.adAccountId), f, t)
