import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
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
    return NextResponse.json(buildAdsReport(data ?? [], from.toISOString(), to.toISOString()))
  } catch (error) {
    return toErrorResponse(error)
  }
}
