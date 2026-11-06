// Historical-load rehearsal on an ISOLATED restored copy of production orders (see docs). Prints AGGREGATES only: no names, phones, DNIs or per-customer amounts.
// Skipped unless QA_HISTORICAL=1 (+ loopback URL). The sheet is an in-memory fake: nothing is sent to Google.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { runSheetsExport } from './exporter'
import { reconcileAccount } from './reconcile'
import { FakeSheet } from './fake-sheet'

const ON = process.env.QA_HISTORICAL === '1'
const ACCOUNT = process.env.QA_HISTORICAL_ACCOUNT ?? ''
const q = (s: string) => execFileSync('docker', ['exec', '-i', process.env.QA_PG_CONTAINER ?? 'qs-pg', 'psql', '-U', 'supabase_admin', '-d', 'wacrm', '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-c', s], { encoding: 'utf8' }).trim()

describe.skipIf(!ON)('historical load rehearsal', () => {
  it('loads every eligible order once, reconciles to zero, and a second pass changes nothing', async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
    if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url) || !ACCOUNT) throw new Error('loopback URL and QA_HISTORICAL_ACCOUNT required')
    const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
    q(`truncate order_sheet_events, order_sheet_exports, order_sheet_exclusions, order_sheet_destinations cascade`)
    q(`insert into order_sheet_destinations (account_id, spreadsheet_id, enabled) values ('${ACCOUNT}','${'H'.repeat(30)}',true)`)
    // Test-order candidates (heuristics, counts only). A person decides; the exclusion list is explicit, never automatic.
    const cand = q(`select count(*) from order_confirmations where account_id='${ACCOUNT}' and delivery_status='acknowledged' and (customer_name ~* '(prueba|test|demo|qa )' or product ~* '(prueba|test|demo)' or coalesce(order_description,'') ~* '(prueba|test )' or dni ~ '^(\\d)\\1+$')`)
    const sheet = new FakeSheet()
    const passes: unknown[] = []
    for (let i = 0; i < 60; i++) { const r = await runSheetsExport(db, sheet, ACCOUNT, { batch: 50, maxBatches: 20 }); passes.push(r); if (r.claimed === 0) break }
    const rep = await reconcileAccount(db, sheet, ACCOUNT)
    const before = JSON.stringify(sheet.data), n = sheet.data.length
    const again = await runSheetsExport(db, sheet, ACCOUNT)
    const rep2 = await reconcileAccount(db, sheet, ACCOUNT)
    const dbCounts = q(`select count(*) filter (where delivery_status='acknowledged') ||'|'|| count(*) filter (where delivery_status<>'acknowledged') from order_confirmations where account_id='${ACCOUNT}'`)
    const summary = { dbAcknowledged_notAcknowledged: dbCounts, testCandidatesAmongAcknowledged: cand, passes: passes.length, report: { ...rep, missingKeys: rep.missingKeys.length, extraKeys: rep.extraKeys.length, duplicateKeys: rep.duplicateKeys.length, lineMismatches: rep.lineMismatches.length, orderAmountMismatches: rep.orderAmountMismatches.length, projectionErrors: rep.projectionErrors }, rerun: { claimed: again.claimed, appended: again.appendedLines, rowsBefore: n, rowsAfter: sheet.data.length, identical: JSON.stringify(sheet.data) === before, differences: rep2.differences } }
    writeFileSync(process.env.QA_HISTORICAL_OUT ?? '/dev/null', JSON.stringify(summary, null, 1))
    expect(rep.differences).toBe(0); expect(again.appendedLines).toBe(0); expect(JSON.stringify(sheet.data)).toBe(before)
  }, 300_000)

  it('with the prepared test-order exclusion applied first: 2 orders excluded, the rest reconciles to zero, the SQL is idempotent', async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
    if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url) || !ACCOUNT) throw new Error('loopback URL and QA_HISTORICAL_ACCOUNT required')
    const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
    const script = readFileSync('scripts/ops/orders-sheets/exclude-test-orders.sql', 'utf8')
    const apply = () => execFileSync('docker', ['exec', '-i', process.env.QA_PG_CONTAINER ?? 'qs-pg', 'psql', '-U', 'supabase_admin', '-d', 'wacrm', '-At', '-v', 'ON_ERROR_STOP=1'], { input: script, encoding: 'utf8' })
    q(`truncate order_sheet_events, order_sheet_exports, order_sheet_exclusions, order_sheet_destinations cascade`)
    q(`insert into order_sheet_destinations (account_id, spreadsheet_id, enabled) values ('${ACCOUNT}','${'H'.repeat(30)}',true)`)
    const orderStatusBefore = q(`select md5(string_agg(o::text, ',' order by id)) from order_confirmations o`)
    apply(); apply()                                                                   // twice: idempotent
    expect(q(`select count(*) from order_sheet_exclusions where reason = 'test'`)).toBe('2')
    expect(q(`select md5(string_agg(o::text, ',' order by id)) from order_confirmations o`)).toBe(orderStatusBefore)   // orders untouched
    const sheet = new FakeSheet()
    for (let i = 0; i < 60; i++) { const r = await runSheetsExport(db, sheet, ACCOUNT, { batch: 50, maxBatches: 20 }); if (r.claimed === 0) break }
    const rep = await reconcileAccount(db, sheet, ACCOUNT)
    const excludedInSheet = q(`select count(*) from order_confirmations where left(md5(id::text), 8) in ('c071235f','821d22b1')`) // sanity: they exist in the DB
    const keys = new Set(sheet.data.map((r) => String(r[16]).split(':')[0]))
    const leaked = q(`select id from order_confirmations where left(md5(id::text), 8) in ('c071235f','821d22b1')`).split('\n').filter((id) => keys.has(id)).length
    const out = { excludedBySql: 2, dbHasThem: excludedInSheet, leakedIntoSheet: leaked, eligibleOrders: rep.eligibleOrders, eligibleLines: rep.eligibleLines, eligibleUnits: rep.eligibleUnits, eligibleCents: rep.eligibleCents, sheetLines: rep.sheetLines, excludedOrders: rep.excludedOrders, excludedByReason: rep.excludedByReason, differences: rep.differences, jobsByStatus: rep.jobsByStatus }
    writeFileSync((process.env.QA_HISTORICAL_OUT ?? '/dev/null').replace(/\.json$/, '') + '-excl.json', JSON.stringify(out, null, 1))
    expect(rep.differences).toBe(0); expect(leaked).toBe(0); expect(rep.excludedByReason).toEqual({ test: 2 }); expect(rep.eligibleOrders).toBe(Number(q(`select count(*) from order_confirmations where account_id='${ACCOUNT}' and delivery_status='acknowledged'`)) - 2)
  }, 300_000)
})
