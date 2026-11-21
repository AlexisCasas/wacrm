import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { readOrderSyncConfig, runOrderSyncOutbox } from '@/lib/orders/sync/transport'

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const wanted = Buffer.from(expected)
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const cfg = readOrderSyncConfig()
    const result = await runOrderSyncOutbox(supabaseAdmin(), cfg)
    return NextResponse.json({ enabled: cfg !== null, ...result })
  } catch (error) {
    console.error('[order-sync-cron] failed:', error instanceof Error ? error.message : 'unknown')
    return NextResponse.json({ error: 'sync outbox failed' }, { status: 500 })
  }
}
