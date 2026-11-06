// Integration QA of the Google Sheets export against an ISOLATED database (scripts/qa/orders-sheets/setup.sh) and an in-memory fake sheet with fault injection.
// SYNTHETIC data only. Skipped unless QA_E2E=1; refuses non-loopback URLs because it truncates the export tables.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runSheetsExport } from './exporter'
import { reconcileAccount } from './reconcile'
import type { SheetsApi } from './google-client'
import { FakeSheet } from './fake-sheet'
import { HEADERS, KEY_COLUMN_INDEX } from './layout'

const E2E = process.env.QA_E2E === '1'
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const sql = (q: string): string => execFileSync('docker', ['exec', '-i', process.env.QA_PG_CONTAINER ?? 'qs-pg', 'psql', '-U', 'supabase_admin', '-d', 'wacrm', '-At', '-v', 'ON_ERROR_STOP=1', '-c', q], { encoding: 'utf8' }).trim()

let db: SupabaseClient
const A = randomUUID(), B = randomUUID(), SPREAD = 'S'.repeat(30)
const USER = randomUUID(), USER_B = randomUUID()

function order(account: string, o: { status?: string; price: number; qty: number; product?: string; items?: [string, number, number][]; at?: string; seller?: string } ): string {
  const id = randomUUID()
  sql(`insert into order_confirmations (id, account_id, confirmed_by_name, customer_name, destination, phone, price, product, quantity, request_key, seller_name, confirmed_at, delivery_status, acknowledged_at, order_status)
       values ('${id}','${account}','Asesor QA','Cliente Sintetico','Lima','51900000000',${o.price},'${o.product ?? 'Producto QA'}',${o.qty},'${randomUUID()}','${o.seller ?? 'Vendedor Uno'}','${o.at ?? '2026-11-04T15:00:00Z'}','${o.status ?? 'acknowledged'}',${(o.status ?? 'acknowledged') === 'acknowledged' ? 'now()' : 'null'},'Pedido confirmado')`)
  ;(o.items ?? []).forEach(([name, q, unit], i) => sql(`insert into order_confirmation_items (order_id, account_id, line_number, product_name, quantity, unit_price) values ('${id}','${account}',${i + 1},'${name}',${q},${unit})`))
  return id
}
const run = (api: SheetsApi, acct = A, opts = {}) => runSheetsExport(db, api, acct, opts)
const makeDue = () => sql(`update order_sheet_exports set next_attempt_at = now() where status = 'pending'`)

describe.skipIf(!E2E)('Sheets export (isolated DB)', { timeout: 90_000 }, () => {
  beforeAll(() => {
    if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(URL_)) throw new Error('refusing to run: NEXT_PUBLIC_SUPABASE_URL must be loopback')
    db = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
    for (const [id, n, owner] of [[A, 'a', USER], [B, 'b', USER_B]]) {
      sql(`insert into auth.users (id) values ('${owner}') on conflict do nothing`)
      sql(`insert into accounts (id, name, owner_user_id) values ('${id}','QA ${n}','${owner}') on conflict do nothing`)
      expect(sql(`select count(*) from accounts where id = '${id}'`)).toBe('1')
    }
  })
  beforeEach(() => {
    sql(`truncate order_sheet_events, order_sheet_exports, order_sheet_exclusions, order_sheet_destinations, order_confirmation_items, order_confirmations cascade`)
    sql(`insert into order_sheet_destinations (account_id, spreadsheet_id, enabled) values ('${A}','${SPREAD}',true)`)
  })

  it('exports only acknowledged orders, one row per line, and reconciles with zero differences', async () => {
    const multi = order(A, { price: 145, qty: 2, product: 'x', items: [['Hidrolavadora INGCO 2030 PSI', 1, 95], ['Paquete de 100 discos', 1, 50]] })
    const trad = order(A, { price: 80, qty: 2 })
    order(A, { status: 'held', price: 10, qty: 1 }); order(A, { status: 'pending', price: 11, qty: 1 })
    const test = order(A, { price: 5, qty: 1 }); sql(`insert into order_sheet_exclusions (order_id, account_id, reason) values ('${test}','${A}','test')`)
    const sheet = new FakeSheet(); const r = await run(sheet)
    expect(r).toMatchObject({ discovered: 3, exported: 2, appendedLines: 3 })
    expect(sheet.data).toHaveLength(3)
    expect(sheet.data.filter((x) => x[HEADERS.indexOf('ID pedido')] === multi)).toHaveLength(2)
    const rep = await reconcileAccount(db, sheet, A)
    expect(rep).toMatchObject({ differences: 0, eligibleOrders: 2, eligibleLines: 3, eligibleUnits: 4, eligibleCents: 22500, sheetLines: 3, excludedOrders: 1, notAcknowledgedOrders: 2 })
    expect(rep.excludedByReason).toEqual({ test: 1 })
    void trad
  })

  it('re-running adds nothing and changes nothing', async () => {
    order(A, { price: 50, qty: 1 }); order(A, { price: 145, qty: 2, items: [['P1', 1, 95], ['P2', 1, 50]] })
    const sheet = new FakeSheet(); await run(sheet)
    const snap = JSON.stringify(sheet.data), jobs = sql(`select md5(string_agg(order_id::text||status||attempts||exported_lines, ',' order by order_id)) from order_sheet_exports`)
    const r2 = await run(sheet), r3 = await run(sheet)
    expect(r2).toMatchObject({ claimed: 0, appendedLines: 0 }); expect(r3.appendedLines).toBe(0)
    expect(JSON.stringify(sheet.data)).toBe(snap)
    expect(sql(`select md5(string_agg(order_id::text||status||attempts||exported_lines, ',' order by order_id)) from order_sheet_exports`)).toBe(jobs)
  })

  it('ambiguous append (Google applied it, answer lost): next run reconciles and does NOT write again', async () => {
    order(A, { price: 145, qty: 2, items: [['P1', 1, 95], ['P2', 1, 50]] })
    const sheet = new FakeSheet(); sheet.fault = 'apply_then_fail'
    const r1 = await run(sheet)
    expect(r1.error).toBe('network'); expect(sheet.data).toHaveLength(2); expect(sql(`select status from order_sheet_exports`)).toBe('pending')
    makeDue(); const r2 = await run(sheet)
    expect(r2).toMatchObject({ exported: 1, alreadyPresent: 1, appendedLines: 0 }); expect(sheet.data).toHaveLength(2)
  })

  it('write that never reached Google is retried exactly once', async () => {
    order(A, { price: 50, qty: 1 }); const sheet = new FakeSheet(); sheet.fault = 'fail_before'
    await run(sheet); expect(sheet.data).toHaveLength(0)
    makeDue(); await run(sheet); expect(sheet.data).toHaveLength(1)
  })

  it('Sheets down: the commercial order is untouched, job backs off, then recovers; dead after max attempts and requeue works', async () => {
    const id = order(A, { price: 50, qty: 1 }); const before = sql(`select md5(o::text) from order_confirmations o where id='${id}'`)
    const sheet = new FakeSheet(); sheet.fault = 'always_503'
    for (let i = 0; i < 7; i++) { await run(sheet); makeDue() }
    const last = await run(sheet)
    expect(last).toMatchObject({ dead: 1, deadOutstanding: 1 })
    expect(sql(`select status||':'||attempts from order_sheet_exports`)).toBe('dead:8')
    expect(sql(`select md5(o::text) from order_confirmations o where id='${id}'`)).toBe(before)   // delivery_status, inkaclick fields: unchanged
    sheet.fault = 'none'; expect((await run(sheet)).claimed).toBe(0)
    expect(sql(`select order_sheet_requeue('${A}')`)).toBe('1'); await run(sheet)
    expect(sheet.data).toHaveLength(1); expect(sql(`select status from order_sheet_exports`)).toBe('exported')
  })

  it('crash recovery: a job left processing by a dead worker is picked up after its lock expires', async () => {
    order(A, { price: 50, qty: 1 })
    await db.rpc('order_sheet_enqueue', { p_account: A })
    const tok = (await db.rpc('order_sheet_acquire', { p_account: A })).data as string
    expect(((await db.rpc('order_sheet_claim', { p_account: A, p_token: tok })).data as unknown[]).length).toBe(1)   // worker "dies" here, lease and lock still set
    const sheet = new FakeSheet()
    expect((await run(sheet)).skipped).toBe('lease_held')
    sql(`update order_sheet_destinations set lease_expires_at = now() - interval '1 second'; update order_sheet_exports set locked_until = now() - interval '1 second'`)
    expect(await run(sheet)).toMatchObject({ exported: 1 }); expect(sheet.data).toHaveLength(1)
    expect(sql(`select order_sheet_complete(order_id, '${tok}', 1, 1, 50) from order_sheet_exports`)).toBe('f')   // the dead worker can no longer record anything
  })

  it('concurrent workers never duplicate a line', async () => {
    for (let i = 0; i < 12; i++) order(A, { price: 90, qty: 2, items: [['P1', 1, 40], ['P2', 1, 50]] })
    const sheet = new FakeSheet()
    await Promise.all([run(sheet, A, { batch: 4 }), run(sheet, A, { batch: 4 }), run(sheet, A, { batch: 4 })])
    await run(sheet, A, { batch: 4 })
    const keys = sheet.data.map((r) => r[KEY_COLUMN_INDEX]); expect(new Set(keys).size).toBe(keys.length); expect(keys).toHaveLength(24)
    expect((await reconcileAccount(db, sheet, A)).differences).toBe(0)
  })

  it('accounts are separated: a disabled account is never exported, another account only reaches its own sheet', async () => {
    order(A, { price: 50, qty: 1 }); const ob = order(B, { price: 70, qty: 1 })
    sql(`insert into order_sheet_destinations (account_id, spreadsheet_id, enabled) values ('${B}','${'T'.repeat(30)}',false)`)
    const sa = new FakeSheet(), sb = new FakeSheet()
    expect((await run(sb, B)).skipped).toBe('destination_off'); await run(sa, A)
    expect(sa.data).toHaveLength(1); expect(sb.data).toHaveLength(0)
    sql(`update order_sheet_destinations set enabled = true where account_id = '${B}'`); await run(sb, B)
    expect(sb.data.map((r) => r[HEADERS.indexOf('ID pedido')])).toEqual([ob]); expect(sa.data.map((r) => r[HEADERS.indexOf('ID pedido')])).not.toContain(ob)
  })

  it('refuses to write when the sheet layout was altered, and claims nothing', async () => {
    order(A, { price: 50, qty: 1 }); const sheet = new FakeSheet(); sheet.header[3] = 'DNI?'
    expect((await run(sheet)).error).toBe('layout_mismatch'); expect(sheet.data).toHaveLength(0)
    expect(sql(`select status||attempts from order_sheet_exports`)).toBe('pending0')
  })

  it('inconsistent order data is quarantined (dead), never guessed', async () => {
    const id = order(A, { price: 145, qty: 2, items: [['P1', 1, 95], ['P2', 1, 50]] })
    sql(`alter table order_confirmations disable trigger user; update order_confirmations set price = 150 where id = '${id}'; alter table order_confirmations enable trigger user`)
    const sheet = new FakeSheet(); await run(sheet)
    expect(sheet.data).toHaveLength(0); expect(sql(`select status||':'||last_error_code from order_sheet_exports`)).toBe('dead:total_mismatch')
  })

  it('eligible_since limits the historical scope; only service_role can call the functions', async () => {
    order(A, { price: 50, qty: 1, at: '2026-10-01T15:00:00Z' }); order(A, { price: 60, qty: 1, at: '2026-11-04T15:00:00Z' })
    sql(`update order_sheet_destinations set eligible_since = '2026-11-01T00:00:00Z'`)
    const sheet = new FakeSheet(); await run(sheet); expect(sheet.data).toHaveLength(1)
    expect((await reconcileAccount(db, sheet, A))).toMatchObject({ differences: 0, beforeEligibleSince: 1 })
    expect(sql(`select has_function_privilege('anon','order_sheet_claim(uuid,uuid,integer,integer,integer)','execute')::text||has_function_privilege('authenticated','order_sheet_enqueue(uuid,integer)','execute')::text||has_function_privilege('service_role','order_sheet_enqueue(uuid,integer)','execute')::text`)).toBe('falsefalsetrue')
  })

  // ---- regression tests for the review of PR #82 ----
  it('reconcile detects a changed product or seller even when quantity and price are untouched', async () => {
    order(A, { price: 50, qty: 1, product: 'Producto A', seller: 'Vendedor Uno' }); order(A, { price: 70, qty: 2, product: 'Producto B', seller: 'Vendedor Uno' }); order(A, { price: 90, qty: 3, product: 'Producto C' })
    const sheet = new FakeSheet(); await run(sheet)
    expect((await reconcileAccount(db, sheet, A)).differences).toBe(0)
    sheet.data[0][HEADERS.indexOf('Producto')] = 'Producto ALTERADO'
    sheet.data[1][HEADERS.indexOf('Vendedor')] = 'Otro Vendedor'
    sheet.data[2][HEADERS.indexOf('Hash de fila')] = 'deadbeef'
    const rep = await reconcileAccount(db, sheet, A)
    expect(rep.lineMismatches).toHaveLength(0); expect(rep.contentMismatches).toHaveLength(3); expect(rep.differences).toBe(3)
    expect(rep.contentMismatches.join(' ')).toMatch(/Producto/); expect(rep.contentMismatches.join(' ')).toMatch(/Vendedor/); expect(rep.contentMismatches.join(' ')).toMatch(/Hash de fila/)
    expect(JSON.stringify(rep)).not.toContain('ALTERADO'); expect(JSON.stringify(rep)).not.toContain('Otro Vendedor')   // names of columns only, no values
  })

  it('an existing key whose row was altered is NOT marked exported and is never overwritten', async () => {
    order(A, { price: 145, qty: 2, items: [['P1', 1, 95], ['P2', 1, 50]] })
    const sheet = new FakeSheet(); sheet.fault = 'apply_then_fail'
    await run(sheet)                                                    // both lines are in the sheet, the job is still pending
    sheet.data[0][HEADERS.indexOf('Producto')] = 'EDITADO A MANO'      // somebody edits line 1 before the retry
    const snapshot = JSON.stringify(sheet.data); makeDue()
    const r = await run(sheet)
    expect(r).toMatchObject({ exported: 0, mismatched: 1, appendedLines: 0, deadOutstanding: 1 })
    expect(JSON.stringify(sheet.data)).toBe(snapshot)                  // not repaired, not overwritten, not appended
    expect(sql(`select status||':'||last_error_code from order_sheet_exports`)).toBe('dead:row_content_mismatch')
    expect(sql(`select count(*) from order_sheet_events where event = 'row_content_mismatch' and detail::text not like '%EDITADO%'`)).toBe('1')
  })

  it('an altered existing line also blocks appending the missing lines of the same order', async () => {
    order(A, { price: 145, qty: 2, items: [['P1', 1, 95], ['P2', 1, 50]] })
    const sheet = new FakeSheet(); await run(sheet)
    const first = sheet.data[0]; sheet.data = [first.slice() as never]; first[HEADERS.indexOf('Vendedor')] = 'Cambiado'
    sheet.data = [first]                                                // only line 1 present, and altered
    sql(`update order_sheet_exports set status = 'pending', exported_lines = null, exported_at = null`)
    const r = await run(sheet)
    expect(r.mismatched).toBe(1); expect(sheet.data).toHaveLength(1)
  })

  it('two accounts cannot be configured with the same spreadsheet file', () => {
    expect(() => sql(`insert into order_sheet_destinations (account_id, spreadsheet_id, enabled) values ('${B}','${SPREAD}',false)`)).toThrow(/duplicate key|unique/i)
    sql(`insert into order_sheet_destinations (account_id, spreadsheet_id, enabled) values ('${B}','${'U'.repeat(30)}',false)`)   // a different file is fine
    expect(() => sql(`update order_sheet_destinations set spreadsheet_id = '${SPREAD}' where account_id = '${B}'`)).toThrow(/duplicate key|unique/i)
  })

  it('the prepared test-exclusion SQL refuses to run unless exactly the two verified orders exist (guards)', () => {
    order(A, { price: 50, qty: 1 })
    const file = execFileSync('cat', ['scripts/ops/orders-sheets/exclude-test-orders.sql'], { encoding: 'utf8' })
    expect(() => execFileSync('docker', ['exec', '-i', process.env.QA_PG_CONTAINER ?? 'qs-pg', 'psql', '-U', 'supabase_admin', '-d', 'wacrm', '-At', '-v', 'ON_ERROR_STOP=1'], { input: file, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })).toThrow()
    expect(sql(`select count(*) from order_sheet_exclusions`)).toBe('0')
  })
})
