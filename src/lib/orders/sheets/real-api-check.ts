import { randomUUID } from 'node:crypto'
import type { SheetsApi } from './google-client'
import { HEADERS, projectOrder, rowFingerprint, type ProjectedLine } from './layout'
import { indexRows, planLines } from './plan'

// Authorized end-to-end check of the Sheets layer against a REAL spreadsheet, using ONLY synthetic orders created here.
// Scenario: 4 synthetic orders / 5 lines (3 orders / 4 lines written normally + 1 order / 1 line written through the ambiguous-response simulation). Steps: layout -> write -> read back -> idempotent re-run -> ambiguous write (applied, answer lost) -> retry without duplicates -> altered row is detected, not overwritten.
// It writes rows into the given tab (use the QA sheet) and never reads the database. Returns pass/fail per step with counts only.
export interface CheckStep { step: string; ok: boolean; detail: string }
export interface CheckReport { runId: string; steps: CheckStep[]; ok: boolean; expected: { orders: number; lines: number; units: number; cents: number } }

export interface SyntheticRun { main: ProjectedLine[][]; ambiguous: ProjectedLine[] }

// 3 orders written normally (4 lines) + 1 order written through the "lost response" simulation (1 line) = 4 orders / 5 lines / 8 units / S/ 495.00.
// The customer name carries the run id, and it is part of the projection BEFORE the row fingerprint is computed, so every fingerprint matches its row.
export function syntheticOrders(runId: string): SyntheticRun {
  const acct = '00000000-0000-4000-8000-0000000000aa'
  const mk = (n: number, at: string, seller: string, price: number, qty: number, product: string, items: { name: string; q: number; u: number }[]) =>
    projectOrder({
      id: randomUUID(), account_id: acct, confirmed_at: at, customer_name: `Cliente Sintetico QA ${runId.slice(0, 8)} ${n}`, dni: '00000000', phone: '51900000000',
      product, quantity: qty, price, order_description: null, agency: 'Agencia QA', destination: 'Lima', seller_name: seller, order_status: 'Pedido confirmado', department: 'Lima',
    }, items.map((it, i) => ({ line_number: i + 1, catalog_product_id: null, product_name: it.name, quantity: it.q, unit_price: it.u, subtotal: it.q * it.u })), new Date().toISOString()).lines
  return {
    main: [
      mk(1, '2026-11-04T15:30:05Z', 'Vendedor QA Uno', 145, 2, 'x', [{ name: 'Hidrolavadora INGCO 2030 PSI', q: 1, u: 95 }, { name: 'Paquete de 100 discos', q: 1, u: 50 }]),
      mk(2, '2026-11-04T16:10:00Z', 'Vendedor QA Dos', 80, 2, 'Nivel laser', []),
      mk(3, '2026-11-05T14:00:00Z', 'Vendedor QA Uno', 190, 2, 'x', [{ name: 'Hidrolavadora INGCO 2030 PSI', q: 2, u: 95 }]),
    ],
    ambiguous: mk(4, '2026-11-05T20:45:00Z', 'Vendedor QA Dos', 80, 2, 'Nivel laser', []),
  }
}

export async function runApiCheck(api: SheetsApi, spreadsheetId: string, tab: string, opts: { runId?: string } = {}): Promise<CheckReport> {
  const runId = opts.runId ?? randomUUID()
  const steps: CheckStep[] = []
  const add = (step: string, ok: boolean, detail: string) => steps.push({ step, ok, detail })
  const run = syntheticOrders(runId)
  const orders = [...run.main, run.ambiguous], lines = orders.flat()
  const expected = { orders: orders.length, lines: lines.length, units: lines.reduce((a, l) => a + l.units, 0), cents: lines.reduce((a, l) => a + l.cents, 0) }
  const mine = (rows: unknown[][]) => rows.filter((r) => lines.some((l) => l.key === String(r[HEADERS.indexOf('Clave de fila')])))

  const header = await api.headerRow(spreadsheetId, tab)
  add('layout', HEADERS.every((h, i) => header[i] === h), `headers=${header.length}`)
  if (!steps[0].ok) return { runId, steps, ok: false, expected }

  // 1. write + read back (3 orders, 4 lines)
  const main = run.main.flat()
  const before = planLines(await api.rows(spreadsheetId, tab), main)
  await api.append(spreadsheetId, tab, before.missing.map((l) => l.cells))
  const after = planLines(await api.rows(spreadsheetId, tab), main)
  add('write+read', before.missing.length === main.length && after.present.length === main.length && after.altered.length === 0, `appended=${before.missing.length} presentUnchanged=${after.present.length}`)

  // 2. idempotency
  const again = planLines(await api.rows(spreadsheetId, tab), main)
  add('idempotent re-run', again.missing.length === 0 && again.duplicated.length === 0, `missing=${again.missing.length}`)

  // 3. ambiguous write (the 4th order): Google applies it, the caller never sees the answer; the retry must find the row and write nothing.
  const amb = run.ambiguous
  const lost = await api.append(spreadsheetId, tab, amb.map((l) => l.cells)).then(() => { throw new Error('simulated lost response') }).catch(() => true)
  const retry = planLines(await api.rows(spreadsheetId, tab), amb)
  if (retry.missing.length) await api.append(spreadsheetId, tab, retry.missing.map((l) => l.cells))
  const counts = indexRows(await api.rows(spreadsheetId, tab)).count
  add('ambiguous write + retry', lost === true && retry.missing.length === 0 && amb.every((l) => counts.get(l.key) === 1), `retryMissing=${retry.missing.length} rowsPerKey=${amb.map((l) => counts.get(l.key)).join(',')}`)

  // 4. reconciliation of content, amounts and quantities for the whole run; the stored fingerprint must equal the one recomputed from the row read back.
  const rows = mine(await api.rows(spreadsheetId, tab)) as (string | number)[][]
  const got = { lines: rows.length, units: rows.reduce((a, r) => a + Number(r[HEADERS.indexOf('Cantidad')]), 0), cents: rows.reduce((a, r) => a + Math.round(Number(r[HEADERS.indexOf('Precio')]) * 100), 0) }
  const fpOk = rows.every((r) => String(r[HEADERS.indexOf('Hash de fila')]) === rowFingerprint(r))
  const final = planLines(await api.rows(spreadsheetId, tab), lines)
  add('reconciliation', got.lines === expected.lines && got.units === expected.units && got.cents === expected.cents && final.altered.length === 0 && final.missing.length === 0 && fpOk,
    `lines=${got.lines}/${expected.lines} units=${got.units}/${expected.units} cents=${got.cents}/${expected.cents} fingerprints=${fpOk ? 'ok' : 'BAD'}`)
  return { runId, steps, ok: steps.every((s) => s.ok), expected }
}
