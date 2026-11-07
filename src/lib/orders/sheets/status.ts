// How a cron pass is reported. Retries of transient problems are EXPECTED and keep the pass green (HTTP 200); anything that needs a person is not:
//   account_failed (the pass threw), layout_mismatch, row_content_mismatch (a divergent row was found), dead jobs, reconciliation differences, a global failure.
import type { ExportResult } from './exporter'
import type { ReconcileReport } from './reconcile'
import { isLagOnly, type ReconcileRun } from './reconcile-run'

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
//   persistent_lag        rows missing/extra on EVERY attempt (an order that never reached the sheet, or a row nobody should have added)
//   duplicate_keys / altered_rows / projection_errors / dead_jobs / row_content_mismatch   never retried, never softened
export function classifyReconcileRun(run: ReconcileRun | { error: 'account_failed' }): { status: PassStatus; reasons: string[] } {
  if ('error' in run) return { status: 'attention', reasons: ['account_failed'] }
  const { report: r, sync } = run
  const reasons: string[] = []
  if (r.duplicateKeys.length) reasons.push('duplicate_keys')
  if (r.contentMismatches.length || r.lineMismatches.length || r.orderAmountMismatches.length) reasons.push('altered_rows')
  if (r.projectionErrors.length) reasons.push('projection_errors')
  if ((r.jobsByStatus.dead ?? 0) > 0 || (sync?.deadOutstanding ?? 0) > 0) reasons.push('dead_jobs')
  if ((sync?.mismatched ?? 0) > 0) reasons.push('row_content_mismatch')
  if (sync?.error === 'layout_mismatch') reasons.push('layout_mismatch')
  if (r.differences > 0 && isLagOnly(r) && !reasons.length) reasons.push(run.attempts > 1 ? 'persistent_lag' : 'reconcile_differences')
  else if (r.differences > 0 && !reasons.length) reasons.push('reconcile_differences')
  return reasons.length ? { status: 'attention', reasons } : { status: 'ok', reasons: [] }
}

// HTTP status for the whole pass: 200 only when no account needs attention.
export function overall(outcomes: AccountOutcome[]): { status: PassStatus; http: 200 | 500 } {
  if (outcomes.some((o) => o.status === 'attention')) return { status: 'attention', http: 500 }
  if (outcomes.some((o) => o.status === 'retrying')) return { status: 'retrying', http: 200 }
  return { status: 'ok', http: 200 }
}
