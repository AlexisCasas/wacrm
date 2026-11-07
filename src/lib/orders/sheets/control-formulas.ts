import type { SheetsApi } from './google-client'
import type { Cell } from './layout'
import spec from './control-formulas.json'

// Formulas of the «Control de conciliación» tab that depend on the LIVE sheet (column B) versus the figures the server wrote at the last pass (column D).
// Why: the old status compared the server's own two figures (E = D - C) and so kept saying «Sin diferencias» after new orders were appended, until the next pass.
// Now the live sheet is compared with what the last pass saw:
//   growth only (live >= last pass on orders, lines, units, amount)  -> PENDIENTE DE CONCILIAR  (legitimate; the next pass absorbs it)
//   anything lower, a live duplicate, or a server-found difference    -> HAY DIFERENCIAS
// The single source is control-formulas.json; applying it is an explicit ops step (scripts/ops/orders-sheets/apply-control-formulas.mjs), never part of a cron pass.

export interface ControlCell { a1: string; value?: string | number; formula?: string }
export const CONTROL_FORMULA_SPEC = spec as { version: number; tab: string; cells: ControlCell[] }

export const controlFormulaWrites = (): { a1: string; values: Cell[][] }[] => CONTROL_FORMULA_SPEC.cells.map((c) => ({ a1: c.a1, values: [[c.formula ?? c.value ?? '']] }))

export async function applyControlFormulas(api: SheetsApi, spreadsheetId: string): Promise<number> {
  for (const w of controlFormulaWrites()) await api.writeFormulas(spreadsheetId, CONTROL_FORMULA_SPEC.tab, w.a1, w.values)
  return CONTROL_FORMULA_SPEC.cells.length
}

// Reference model of the status formula (B10), used by the tests and by the real-API check to prove the sheet computes what is documented here.
export interface StatusInputs {
  lastPassSerial: number | null; nowSerial: number; maxAgeHours: number
  deadJobs: number
  serverDiffs: number[]            // E2:E7 (DB figure vs sheet figure read in the same pass)
  liveDuplicates: number           // B6
  growth: [number, number, number, number] | null   // F2:F5 (live minus last pass): orders, lines, units, amount
}
export function modelStatus(i: StatusInputs): 'SIN CONCILIAR' | 'CONCILIACIÓN VENCIDA' | 'TRABAJOS EN ERROR' | 'HAY DIFERENCIAS' | 'PENDIENTE DE CONCILIAR' | 'Sin diferencias' {
  if (i.lastPassSerial === null) return 'SIN CONCILIAR'
  if (i.nowSerial - i.lastPassSerial > i.maxAgeHours / 24) return 'CONCILIACIÓN VENCIDA'
  if (i.deadJobs > 0) return 'TRABAJOS EN ERROR'
  const g = i.growth ?? [0, 0, 0, 0]
  if (i.serverDiffs.some((d) => d !== 0) || i.liveDuplicates > 0 || Math.min(g[0], g[1], g[2]) < 0 || g[3] < 0) return 'HAY DIFERENCIAS'
  if (Math.max(g[0], g[1], g[2]) > 0 || g[3] > 0) return 'PENDIENTE DE CONCILIAR'
  return 'Sin diferencias'
}
