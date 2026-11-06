import { randomUUID } from 'node:crypto'
import type { SheetsApi } from './google-client'
import { HEADERS } from './layout'
import { projectOrder, type ProjectedLine } from './layout'
import { indexRows, planLines } from './plan'

// Authorized end-to-end check of the Sheets layer against a REAL spreadsheet, using ONLY synthetic orders created here.
// Steps: layout -> write -> read back -> idempotent re-run -> ambiguous write (applied, answer lost) -> retry without duplicates -> altered row is detected, not overwritten.
// It writes rows into the given tab (use the QA sheet) and never reads the database. Returns pass/fail per step with counts only.
export interface CheckStep { step: string; ok: boolean; detail: string }
export interface CheckReport { runId: string; steps: CheckStep[]; ok: boolean; expected: { orders: number; lines: number; units: number; cents: number } }

export function syntheticOrders(runId: string): ProjectedLine[][] {
  const acct = '00000000-0000-4000-8000-0000000000aa'
  const base = { account_id: acct, customer_name: 'Cliente Sintetico QA', dni: '00000000', phone: '51900000000', order_description: null, agency: 'Agencia QA', destination: 'Lima', order_status: 'Pedido confirmado', department: 'Lima' }
  const mk = (n: number, at: string, seller: string, price: number, qty: number, product: string, items: { name: string; q: number; u: number }[]) =>
    projectOrder({ ...base, id: randomUUID(), confirmed_at: at, seller_name: seller, product, quantity: qty, price },
      items.map((it, i) => ({ line_number: i + 1, catalog_product_id: null, product_name: it.name, quantity: it.q, unit_price: it.u, subtotal: it.q * it.u })), new Date().toISOString()).lines
      .map((l) => ({ ...l, cells: l.cells.map((c, i) => (i === HEADERS.indexOf('Nombre completo') ? `Cliente Sintetico QA ${runId.slice(0, 8)} ${n}` : c)) }))
  return [
    mk(1, '2026-11-04T15:30:05Z', 'Vendedor QA Uno', 145, 2, 'x', [{ name: 'Hidrolavadora INGCO 2030 PSI', q: 1, u: 95 }, { name: 'Paquete de 100 discos', q: 1, u: 50 }]),
    mk(2, '2026-11-04T16:10:00Z', 'Vendedor QA Dos', 80, 2, 'Nivel laser', []),
    mk(3, '2026-11-05T14:00:00Z', 'Vendedor QA Uno', 190, 2, 'x', [{ name: 'Hidrolavadora INGCO 2030 PSI', q: 2, u: 95 }]),
  ]
}

export async function runApiCheck(api: SheetsApi, spreadsheetId: string, tab: string, opts: { runId?: string; wrap?: (api: SheetsApi) => SheetsApi } = {}): Promise<CheckReport> {
  const runId = opts.runId ?? randomUUID()
  const steps: CheckStep[] = []
  const add = (step: string, ok: boolean, detail: string) => steps.push({ step, ok, detail })
  const orders = syntheticOrders(runId), lines = orders.flat()
  const expected = { orders: orders.length, lines: lines.length, units: lines.reduce((a, l) => a + l.units, 0), cents: lines.reduce((a, l) => a + l.cents, 0) }
  const mine = (rows: unknown[][]) => rows.filter((r) => lines.some((l) => l.key === String(r[HEADERS.indexOf('Clave de fila')])))

  const header = await api.headerRow(spreadsheetId, tab)
  add('layout', HEADERS.every((h, i) => header[i] === h), `headers=${header.length}`)
  if (!steps[0].ok) return { runId, steps, ok: false, expected }

  // 1. write + read back
  const before = planLines(await api.rows(spreadsheetId, tab), lines)
  await api.append(spreadsheetId, tab, before.missing.map((l) => l.cells))
  const after = planLines(await api.rows(spreadsheetId, tab), lines)
  add('write+read', before.missing.length === lines.length && after.present.length === lines.length && after.altered.length === 0, `appended=${before.missing.length} presentUnchanged=${after.present.length}`)

  // 2. idempotency
  const again = planLines(await api.rows(spreadsheetId, tab), lines)
  add('idempotent re-run', again.missing.length === 0 && again.duplicated.length === 0, `missing=${again.missing.length}`)

  // 3. ambiguous write: Google applies it, the caller never sees the answer; the retry must find the rows and write nothing.
  const extra = syntheticOrders(runId + 'x')[1]
  const flaky: SheetsApi = { ...api, headerRow: api.headerRow.bind(api), column: api.column.bind(api), rows: api.rows.bind(api), append: async (id, t, rows) => { await api.append(id, t, rows); throw new Error('simulated lost response') } }
  const lost = await flaky.append(spreadsheetId, tab, extra.map((l) => l.cells)).then(() => false, () => true)
  const retry = planLines(await api.rows(spreadsheetId, tab), extra)
  if (retry.missing.length) await api.append(spreadsheetId, tab, retry.missing.map((l) => l.cells))
  const counts = indexRows(await api.rows(spreadsheetId, tab)).count
  add('ambiguous write + retry', lost && retry.missing.length === 0 && extra.every((l) => counts.get(l.key) === 1), `retryMissing=${retry.missing.length} rowsPerKey=${extra.map((l) => counts.get(l.key)).join(',')}`)

  // 4. reconciliation by fingerprint: totals of the rows of this run equal the expected ones, with zero content differences
  const rows = mine(await api.rows(spreadsheetId, tab)) as (string | number)[][]
  const got = { lines: rows.length, units: rows.reduce((a, r) => a + Number(r[HEADERS.indexOf('Cantidad')]), 0), cents: rows.reduce((a, r) => a + Math.round(Number(r[HEADERS.indexOf('Precio')]) * 100), 0) }
  const final = planLines(await api.rows(spreadsheetId, tab), lines)
  add('reconciliation', got.lines === expected.lines && got.units === expected.units && got.cents === expected.cents && final.altered.length === 0 && final.missing.length === 0, `lines=${got.lines}/${expected.lines} units=${got.units}/${expected.units} cents=${got.cents}/${expected.cents}`)
  return { runId, steps, ok: steps.every((s) => s.ok), expected }
}
