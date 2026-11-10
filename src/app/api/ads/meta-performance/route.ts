import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { loadExtended } from '@/lib/meta-ads/extended'
import { buildPerfRows, META_DAYS, metaWindow, sumTotals, syncState, type MetaPerformance } from '@/lib/meta-ads/performance'

// Read-only Meta Ads performance (spend, impressions, clicks + CTR/CPC/CPM) by campaign, ad set and ad, over 7/30/90 complete Meta days.
// It reads ONLY our cache (meta_ads_* tables); it never calls Meta. The account comes from the session. The WACRM report is not involved: any problem here
// answers 200 { available:false } and the page simply omits the section.
const off = (reason: 'not_configured' | 'not_synced' | 'unavailable') => NextResponse.json({ available: false, reason } satisfies MetaPerformance)

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const days = Number(new URL(request.url).searchParams.get('days') ?? 30)
    if (!(META_DAYS as readonly number[]).includes(days)) return NextResponse.json({ error: 'invalid days' }, { status: 400 })

    try {
      const admin = supabaseAdmin()
      const { data: settings } = await admin.from('meta_ads_settings').select('account_timezone, currency').eq('account_id', accountId).maybeSingle()
      if (!settings) return off('not_configured')
      const { data: states } = await admin.from('meta_ads_sync_state').select('job, status, last_success_at, covered_from, covered_to').eq('account_id', accountId)
      const st = (Array.isArray(states) ? states : []).find((s) => (s as { job?: string }).job === 'insights') as
        | { status: string | null; last_success_at: string | null; covered_from: string | null; covered_to: string | null }
        | undefined
      if (!st || !st.last_success_at) return off('not_synced')

      const timezone = (settings as { account_timezone: string }).account_timezone
      const currency = (settings as { currency: string }).currency
      const { since, until } = metaWindow(days, timezone, Date.now())
      const args = { p_account: accountId, p_from: since, p_to: until }
      const [campaigns, adsets, ads] = await Promise.all(
        ['campaign', 'adset', 'ad'].map((level) => Promise.resolve(supabase.rpc('meta_ads_performance', { ...args, p_level: level }))),
      )
      if (campaigns.error || adsets.error || ads.error) return off('unavailable')

      const adRows = buildPerfRows(ads.data)
      const partial = !st.covered_from || !st.covered_to || st.covered_from > since || st.covered_to < until
      let reconciliation: Extract<MetaPerformance, { available: true }>['reconciliation'] = null
      try {
        const { data: rec } = await supabase.from('meta_ads_reconciliation').select('ok, checked_at, date_from, date_to').eq('account_id', accountId).eq('window_days', days).maybeSingle()
        if (rec) reconciliation = rec as NonNullable<typeof reconciliation>
      } catch {
        // optional
      }
      const base = { campaigns: buildPerfRows(campaigns.data), adsets: buildPerfRows(adsets.data), ads: adRows }
      const totals = sumTotals(adRows)
      // OPTIONAL extended layer (aggregated reach / frequency, link + outbound clicks, Meta messaging results, other actions, secondary details). If it is not available
      // or fails in any way, the response is exactly the base section (the checkpoint behaviour).
      let extended: Extract<MetaPerformance, { available: true }>['extended'] = null
      let rows = base
      try {
        const ext = await loadExtended(supabase, { accountId, days, since, until, impressions: totals.impressions, ...base })
        if (ext) {
          rows = { campaigns: ext.campaigns, adsets: ext.adsets, ads: ext.ads }
          extended = { available: true, summary: ext.summary }
        }
      } catch {
        // fall back to the base section
      }
      return NextResponse.json({
        available: true,
        period: { days, since, until, timezone, currency },
        synced_at: st.last_success_at,
        sync: { state: syncState(st, partial), covered_from: st.covered_from, covered_to: st.covered_to, partial },
        reconciliation,
        totals,
        ...rows,
        extended,
      } satisfies MetaPerformance)
    } catch {
      return off('unavailable')
    }
  } catch (error) {
    return toErrorResponse(error)
  }
}
