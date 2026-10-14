import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { schedulerAccountIds } from '@/lib/flows/execution-gates'
import { recoverStrandedRuns } from '@/lib/flows/engine'

/**
 * Recover runs that were stranded by a process that died mid-advance (P8). PREPARED, NOT SCHEDULED.
 *
 * It only looks at accounts that have execution enabled (durable waits or subflows) and does nothing, touching no database,
 * while that list is empty. A stranded run is resumed only when the event log proves nothing was sent after its last cursor;
 * a send with an intent but no confirmation is NEVER repeated (the run ends as send_outcome_unknown and the incident is
 * recorded). Same shared secret header as the other cron endpoints.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (suppliedBuf.length !== expectedBuf.length || !timingSafeEqual(suppliedBuf, expectedBuf)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const accountIds = await schedulerAccountIds(() => supabaseAdmin(), ['durable_wait', 'subflow'])
    if (accountIds.length === 0) return NextResponse.json({ enabled: false, examined: 0 })
    const summary = await recoverStrandedRuns({ accountIds, limit: 25 })
    return NextResponse.json({ enabled: true, ...summary })
  } catch (err) {
    console.error('[flows-recovery-cron] pass failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ enabled: true, error: 'pass failed' }, { status: 500 })
  }
}
