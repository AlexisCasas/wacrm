import type { Cell } from './layout'
import type { SheetsApi } from './google-client'
import type { ReconcileReport } from './reconcile'

// Server-written part of the «Control de conciliación» tab. The sheet never holds hand-typed "database" figures: the cron's reconcile pass writes them, with the
// time of the pass, and the sheet's own formulas compare them with the sheet. A missing or stale timestamp turns the status into SIN CONCILIAR / CONCILIACIÓN VENCIDA.
//   C2:D7  database figure | sheet figure read in the same pass     B9  time of the pass (Lima serial)     C13:C15  informative counters
export const CONTROL_TAB = 'Control de conciliación'

// Sheets serial date-time in Lima wall-clock time (UTC-5, no DST), to the second: comparable with NOW() of a sheet whose time zone is America/Lima.
export const limaNowSerial = (ms: number): number => Math.round(ms / 1000) / 86400 + 25569 - 5 / 24

export interface ControlWrite { a1: string; values: Cell[][] }

export function controlWrites(r: ReconcileReport, nowMs: number): ControlWrite[] {
  const other = r.missingKeys.length + r.extraKeys.length + r.contentMismatches.length + r.lineMismatches.length + r.orderAmountMismatches.length + r.projectionErrors.length
  return [
    { a1: 'C2:D7', values: [
      [r.eligibleOrders, r.sheetOrders], [r.eligibleLines, r.sheetLines], [r.eligibleUnits, r.sheetUnits],
      [r.eligibleCents / 100, r.sheetCents / 100], [0, r.duplicateKeys.length], [0, other],
    ] },
    { a1: 'B9', values: [[limaNowSerial(nowMs)]] },
    { a1: 'C13:C15', values: [[r.excludedByReason.test ?? 0], [r.notAcknowledgedOrders], [r.jobsByStatus.dead ?? 0]] },
  ]
}

// Writes the figures of a finished reconciliation. The timestamp goes LAST: if anything fails half way, the old timestamp ages and the sheet reports it.
export async function publishControl(api: SheetsApi, spreadsheetId: string, r: ReconcileReport, nowMs: number): Promise<void> {
  const [figures, stamp, counters] = controlWrites(r, nowMs)
  await api.writeRange(spreadsheetId, CONTROL_TAB, figures.a1, figures.values)
  await api.writeRange(spreadsheetId, CONTROL_TAB, counters.a1, counters.values)
  await api.writeRange(spreadsheetId, CONTROL_TAB, stamp.a1, stamp.values)
}
