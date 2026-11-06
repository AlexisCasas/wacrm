// How a cron pass is reported. Retries of transient problems are EXPECTED and keep the pass green (HTTP 200); anything that needs a person is not:
//   account_failed (the pass threw), layout_mismatch, row_content_mismatch (a divergent row was found), dead jobs, reconciliation differences, a global failure.
import type { ExportResult } from './exporter'
import type { ReconcileReport } from './reconcile'

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

// HTTP status for the whole pass: 200 only when no account needs attention.
export function overall(outcomes: AccountOutcome[]): { status: PassStatus; http: 200 | 500 } {
  if (outcomes.some((o) => o.status === 'attention')) return { status: 'attention', http: 500 }
  if (outcomes.some((o) => o.status === 'retrying')) return { status: 'retrying', http: 200 }
  return { status: 'ok', http: 200 }
}
