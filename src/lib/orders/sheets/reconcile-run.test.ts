import { describe, expect, it, vi } from 'vitest'
import { emptyResult } from './exporter'
import { DEFAULT_RETRY, MAX_LAG_KEYS, isLagOnly, reconcileWithRetry } from './reconcile-run'
import { classifyReconcileRun, overall } from './status'
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
    expect(out).toMatchObject({ attempts: 1, sync: null }); expect(classifyReconcileRun(out)).toEqual({ status: 'retrying', reasons: ['sync_threw'] })   // the comparison still ran, and the failure is not silent
  })
  it('without the pre-sync (diagnostic ?presync=0) there is no retry: a retry could not change anything', async () => {
    const reconcile = vi.fn(async () => lag())
    const out = await reconcileWithRetry({ sync: null, reconcile, sleep: async () => undefined })
    expect(out.attempts).toBe(1); expect(reconcile).toHaveBeenCalledTimes(1)
    expect(classifyReconcileRun(out)).toEqual({ status: 'attention', reasons: ['reconcile_differences'] })
  })
  it('isLagOnly: only missing/extra rows and their aggregates count as lag', () => {
    expect(isLagOnly(report())).toBe(false); expect(isLagOnly(lag())).toBe(true)
    expect(isLagOnly(report({ extraKeys: ['x'], sheetLines: 12, sheetUnits: 13, sheetCents: 1100, sheetOrders: 11, differences: 4 }))).toBe(true)
    expect(isLagOnly({ ...lag(), duplicateKeys: ['d'] })).toBe(false)
  })
  // --- regression: a failed sync never disappears behind a clean comparison ------------------------------------------------------------------------
  const throwing = (n: number) => { let c = 0; return async () => { c++; if (c <= n) throw new Error('db down'); return sync() } }
  const withSync = (fn: () => Promise<ReturnType<typeof sync>>, reports: ReconcileReport[]) => { let i = 0; return reconcileWithRetry({ sync: fn, reconcile: async () => reports[Math.min(i++, reports.length - 1)], sleep: async () => undefined }) }
  it('sync throws once, comparison clean: ok is NOT claimed; the pass is «retrying» (HTTP 200) with the reason visible', async () => {
    const out = await withSync(throwing(1), [report()])
    expect(out.syncIssues).toEqual([{ attempt: 1, kind: 'threw', code: 'sync_threw' }]); expect(out.history[0].syncIssue?.code).toBe('sync_threw')
    expect(classifyReconcileRun(out)).toEqual({ status: 'retrying', reasons: ['sync_threw'] })
    expect(overall([{ account: 'a', ...classifyReconcileRun(out) }]).http).toBe(200)
  })
  it('sync ends with a transient error code, comparison clean: retrying with that code', async () => {
    const out = await withSync(async () => sync({ error: 'google_5xx', retried: 2 }), [report()])
    expect(classifyReconcileRun(out)).toEqual({ status: 'retrying', reasons: ['google_5xx'] })
  })
  it('sync failed on attempt 1, recovered on the retry, comparison clean: the earlier failure stays visible', async () => {
    const out = await withSync(throwing(1), [lag(), report()])
    expect(out).toMatchObject({ attempts: 2, recoveredAfterRetry: true }); expect(classifyReconcileRun(out)).toEqual({ status: 'retrying', reasons: ['sync_threw'] })
  })
  it('sync throws on EVERY attempt: needs a person, even if the comparison is clean', async () => {
    const single = await withSync(throwing(99), [report()])      // clean on the first comparison: one attempt, a single throw is transient (the 2-minute sync cron would fail persistently)
    expect(single.syncThrewOnEveryAttempt).toBe(false)
    const lagged = await withSync(throwing(99), [lag()])
    expect(lagged.attempts).toBe(3); expect(lagged.syncThrewOnEveryAttempt).toBe(true); expect(classifyReconcileRun(lagged).reasons).toEqual(expect.arrayContaining(['sync_failed_persistent', 'persistent_lag']))
  })
  it('a sync that hit layout_mismatch is an intervention, not a transient', async () => {
    const out = await withSync(async () => sync({ error: 'layout_mismatch' }), [report()])
    expect(classifyReconcileRun(out)).toEqual({ status: 'attention', reasons: ['layout_mismatch'] })
  })
  it('a fully clean pass is still plain ok with no issues', async () => {
    const out = await withSync(async () => sync(), [report()])
    expect(out.syncIssues).toEqual([]); expect(classifyReconcileRun(out)).toEqual({ status: 'ok', reasons: [] })
  })

  // --- regression: isLagOnly needs evidence --------------------------------------------------------------------------------------------------------
  it('differences with NO missing/surplus key are unexplained: not lag, not retried, reported as such', async () => {
    const odd = report({ eligibleCents: 1100, differences: 100 })            // amount differs, no key explains it
    expect(isLagOnly(odd)).toBe(false)
    const out = await withSync(async () => sync(), [odd, report()])
    expect(out.attempts).toBe(1)
    expect(classifyReconcileRun(out)).toEqual({ status: 'attention', reasons: ['unexplained_differences'] })
  })
  it('keys present but the line counters do not match them: partly unexplained, not retried', async () => {
    const odd = report({ missingKeys: ['o:1'], eligibleLines: 15, differences: 6 })     // 1 key but 4 lines apart
    expect(isLagOnly(odd)).toBe(false)
    expect(classifyReconcileRun((await withSync(async () => sync(), [odd])))).toEqual({ status: 'attention', reasons: ['unexplained_differences'] })
  })
  it('more keys than any growth window explains is a mass difference, not retried', async () => {
    const n = MAX_LAG_KEYS + 1
    const mass = report({ missingKeys: Array.from({ length: n }, (_, i) => `o:${i}`), eligibleLines: 11 + n, differences: n * 2 })
    expect(isLagOnly(mass)).toBe(false)
    const out = await withSync(async () => sync(), [mass, report()])
    expect(out.attempts).toBe(1); expect(classifyReconcileRun(out)).toEqual({ status: 'attention', reasons: ['mass_difference'] })
    expect(isLagOnly(report({ missingKeys: Array.from({ length: MAX_LAG_KEYS }, (_, i) => `o:${i}`), eligibleLines: 11 + MAX_LAG_KEYS, differences: 5 }))).toBe(true)
  })
  it('any integrity anomaly vetoes lag even when keys are missing', () => {
    for (const a of [{ duplicateKeys: ['d'] }, { contentMismatches: ['k:Producto'] }, { lineMismatches: ['k'] }, { orderAmountMismatches: ['o'] }, { projectionErrors: ['o:x'] }, { jobsByStatus: { dead: 1 } }])
      expect(isLagOnly({ ...lag(), ...a } as ReconcileReport)).toBe(false)
  })
  it('the whole pass stays inside the cron script timeout', () => {
    const worst = (DEFAULT_RETRY.retries * DEFAULT_RETRY.delayMs) / 1000
    expect(worst).toBeLessThanOrEqual(120)      // leaves >= 160 s of the 280 s fetch budget for 6 exports/comparisons
  })
})
