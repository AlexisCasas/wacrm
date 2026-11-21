import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { readFinalizedGraceMinutes, runFinalizedReturn } from '@/lib/conversations/finalized-return'

// PR-05C · tick of the automatic return Logistica -> Comercial (order_finalized_at + 10 minutes). SAME convention as the other crons (system cron + shared
// secret, no pg_cron). It is independent of Shalom: it needs neither SHALOM_TRACKING_ENABLED nor shalom_tracking_enabled; per account only
// logistics_mvp_enabled decides (routing exists only then). The rule is durable in the database: if this endpoint is down the return stays pending and
// happens on the next tick. A tick that finds nothing due does nothing.
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const wanted = Buffer.from(expected)
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const graceMinutes = readFinalizedGraceMinutes()
    const result = await runFinalizedReturn(supabaseAdmin(), { graceMinutes })
    return NextResponse.json({ graceMinutes, ...result }, { status: result.errors > 0 ? 500 : 200 })
  } catch (error) {
    console.error('[routing-return-cron] failed:', error instanceof Error ? error.message : 'unknown')
    return NextResponse.json({ error: 'tick failed' }, { status: 500 })
  }
}
