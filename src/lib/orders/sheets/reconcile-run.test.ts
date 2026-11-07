import { describe, expect, it, vi } from 'vitest'
import { emptyResult } from './exporter'
import { DEFAULT_RETRY, isLagOnly, reconcileWithRetry } from './reconcile-run'
import { classifyReconcileRun } from './status'
import type { ReconcileReport } from './reconcile'

const report = (o: Partial<ReconcileReport> = {}): ReconcileReport => ({
  eligibleOrders: 10, eligibleLines: 11, eligibleUnits: 12, eligibleCents: 1000, sheetOrders: 10, sheetLines: 11, sheetUnits: 12, sheetCents: 1000,
  missingKeys: [], extraKeys: [], duplicateKeys: [], orderAmountMismatches: [], lineMismatches: [], contentMismatches: [], projectionErrors: [],
  excludedOrders: 2, excludedByReason: { test: 2 }, notAcknowledgedOrders: 0, beforeEligibleSince: 0, jobsByStatus: { exported: 10 }, differences: 0, ...o,
})
const lag = (): ReconcileReport => report({ missingKeys: ['o:1'], eligibleOrders: 11, eligibleLines: 12, eligibleUnits: 13, eligibleCents: 1100, differences: 5 })
const sync = (o = {}) => ({ ...emptyResult(true), ...o })
const run = async (reports: ReconcileReport[], syncs: ReturnType<typeof sync>[] = []) => {
  const sleeps: number[] = []; let i = 0, s = 0
  const out = await reconcileWithRetry({
    sync: async () => syncs[Math.min(s++, syncs.length - 1)] ?? sync(),
    reconcile: async () => reports[Math.min(i++, reports.length - 1)],
    sleep: async (ms) => { sleeps.push(ms) },
  })
  return { out, sleeps, syncCalls: s, reconcileCalls: i }
}

describe('reconcile: sync first, bounded retry for lag only', () => {
  it('clean on the first comparison: one sync, one comparison, no waiting', async () => {
    const r = await run([report()])
    expect(r.out).toMatchObject({ attempts: 1, recoveredAfterRetry: false }); expect(r.sleeps).toEqual([]); expect(r.syncCalls).toBe(1)
    expect(classifyReconcileRun(r.out)).toEqual({ status: 'ok', reasons: [] })
  })
  it('an order acknowledged during the pass: lag on attempt 1, clean on attempt 2 -> ok and says it recovered', async () => {
    const r = await run([lag(), report()])
    expect(r.out).toMatchObject({ attempts: 2, recoveredAfterRetry: true }); expect(r.sleeps).toEqual([DEFAULT_RETRY.delayMs]); expect(r.syncCalls).toBe(2)
    expect(r.out.history.map((h) => [h.differences, h.lagOnly])).toEqual([[5, true], [0, false]])
    expect(classifyReconcileRun(r.out).status).toBe('ok')
  })
  it('lag that never clears is NOT hidden: 3 attempts, then attention «persistent_lag»', async () => {
    const r = await run([lag()])
    expect(r.out.attempts).toBe(1 + DEFAULT_RETRY.retries); expect(r.sleeps).toHaveLength(DEFAULT_RETRY.retries)
    expect(classifyReconcileRun(r.out)).toEqual({ status: 'attention', reasons: ['persistent_lag'] })
  })
  it.each([
    ['duplicates', { duplicateKeys: ['k'], differences: 1 }, 'duplicate_keys'],
    ['altered row', { contentMismatches: ['k:Producto'], differences: 1 }, 'altered_rows'],
    ['line amount', { lineMismatches: ['k'], differences: 1 }, 'altered_rows'],
    ['order amount', { orderAmountMismatches: ['o'], differences: 1 }, 'altered_rows'],
    ['projection error', { projectionErrors: ['o:total_mismatch'], differences: 1 }, 'projection_errors'],
  ])('%s is never retried and never softened', async (_n, o, why) => {
    const r = await run([report(o as Partial<ReconcileReport>), report()])
    expect(r.out.attempts).toBe(1); expect(r.sleeps).toEqual([])
    expect(classifyReconcileRun(r.out)).toEqual({ status: 'attention', reasons: [why] })
  })
  it('dead jobs are attention even when the sheet and the database agree, and stop the retries', async () => {
    const r = await run([report({ jobsByStatus: { exported: 9, dead: 1 }, differences: 0 })], [sync({ deadOutstanding: 1 })])
    expect(classifyReconcileRun(r.out)).toEqual({ status: 'attention', reasons: ['dead_jobs'] })
    const r2 = await run([{ ...lag(), jobsByStatus: { dead: 1 } }, report()])
    expect(r2.out.attempts).toBe(1)
  })
  it('a quarantined row found by the sync stops the retries and is reported', async () => {
    const r = await run([lag(), report()], [sync({ mismatched: 1 })])
    expect(r.out.attempts).toBe(1)
    expect(classifyReconcileRun(r.out).reasons).toEqual(expect.arrayContaining(['row_content_mismatch']))
  })
  it('a sync that throws does not stop the comparison, which decides the outcome', async () => {
    const out = await reconcileWithRetry({ sync: async () => { throw new Error('boom') }, reconcile: async () => report(), sleep: async () => undefined })
    expect(out).toMatchObject({ attempts: 1, sync: null }); expect(classifyReconcileRun(out).status).toBe('ok')
  })
  it('without the pre-sync (diagnostic ?presync=0) there is no retry: a retry could not change anything', async () => {
    const reconcile = vi.fn(async () => lag())
    const out = await reconcileWithRetry({ sync: null, reconcile, sleep: async () => undefined })
    expect(out.attempts).toBe(1); expect(reconcile).toHaveBeenCalledTimes(1)
    expect(classifyReconcileRun(out)).toEqual({ status: 'attention', reasons: ['reconcile_differences'] })
  })
  it('isLagOnly: only missing/extra rows and their aggregates count as lag', () => {
    expect(isLagOnly(report())).toBe(false); expect(isLagOnly(lag())).toBe(true)
    expect(isLagOnly(report({ extraKeys: ['x'], differences: 4 }))).toBe(true)
    expect(isLagOnly({ ...lag(), duplicateKeys: ['d'] })).toBe(false)
  })
  it('the whole pass stays inside the cron script timeout', () => {
    const worst = (DEFAULT_RETRY.retries * DEFAULT_RETRY.delayMs) / 1000
    expect(worst).toBeLessThanOrEqual(120)      // leaves >= 160 s of the 280 s fetch budget for 6 exports/comparisons
  })
})
