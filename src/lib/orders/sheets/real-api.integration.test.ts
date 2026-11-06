// AUTHORIZED check against the REAL Google Sheets API with SYNTHETIC rows only. Skipped unless QA_REAL_API=1.
// Run from a checkout with node_modules, credentials ONLY in the environment (never in files, args or chat):
//   QA_REAL_API=1 GOOGLE_SHEETS_SA_EMAIL=... GOOGLE_SHEETS_SA_KEY_B64=... QA_SHEET_ID=<QA sheet id> [QA_SHEET_TAB='Registro de pedidos'] [QA_REAL_API_OUT=/path/report.json] \
//     npx vitest run src/lib/orders/sheets/real-api.integration.test.ts
// The report holds step names and counters only: no key, token or cell value.
import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { GoogleSheetsClient } from './google-client'
import { runApiCheck } from './real-api-check'

describe.skipIf(process.env.QA_REAL_API !== '1')('real Google Sheets API (synthetic data)', () => {
  it('writes, reads back, is idempotent, survives a lost response and reconciles', async () => {
    const email = process.env.GOOGLE_SHEETS_SA_EMAIL?.trim(), b64 = process.env.GOOGLE_SHEETS_SA_KEY_B64?.trim(), id = process.env.QA_SHEET_ID?.trim()
    if (!email || !b64 || !id) throw new Error('GOOGLE_SHEETS_SA_EMAIL, GOOGLE_SHEETS_SA_KEY_B64 and QA_SHEET_ID are required')
    const api = new GoogleSheetsClient({ clientEmail: email, privateKey: Buffer.from(b64, 'base64').toString('utf8') })
    const report = await runApiCheck(api, id, process.env.QA_SHEET_TAB ?? 'Registro de pedidos')
    if (process.env.QA_REAL_API_OUT) writeFileSync(process.env.QA_REAL_API_OUT, JSON.stringify(report, null, 1))
    expect(report.steps.filter((s) => !s.ok)).toEqual([])
  }, 120_000)
})
