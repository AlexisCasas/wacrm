import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { durableWaitExecutionAccountIds } from '@/lib/flows/durable-wait-capability'
import { resumeDueFlowWaits } from '@/lib/flows/engine'

/**
 * Resume durable waits whose time has come (flow_runs.wait_until, migration 069).
 *
 * Deliberately a SEPARATE endpoint from /api/flows/cron: it can be called every minute without making the shared 5-minute
 * sweep (which scans every active run) run 5x as often. A pass costs:
 *   - nothing at all while FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS is empty (no database call is made);
 *   - otherwise ONE indexed query (partial index idx_flow_runs_waiting_due, only rows that are due and active), bounded by
 *     `limit` (default 25, max 200) and a 45 s time budget. Under load the oldest waits go first and the rest wait for the
 *     next pass, so precision degrades gracefully: with N waits due at once, roughly limit/minute are resumed.
 *
 * Auth: same shared secret header as the other cron endpoints.
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

  const accountIds = durableWaitExecutionAccountIds()
  if (accountIds.length === 0) return NextResponse.json({ enabled: false, claimed: 0 })

  const limitParam = Number(new URL(request.url).searchParams.get('limit'))
  const limit = Number.isInteger(limitParam) && limitParam >= 1 && limitParam <= 200 ? limitParam : 25
  try {
    const summary = await resumeDueFlowWaits({ accountIds, limit })
    return NextResponse.json({ enabled: true, ...summary })
  } catch (err) {
    console.error('[flows-waits-cron] pass failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ enabled: true, error: 'pass failed' }, { status: 500 })
  }
}
