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

export interface SyncIssue { attempt: number; kind: 'threw' | 'error'; code: string }
export interface AttemptSummary { attempt: number; differences: number; lagOnly: boolean; missing: number; extra: number; syncIssue?: SyncIssue }
export interface ReconcileRun {
  report: ReconcileReport
  sync: ExportResult | null            // the export that ran right before the final comparison (null when it threw or was disabled)
  attempts: number
  history: AttemptSummary[]
  syncIssues: SyncIssue[]              // every pre-sync that threw or ended with an error code, on ANY attempt: a failed sync never disappears behind a clean comparison
  syncThrewOnEveryAttempt: boolean     // only meaningful across retries (>= 2 attempts); a single throw on a clean pass is transient, and a persistent one also fails the 2-minute sync cron (rc=1)
  recoveredAfterRetry: boolean         // the first comparison differed, a later one was clean
}

// A recoverable lag needs EVIDENCE of growth, not just "something differs":
//   - at least one missing or surplus row key, and no more than MAX_LAG_KEYS of them (a 2-minute window yields a handful of orders; dozens of keys is not growth);
//   - no integrity anomaly of any kind (duplicates, altered content/line/amount, projection errors, dead jobs);
//   - the line counters agree with the keys: eligibleLines - sheetLines === missing - surplus. If they do not, part of the difference is unexplained.
// Differences without that evidence are reported as they are (unexplained_differences / mass_difference) and are not retried.
export const MAX_LAG_KEYS = 25
export function hasIntegrityAnomaly(r: ReconcileReport): boolean {
  return r.duplicateKeys.length > 0 || r.contentMismatches.length > 0 || r.lineMismatches.length > 0 || r.orderAmountMismatches.length > 0
    || r.projectionErrors.length > 0 || (r.jobsByStatus?.dead ?? 0) > 0
}
export function isLagOnly(r: ReconcileReport): boolean {
  if (r.differences === 0 || hasIntegrityAnomaly(r)) return false
  const keys = r.missingKeys.length + r.extraKeys.length
  if (keys === 0 || keys > MAX_LAG_KEYS) return false
  return r.eligibleLines - r.sheetLines === r.missingKeys.length - r.extraKeys.length
}

const noStopSync = (s: ExportResult | null): boolean => !!s && (s.mismatched > 0 || s.deadOutstanding > 0 || s.error === 'layout_mismatch')

export async function reconcileWithRetry(
  deps: { sync: (() => Promise<ExportResult>) | null; reconcile: () => Promise<ReconcileReport>; sleep?: (ms: number) => Promise<void> },
  policy: RetryPolicy = DEFAULT_RETRY,
): Promise<ReconcileRun> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const history: AttemptSummary[] = []
  const syncIssues: SyncIssue[] = []
  let sync: ExportResult | null = null
  let report!: ReconcileReport
  const retries = deps.sync ? Math.max(0, policy.retries) : 0      // without the pre-sync there is nothing a retry could change
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    sync = null
    let issue: SyncIssue | undefined
    if (deps.sync) {
      // A failed sync must not stop the comparison (the comparison is what reveals the state) but it is RECORDED: it is never silent.
      try { sync = await deps.sync(); if (sync.error) issue = { attempt, kind: 'error', code: sync.error } }
      catch { issue = { attempt, kind: 'threw', code: 'sync_threw' } }
    }
    if (issue) syncIssues.push(issue)
    report = await deps.reconcile()
    const lag = isLagOnly(report)
    history.push({ attempt, differences: report.differences, lagOnly: lag, missing: report.missingKeys.length, extra: report.extraKeys.length, ...(issue ? { syncIssue: issue } : {}) })
    if (report.differences === 0 || !lag || noStopSync(sync) || attempt === retries + 1) break
    await sleep(policy.delayMs)
  }
  return {
    report, sync, attempts: history.length, history, syncIssues,
    syncThrewOnEveryAttempt: !!deps.sync && history.length > 1 && syncIssues.filter((i) => i.kind === 'threw').length === history.length,
    recoveredAfterRetry: history.length > 1 && report.differences === 0,
  }
}
