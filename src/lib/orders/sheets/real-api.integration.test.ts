// AUTHORIZED check against the REAL Google Sheets API with SYNTHETIC rows only. Skipped unless QA_REAL_API=1.
// Run from a checkout with node_modules, credentials ONLY in the environment (never in files, args or chat):
//   QA_REAL_API=1 GOOGLE_SHEETS_SA_EMAIL=... GOOGLE_SHEETS_SA_KEY_B64=... QA_SHEET_ID=<QA sheet id> [QA_SHEET_TAB='Registro de pedidos'] [QA_REAL_API_OUT=/path/report.json] \
//     npx vitest run src/lib/orders/sheets/real-api.integration.test.ts
// The report holds step names and counters only: no key, token or cell value.
import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { GoogleSheetsClient } from './google-client'
import { runApiCheck } from './real-api-check'
import { publishControl, limaNowSerial } from './control'
import { applyControlFormulas, modelStatus, CONTROL_FORMULA_SPEC } from './control-formulas'
import type { ReconcileReport } from './reconcile'

describe.skipIf(process.env.QA_REAL_API !== '1')('real Google Sheets API (synthetic data)', () => {
  it('writes, reads back, is idempotent, survives a lost response and reconciles', async () => {
    const email = process.env.GOOGLE_SHEETS_SA_EMAIL?.trim(), b64 = process.env.GOOGLE_SHEETS_SA_KEY_B64?.trim(), id = process.env.QA_SHEET_ID?.trim()
    if (!email || !b64 || !id) throw new Error('GOOGLE_SHEETS_SA_EMAIL, GOOGLE_SHEETS_SA_KEY_B64 and QA_SHEET_ID are required')
    const api = new GoogleSheetsClient({ clientEmail: email, privateKey: Buffer.from(b64, 'base64').toString('utf8') })
    const report = await runApiCheck(api, id, process.env.QA_SHEET_TAB ?? 'Registro de pedidos')
    if (process.env.QA_REAL_API_OUT) writeFileSync(process.env.QA_REAL_API_OUT, JSON.stringify(report, null, 1))
    expect(report.steps.filter((s) => !s.ok)).toEqual([])
  }, 120_000)

  // Publishes a SYNTHETIC reconciliation report (the figures of the QA sheet's own rows) to the control tab of the QA sheet, to verify the write path and the formulas.
  // Never point QA_SHEET_ID at the definitive sheet.
  it.skipIf(process.env.QA_REAL_API_CONTROL !== '1')('publishes the server-written control figures', async () => {
    const email = process.env.GOOGLE_SHEETS_SA_EMAIL?.trim(), b64 = process.env.GOOGLE_SHEETS_SA_KEY_B64?.trim(), id = process.env.QA_SHEET_ID?.trim()
    if (!email || !b64 || !id) throw new Error('credentials and QA_SHEET_ID are required')
    const api = new GoogleSheetsClient({ clientEmail: email, privateKey: Buffer.from(b64, 'base64').toString('utf8') })
    const n = Number(process.env.QA_CONTROL_MISMATCH ?? 0)
    const r = {
      eligibleOrders: 4, eligibleLines: 5, eligibleUnits: 8, eligibleCents: 49500, sheetOrders: 4, sheetLines: 5, sheetUnits: 8, sheetCents: 49500,
      missingKeys: [], extraKeys: [], duplicateKeys: [], orderAmountMismatches: [], lineMismatches: [], contentMismatches: Array(n).fill('k:Producto'), projectionErrors: [],
      excludedOrders: 2, excludedByReason: { test: 2 }, notAcknowledgedOrders: 2, beforeEligibleSince: 0, jobsByStatus: { exported: 4 }, differences: n,
    } as ReconcileReport
    await publishControl(api, id, r, Date.now())
  }, 60_000)

  // Applies control-formulas.json to the QA sheet's control tab and checks, scenario by scenario, that the sheet itself computes the status the reference model documents.
  // Only the server-written figures of the QA control tab change (C2:D7, B9, C15); the register rows are never touched. Never point QA_SHEET_ID at the definitive sheet.
  it.skipIf(process.env.QA_REAL_API_CONTROL_FORMULAS !== '1')('the control tab computes PENDIENTE / HAY DIFERENCIAS / Sin diferencias as documented', async () => {
    const email = process.env.GOOGLE_SHEETS_SA_EMAIL?.trim(), b64 = process.env.GOOGLE_SHEETS_SA_KEY_B64?.trim(), id = process.env.QA_SHEET_ID?.trim()
    if (!email || !b64 || !id) throw new Error('credentials and QA_SHEET_ID are required')
    const api = new GoogleSheetsClient({ clientEmail: email, privateKey: Buffer.from(b64, 'base64').toString('utf8') })
    const tab = CONTROL_FORMULA_SPEC.tab
    await applyControlFormulas(api, id)
    const grid = async () => api.rows(id, tab)                       // row n of the sheet = grid[n - 2]
    const g0 = await grid()
    const live = [2, 3, 4, 5].map((r) => Number(g0[r - 2][1]))       // B2:B5 (orders, lines, units, amount)
    const dup = Number(g0[4][1])                                      // B6
    const maxAge = Number(g0[9][1])                                   // B11
    expect(maxAge).toBe(1.5)
    const report: { scenario: string; expected: string; actual: string }[] = []
    const scenario = async (name: string, o: { lastPass?: number | null; delta?: number[]; dbVsSheet?: number; dead?: number }) => {
      const delta = o.delta ?? [0, 0, 0, 0]
      const seen = live.map((v, i) => v - delta[i])                  // what the last pass "saw" in the sheet
      const db = seen.map((v, i) => (i === 3 ? v : v) + (o.dbVsSheet && i === 1 ? o.dbVsSheet : 0))
      const now = Date.now()
      const lastPass = o.lastPass === undefined ? limaNowSerial(now) : o.lastPass
      await api.writeRange(id, tab, 'C2:D7', [[db[0], seen[0]], [db[1], seen[1]], [db[2], seen[2]], [db[3], seen[3]], [0, dup], [0, 0]])
      await api.writeRange(id, tab, 'C15:C15', [[o.dead ?? 0]])
      await api.writeRange(id, tab, 'B9:B9', [[lastPass ?? '']])
      await new Promise((r) => setTimeout(r, 1500))                  // let Sheets recalculate
      const g = await grid()
      const actual = String(g[8][1])
      const expected = modelStatus({
        lastPassSerial: lastPass, nowSerial: limaNowSerial(Date.now()), maxAgeHours: maxAge, deadJobs: o.dead ?? 0,
        serverDiffs: [seen[0] - db[0], seen[1] - db[1], seen[2] - db[2], seen[3] - db[3], 0 - 0 + (dup - dup), 0],
        liveDuplicates: dup, growth: [delta[0], delta[1], delta[2], delta[3]],
      })
      report.push({ scenario: name, expected, actual })
      expect(actual, name).toBe(expected)
      return g
    }
    await scenario('clean: live sheet equals what the last pass saw', {})
    const pending = await scenario('new orders appended after the last pass', { delta: [1, 1, 2, 150] })
    expect(String(pending[10][1])).toMatch(/\+1 pedidos y \+1 líneas/)                       // B12 explains it
    await scenario('rows removed after the last pass', { delta: [-1, -1, -1, -10] })
    await scenario('amount went down while counts grew', { delta: [1, 1, 2, -5] })
    await scenario('server found a difference in the same pass', { dbVsSheet: 1 })
    await scenario('dead export jobs', { dead: 1, delta: [1, 1, 1, 10] })
    await scenario('last pass older than the validity window', { lastPass: limaNowSerial(Date.now() - 2 * 3600_000) })
    await scenario('never reconciled', { lastPass: null })
    await scenario('clean again (restores the QA sheet)', {})
    if (process.env.QA_REAL_API_OUT) writeFileSync(process.env.QA_REAL_API_OUT, JSON.stringify(report, null, 1))
  }, 180_000)
})
