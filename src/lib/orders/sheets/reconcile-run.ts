import type { ExportResult } from './exporter'
import type { ReconcileReport } from './reconcile'

// One scheduled reconciliation = export first, then compare, with a SHORT, BOUNDED retry for lag only.
//   1. sync immediately before the comparison, so an order acknowledged in the minutes since the last 2-minute tick is already in the sheet;
//   2. if the pass still differs and the ONLY differences are missing/extra rows (growth that a concurrent order or a slow sync explains), wait, sync again and compare again,
//      at most `retries` more times;
//   3. anything that is not lag is never retried and never softened: duplicates, altered rows (content / line / amount), projection errors, dead jobs, quarantined rows.
// Whatever still differs after the last attempt is reported as it is (HTTP 500 «attention»).

export interface RetryPolicy { retries: number; delayMs: number }
export const DEFAULT_RETRY: RetryPolicy = { retries: 2, delayMs: 45_000 }

export interface AttemptSummary { attempt: number; differences: number; lagOnly: boolean; missing: number; extra: number }
export interface ReconcileRun {
  report: ReconcileReport
  sync: ExportResult | null            // the export that ran right before the final comparison (null when it threw or was disabled)
  attempts: number
  history: AttemptSummary[]
  recoveredAfterRetry: boolean         // the first comparison differed, a later one was clean
}

// Differences that growth explains: rows missing from the sheet (order exported after the DB was read) or rows the DB snapshot did not know yet (exported right after it),
// plus the aggregate counters they move. Nothing here can be a damaged row.
export function isLagOnly(r: ReconcileReport): boolean {
  if (r.differences === 0) return false
  const dead = r.jobsByStatus.dead ?? 0
  return r.duplicateKeys.length === 0 && r.contentMismatches.length === 0 && r.lineMismatches.length === 0 && r.orderAmountMismatches.length === 0
    && r.projectionErrors.length === 0 && dead === 0
}

const noStopSync = (s: ExportResult | null): boolean => !!s && (s.mismatched > 0 || s.deadOutstanding > 0 || s.error === 'layout_mismatch')

export async function reconcileWithRetry(
  deps: { sync: (() => Promise<ExportResult>) | null; reconcile: () => Promise<ReconcileReport>; sleep?: (ms: number) => Promise<void> },
  policy: RetryPolicy = DEFAULT_RETRY,
): Promise<ReconcileRun> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const history: AttemptSummary[] = []
  let sync: ExportResult | null = null
  let report!: ReconcileReport
  const retries = deps.sync ? Math.max(0, policy.retries) : 0      // without the pre-sync there is nothing a retry could change
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    sync = null
    if (deps.sync) { try { sync = await deps.sync() } catch { sync = null } }   // a failed sync must not stop the comparison: the comparison is what reveals the state
    report = await deps.reconcile()
    const lag = isLagOnly(report)
    history.push({ attempt, differences: report.differences, lagOnly: lag, missing: report.missingKeys.length, extra: report.extraKeys.length })
    if (report.differences === 0 || !lag || noStopSync(sync) || attempt === retries + 1) break
    await sleep(policy.delayMs)
  }
  return { report, sync, attempts: history.length, history, recoveredAfterRetry: history.length > 1 && report.differences === 0 }
}
