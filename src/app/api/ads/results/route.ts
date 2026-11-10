import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { buildAdsReport } from '@/lib/meta-capi/report'
import { attachMetaCatalog, reportAdIds } from '@/lib/meta-ads/enrich'

// Read-only ad results. The account comes from the session and the report runs with the CALLER's client (RLS + explicit membership check in SQL).
// It never writes and never calls Meta, WhatsApp or InkaClick.
const DAY = 86_400_000
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const url = new URL(request.url)
    const to = url.searchParams.get('to') ? new Date(url.searchParams.get('to') as string) : new Date()
    const from = url.searchParams.get('from') ? new Date(url.searchParams.get('from') as string) : new Date(to.getTime() - 30 * DAY)
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to || to.getTime() - from.getTime() > 366 * DAY) {
      return NextResponse.json({ error: 'invalid period' }, { status: 400 })
    }
    const args = { p_account: accountId, p_from: from.toISOString(), p_to: to.toISOString() }
    const { data, error } = await supabase.rpc('ads_results_report', args)
    if (error) return NextResponse.json({ error: 'Could not load the report' }, { status: 500 })
    // Additive sold-products helper: if it is missing (migration not applied) or fails, the original report is returned unchanged.
    const products = await supabase.rpc('ads_results_by_product', args)
    // Additive product -> ad drilldown helper: same rule. Missing or failing => only the drilldown is hidden; cards, products and the full per-ad table stay.
    const breakdown = await Promise.resolve(supabase.rpc('ads_results_product_ad_breakdown', args)).catch(() => ({ data: null, error: { message: 'unavailable' } }))
    const report = buildAdsReport(data ?? [], from.toISOString(), to.toISOString(), products.error ? null : (products.data ?? []), breakdown.error ? null : (breakdown.data ?? []))
    // Only the on/off state of the Meta sending for THIS account (service role scoped to the session's account; no ids, no token).
    const { data: capi } = await supabaseAdmin().from('meta_capi_settings').select('enabled, test_event_code').eq('account_id', accountId).maybeSingle()
    report.meta_capi = { enabled: capi?.enabled === true, test_mode: !!capi?.test_event_code }
    // Optional Meta Ads catalog enrichment (real ad names, campaign/adset, status). Read-only from OUR cache: this never calls Meta. Any problem (migration
    // not applied, nothing synced yet, token failing, RPC error) leaves the report exactly as above; it can never fail or slow the report.
    try {
      const ids = reportAdIds(report)
      if (ids.length > 0) {
        const [catalog, sync] = await Promise.all([
          Promise.resolve(supabase.rpc('ads_results_meta_catalog', { p_account: accountId, p_ad_ids: ids })),
          supabaseAdmin().from('meta_ads_sync_state').select('last_success_at').eq('account_id', accountId).eq('job', 'catalog').maybeSingle(),
        ])
        if (!catalog.error && !sync.error) attachMetaCatalog(report, catalog.data ?? [], sync.data?.last_success_at ?? null)
      }
    } catch {
      // enrichment is optional by design
    }
    // Only tells the page whether to offer the separate "Rendimiento Meta Ads" section (it loads its own data from /api/ads/meta-performance).
    try {
      const { data: jobs } = await supabaseAdmin().from('meta_ads_sync_state').select('job').eq('account_id', accountId)
      if (Array.isArray(jobs) && jobs.some((j) => (j as { job?: string }).job === 'insights')) report.meta_ads = { configured: true }
    } catch {
      // optional
    }
    return NextResponse.json(report)
  } catch (error) {
    return toErrorResponse(error)
  }
}
