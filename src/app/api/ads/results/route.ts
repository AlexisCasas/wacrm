import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { buildAdsReport } from '@/lib/meta-capi/report'

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
    const { data, error } = await supabase.rpc('ads_results_report', { p_account: accountId, p_from: from.toISOString(), p_to: to.toISOString() })
    if (error) return NextResponse.json({ error: 'Could not load the report' }, { status: 500 })
    const report = buildAdsReport(data ?? [], from.toISOString(), to.toISOString())
    // Only the on/off state of the Meta sending for THIS account (service role scoped to the session's account; no ids, no token).
    const { data: capi } = await supabaseAdmin().from('meta_capi_settings').select('enabled, test_event_code').eq('account_id', accountId).maybeSingle()
    report.meta_capi = { enabled: capi?.enabled === true, test_mode: !!capi?.test_event_code }
    return NextResponse.json(report)
  } catch (error) {
    return toErrorResponse(error)
  }
}
