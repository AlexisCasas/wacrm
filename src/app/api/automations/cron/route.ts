import { randomUUID, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resumePendingExecution, AUTOMATION_PENDING_LEASE_MS } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'

/**
 * Drain due `automation_pending_executions` rows. Meant to be hit
 * on a schedule (Vercel Cron / external pinger) — requires a shared
 * secret via the `x-cron-secret` header to match
 * `AUTOMATION_CRON_SECRET`.
 *
 * The claim step (status = 'running', plus a fresh `claim_token` +
 * `lease_expires_at`) serves as a simple lock so overlapping
 * invocations don't double-process rows. Best-effort only; expensive
 * SELECT ... FOR UPDATE is avoided in favor of a single conditional
 * UPDATE-by-id, which Postgres already serializes per-row.
 *
 * Meta 131056 durable retry, Phase 3.1 — this also recovers rows
 * orphaned by a crash/redeploy between claim and completion: a
 * `status = 'running'` row whose `lease_expires_at` has passed is
 * exactly as eligible to (re)claim as a fresh `status = 'pending'`
 * one. The SAME claim UPDATE below handles both cases with one
 * `.or(...)` condition — there is no separate "recovery" path,
 * because a normal `wait` resume and a Meta-131056 retry resume both
 * go through this identical pending-row lifecycle (see
 * docs/META_131056_AUTOMATION_RETRY_AUDIT.md section "Fase 3.1").
 * A worker that reclaims a stale row gets a brand-new claim_token;
 * the old (dead, or merely slow) worker's copy of the token stops
 * matching the moment it next checks in (see
 * isPendingExecutionStillRunning / markPending in engine.ts), so it
 * can never stomp the new owner's progress even if it wakes back up.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const nowIso = new Date().toISOString()
  // Meta 131056 durable retry, Phase 3.1 — a row is "due" either because
  // it's a fresh `pending` row past its run_at, OR because it's a
  // `running` row whose lease has expired (its worker crashed/was
  // redeployed before ever calling markPending). Both are candidates for
  // this same claim loop below.
  const dueOrExpiredFilter = `status.eq.pending,and(status.eq.running,lease_expires_at.lt.${nowIso})`
  const { data: due, error } = await admin
    .from('automation_pending_executions')
    .select('*')
    .lte('run_at', nowIso)
    .or(dueOrExpiredFilter)
    .order('run_at', { ascending: true })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!due || due.length === 0) return NextResponse.json({ processed: 0 })

  let processed = 0
  for (const row of due) {
    // Single conditional UPDATE-by-id: Postgres serializes concurrent
    // writers to the same row, and each re-evaluates this WHERE clause
    // against the post-lock row state — so two overlapping cron ticks
    // (or a stale worker's lease expiring mid-race) can never both
    // succeed. Whichever commits first mints the token that "wins";
    // every loser's `.maybeSingle()` below comes back null.
    const claimToken = randomUUID()
    const leaseExpiresAt = new Date(Date.now() + AUTOMATION_PENDING_LEASE_MS).toISOString()
    const { data: claim } = await admin
      .from('automation_pending_executions')
      .update({ status: 'running', claim_token: claimToken, lease_expires_at: leaseExpiresAt })
      .eq('id', row.id)
      .or(dueOrExpiredFilter)
      .select('id')
      .maybeSingle()
    if (!claim) continue

    // A single defective row (an unexpected throw somewhere in the
    // resume path, rather than the errors-as-values that path already
    // handles internally) must never abort the whole batch — mirrors
    // runAutomationsForTrigger's own per-automation try/catch for the
    // exact same reason. The row itself is not left stuck: it was
    // already claimed above with a real lease, so it naturally becomes
    // reclaimable again once that lease expires, same as any other
    // crash mid-resume.
    try {
      await resumePendingExecution({
        id: row.id as string,
        automation_id: row.automation_id as string,
        // account_id is NOT NULL on automation_pending_executions
        // post-017; the engine uses it for tenant-scoped lookups.
        account_id: row.account_id as string,
        user_id: row.user_id as string,
        contact_id: (row.contact_id as string | null) ?? null,
        log_id: (row.log_id as string | null) ?? null,
        parent_step_id: (row.parent_step_id as string | null) ?? null,
        branch: (row.branch as 'yes' | 'no' | null) ?? null,
        next_step_position: row.next_step_position as number,
        context: (row.context as AutomationContext) ?? {},
        claim_token: claimToken,
      })
      processed++
    } catch (err) {
      console.error('[automations] cron: resumePendingExecution threw for row', row.id, err)
    }
  }

  return NextResponse.json({ processed })
}
