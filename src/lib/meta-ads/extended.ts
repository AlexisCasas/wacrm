import type { SupabaseClient } from '@supabase/supabase-js'
import { attachDetails, buildExt, mergeRange, type ExtMetrics, type PerfRow } from './performance'

// Loads the OPTIONAL extended layer of the Meta Ads section from OUR cache only (never Meta): aggregated range metrics (reach, frequency, link/outbound clicks,
// messaging results, other actions) via meta_ads_range_metrics, and the secondary catalog details. Any failure returns null / no details and the caller serves the
// base section exactly as the checkpoint did.
const REAL_ID = /^[0-9]{6,25}$/
const ids = (rows: PerfRow[]) => rows.map((r) => r.id).filter((id) => REAL_ID.test(id))

export interface Extended {
  summary: ExtMetrics | null
  campaigns: PerfRow[]
  adsets: PerfRow[]
  ads: PerfRow[]
}

export async function loadExtended(
  supabase: Pick<SupabaseClient, 'rpc' | 'from'>,
  a: { accountId: string; days: number; since: string; until: string; impressions: number; campaigns: PerfRow[]; adsets: PerfRow[]; ads: PerfRow[] },
): Promise<Extended | null> {
  const args = { p_account: a.accountId, p_days: a.days, p_since: a.since, p_until: a.until }
  const [account, campaign, adset, ad] = await Promise.all(
    (['account', 'campaign', 'adset', 'ad'] as const).map((level) => Promise.resolve(supabase.rpc('meta_ads_range_metrics', { ...args, p_level: level }))),
  )
  if (account.error || campaign.error || adset.error || ad.error) return null // cache missing / RPC failing: base section only
  const list = (r: { data: unknown }) => (Array.isArray(r.data) ? (r.data as unknown[]) : [])
  const [accRows, campRows, setRows, adRows] = [list(account), list(campaign), list(adset), list(ad)]
  if (accRows.length + campRows.length + setRows.length + adRows.length === 0) return null // nothing cached for THIS window yet

  let campaigns = mergeRange(a.campaigns, campRows)
  let adsets = mergeRange(a.adsets, setRows)
  let ads = mergeRange(a.ads, adRows)
  try {
    const q = async (table: string, idKey: string, cols: string, rowIds: string[]) => {
      if (rowIds.length === 0) return []
      const r = await supabase.from(table).select(`${idKey}, ${cols}`).eq('account_id', a.accountId).in(idKey, rowIds)
      return r.error ? null : ((r.data as unknown[]) ?? [])
    }
    const [c, s, d] = await Promise.all([
      q('meta_ads_campaigns', 'campaign_id', 'objective, buying_type, daily_budget, lifetime_budget, start_time, stop_time, updated_time', ids(campaigns)),
      q('meta_ads_adsets', 'adset_id', 'optimization_goal, billing_event, bid_strategy, daily_budget, lifetime_budget, start_time, end_time, updated_time', ids(adsets)),
      q('meta_ads_ads', 'ad_id', 'meta_created_time, meta_updated_time', ids(ads)),
    ])
    campaigns = attachDetails(campaigns, 'campaign', c, 'campaign_id')
    adsets = attachDetails(adsets, 'adset', s, 'adset_id')
    // the ads table names its timestamps meta_*: map them to the detail keys
    ads = attachDetails(ads, 'ad', Array.isArray(d) ? d.map((x) => ({ ad_id: (x as { ad_id: string }).ad_id, created_time: (x as { meta_created_time?: string }).meta_created_time, updated_time: (x as { meta_updated_time?: string }).meta_updated_time })) : null, 'ad_id')
  } catch {
    // details are optional
  }
  return { summary: accRows.length > 0 ? buildExt(accRows[0], a.impressions) : null, campaigns, adsets, ads }
}
