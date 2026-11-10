import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { runMetaAdsSync } from '@/lib/meta-ads/sync'
import { createSupabaseSyncStore } from '@/lib/meta-ads/sync-store'

// Meta Ads sync tick (catalog, ad sets, campaigns, insights). Same secret convention as the other crons. With META_ADS_ENABLED != 'true' (the default) it does nothing at all.
// Errors are contained here: they never reach WhatsApp processing, the inbox, flows or the ads report.
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const wanted = Buffer.from(expected)
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    return NextResponse.json(await runMetaAdsSync(createSupabaseSyncStore(supabaseAdmin())))
  } catch (error) {
    console.error('[meta-ads-cron] failed:', error instanceof Error ? error.name : 'unknown')
    return NextResponse.json({ error: 'meta ads sync failed' }, { status: 500 })
  }
}
