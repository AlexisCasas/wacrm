// In-memory stand-in for the destination sheet, with fault injection. Test support only (never imported by production code).
import { SheetsError, type SheetsApi } from './google-client'
import { HEADERS, KEY_COLUMN_INDEX, type Cell } from './layout'

export type Fault = 'none' | 'fail_before' | 'apply_then_fail' | 'always_503'
export class FakeSheet implements SheetsApi {
  header: string[] = [...HEADERS]
  data: Cell[][] = []
  fault: Fault = 'none'
  appends = 0
  written: { tab: string; a1: string; values: Cell[][] }[] = []
  failWrite = false
  async headerRow(): Promise<string[]> { return this.header }
  async column(): Promise<string[]> { return this.data.map((r) => String(r[KEY_COLUMN_INDEX] ?? '')) }
  async rows(): Promise<Cell[][]> { return this.data.map((r) => [...r]) }
  async writeRange(_id: string, tab: string, a1: string, values: Cell[][]): Promise<void> {
    if (this.failWrite) throw new SheetsError('google_5xx', true, 503)
    this.written.push({ tab, a1, values: values.map((r) => [...r]) })
  }
  formulaWrites: { tab: string; a1: string; values: Cell[][] }[] = []
  async writeFormulas(_id: string, tab: string, a1: string, values: Cell[][]): Promise<void> {
    if (this.failWrite) throw new SheetsError('google_5xx', true, 503)
    this.formulaWrites.push({ tab, a1, values: values.map((r) => [...r]) })
  }
  async formulas(): Promise<Cell[][]> { return [] }
  async append(_id: string, _tab: string, rows: Cell[][]): Promise<void> {
    this.appends++
    if (this.fault === 'always_503') throw new SheetsError('google_5xx', true, 503)
    if (this.fault === 'fail_before') { this.fault = 'none'; throw new SheetsError('network', true) }
    await new Promise((r) => setTimeout(r, 5))   // yield so concurrent writers interleave
    this.data.push(...rows.map((r) => [...r]))
    if (this.fault === 'apply_then_fail') { this.fault = 'none'; throw new SheetsError('network', true) }  // Google applied it, the client never saw the answer
  }
}
