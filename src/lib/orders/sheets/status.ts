// How a cron pass is reported. Retries of transient problems are EXPECTED and keep the pass green (HTTP 200); anything that needs a person is not:
//   account_failed (the pass threw), layout_mismatch, row_content_mismatch (a divergent row was found), dead jobs, reconciliation differences, a global failure.
import type { ExportResult } from './exporter'
import type { ReconcileReport } from './reconcile'
import { MAX_LAG_KEYS, hasIntegrityAnomaly, isLagOnly, type ReconcileRun } from './reconcile-run'

export type PassStatus = 'ok' | 'retrying' | 'attention'
export interface AccountOutcome { account: string; status: PassStatus; reasons: string[] }

const NEEDS_PERSON = new Set(['layout_mismatch'])

export function classifyExport(r: ExportResult | { error: 'account_failed' }): { status: PassStatus; reasons: string[] } {
  if ('error' in r && r.error === 'account_failed') return { status: 'attention', reasons: ['account_failed'] }
  const e = r as ExportResult
  const reasons: string[] = []
  if (e.error && NEEDS_PERSON.has(e.error)) reasons.push(e.error)
  if (e.mismatched > 0) reasons.push('row_content_mismatch')
  if (e.deadOutstanding > 0) reasons.push('dead_jobs')
  if (reasons.length) return { status: 'attention', reasons }
  if (e.error || e.retried > 0) return { status: 'retrying', reasons: [e.error ?? 'retrying'] }
  return { status: 'ok', reasons: [] }
}

export function classifyReconcile(r: ReconcileReport | { error: 'account_failed' }): { status: PassStatus; reasons: string[] } {
  if ('error' in r) return { status: 'attention', reasons: ['account_failed'] }
  return r.differences > 0 ? { status: 'attention', reasons: ['reconcile_differences'] } : { status: 'ok', reasons: [] }
}

// A scheduled reconciliation (export first, bounded retry for lag). Lag that cleared on a retry is OK (and says so); what is left after the last attempt is named.
//   Needs a person (attention, HTTP 500):
//     persistent_lag / reconcile_differences   rows missing/surplus on EVERY attempt (an order that never reached the sheet, or a row nobody should have added)
//     unexplained_differences                  the counters differ but the keys do not explain it (never retried)
//     mass_difference                          more missing/surplus keys than any growth window explains (never retried)
//     duplicate_keys / altered_rows / projection_errors / dead_jobs / row_content_mismatch / layout_mismatch   integrity anomalies (never retried, never softened)
//     sync_failed_persistent                   the pre-sync threw on every attempt
//   Transient (HTTP 200, status «retrying», reasons visible in the answer and in the cron log): the pre-sync threw or ended with a transient error code on ANY attempt
//     (sync_threw, google_5xx, rate_limited, network, ...) even though the comparison itself ended clean. A failed sync never disappears behind a clean comparison.
export function classifyReconcileRun(run: ReconcileRun | { error: 'account_failed' }): { status: PassStatus; reasons: string[] } {
  if ('error' in run) return { status: 'attention', reasons: ['account_failed'] }
  const { report: r, sync } = run
  const reasons: string[] = []
  if (r.duplicateKeys.length) reasons.push('duplicate_keys')
  if (r.contentMismatches.length || r.lineMismatches.length || r.orderAmountMismatches.length) reasons.push('altered_rows')
  if (r.projectionErrors.length) reasons.push('projection_errors')
  if ((r.jobsByStatus?.dead ?? 0) > 0 || (sync?.deadOutstanding ?? 0) > 0) reasons.push('dead_jobs')
  if ((sync?.mismatched ?? 0) > 0) reasons.push('row_content_mismatch')
  if (sync?.error === 'layout_mismatch' || run.syncIssues.some((i) => i.code === 'layout_mismatch')) reasons.push('layout_mismatch')
  if (run.syncThrewOnEveryAttempt) reasons.push('sync_failed_persistent')
  if (r.differences > 0 && !hasIntegrityAnomaly(r)) {
    const keys = r.missingKeys.length + r.extraKeys.length
    if (isLagOnly(r)) reasons.push(run.attempts > 1 ? 'persistent_lag' : 'reconcile_differences')
    else reasons.push(keys > MAX_LAG_KEYS ? 'mass_difference' : 'unexplained_differences')
  }
  if (reasons.length) return { status: 'attention', reasons }
  const transient = [...new Set(run.syncIssues.map((i) => i.code))]
  if (transient.length) return { status: 'retrying', reasons: transient }
  return { status: 'ok', reasons: [] }
}

// HTTP status for the whole pass: 200 only when no account needs attention.
export function overall(outcomes: AccountOutcome[]): { status: PassStatus; http: 200 | 500 } {
  if (outcomes.some((o) => o.status === 'attention')) return { status: 'attention', http: 500 }
  if (outcomes.some((o) => o.status === 'retrying')) return { status: 'retrying', http: 200 }
  return { status: 'ok', http: 200 }
}
