import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { readInkaclickConfig, runOrderOutbox } from '@/lib/orders/outbox'

// Outbox tick: delivers due orders to InkaClick and reconciles the ones already sent. Same secret and scheduling convention as the other crons.
// Without INKACLICK_ORDERS_ENABLED=true plus URL and token it does nothing at all (global switch); per account, the DB switch decides.
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const wanted = Buffer.from(expected)
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const cfg = readInkaclickConfig()
    const result = await runOrderOutbox(supabaseAdmin(), cfg)
    return NextResponse.json({ enabled: cfg !== null, ...result })
  } catch (error) {
    console.error('[orders-cron] failed:', error instanceof Error ? error.message : 'unknown')
    return NextResponse.json({ error: 'outbox failed' }, { status: 500 })
  }
}
