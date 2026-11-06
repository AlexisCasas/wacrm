import type { SupabaseClient } from '@supabase/supabase-js'
import type { SheetsApi } from './google-client'
import { HEADERS, KEY_COLUMN_INDEX, ProjectionError, projectOrder, toCents, type ItemInput, type OrderInput } from './layout'
import { loadDestination } from './exporter'

// Read-only comparison DB <-> sheet. Output is aggregate counters plus order UUIDs of differences (no names, phones, DNIs or amounts per customer).

export interface ReconcileReport {
  eligibleOrders: number; eligibleLines: number; eligibleUnits: number; eligibleCents: number
  sheetOrders: number; sheetLines: number; sheetUnits: number; sheetCents: number
  missingKeys: string[]; extraKeys: string[]; duplicateKeys: string[]
  orderAmountMismatches: string[]; lineMismatches: string[]; projectionErrors: string[]
  excludedOrders: number; excludedByReason: Record<string, number>
  notAcknowledgedOrders: number; beforeEligibleSince: number
  jobsByStatus: Record<string, number>
  differences: number
}

async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999)
    if (error) throw new Error(`read failed: ${error.message}`)
    out.push(...(data ?? []))
    if ((data ?? []).length < 1000) return out
  }
}

export async function reconcileAccount(admin: SupabaseClient, api: SheetsApi, accountId: string): Promise<ReconcileReport> {
  const dest = await loadDestination(admin, accountId)
  if (!dest) throw new Error('no destination for account')
  const since = (await admin.from('order_sheet_destinations').select('eligible_since').eq('account_id', accountId).single()).data?.eligible_since as string | null

  const cols = 'id, account_id, confirmed_at, customer_name, dni, phone, product, quantity, price, order_description, agency, destination, seller_name, order_status, department, delivery_status'
  const all = await pageAll<OrderInput & { delivery_status: string }>((a, b) => admin.from('order_confirmations').select(cols).eq('account_id', accountId).order('id').range(a, b) as never)
  const items = await pageAll<ItemInput & { order_id: string }>((a, b) => admin.from('order_confirmation_items').select('order_id, line_number, catalog_product_id, product_name, quantity, unit_price, subtotal').eq('account_id', accountId).order('order_id').order('line_number').range(a, b) as never)
  const excl = await pageAll<{ order_id: string; reason: string }>((a, b) => admin.from('order_sheet_exclusions').select('order_id, reason').eq('account_id', accountId).order('order_id').range(a, b) as never)
  const exports = await pageAll<{ status: string }>((a, b) => admin.from('order_sheet_exports').select('status').eq('account_id', accountId).order('order_id').range(a, b) as never)
  const exclusion = new Map(excl.map((e) => [e.order_id, e.reason]))
  const byOrder = new Map<string, ItemInput[]>()
  for (const it of items) { const l = byOrder.get(it.order_id) ?? []; l.push(it); byOrder.set(it.order_id, l) }

  const r: ReconcileReport = {
    eligibleOrders: 0, eligibleLines: 0, eligibleUnits: 0, eligibleCents: 0, sheetOrders: 0, sheetLines: 0, sheetUnits: 0, sheetCents: 0,
    missingKeys: [], extraKeys: [], duplicateKeys: [], orderAmountMismatches: [], lineMismatches: [], projectionErrors: [],
    excludedOrders: 0, excludedByReason: {}, notAcknowledgedOrders: 0, beforeEligibleSince: 0, jobsByStatus: {}, differences: 0,
  }
  for (const e of exports) r.jobsByStatus[e.status] = (r.jobsByStatus[e.status] ?? 0) + 1

  const expected = new Map<string, { qty: number; cents: number; orderId: string }>()
  for (const o of all) {
    if (o.delivery_status !== 'acknowledged') { r.notAcknowledgedOrders++; continue }
    if (since && o.confirmed_at < since) { r.beforeEligibleSince++; continue }
    const why = exclusion.get(o.id)
    if (why) { r.excludedOrders++; r.excludedByReason[why] = (r.excludedByReason[why] ?? 0) + 1; continue }
    try {
      const p = projectOrder(o, byOrder.get(o.id) ?? [], '')
      r.eligibleOrders++; r.eligibleLines += p.lines.length; r.eligibleUnits += p.units; r.eligibleCents += p.totalCents
      for (const l of p.lines) expected.set(l.key, { qty: l.units, cents: l.cents, orderId: o.id })
    } catch (e) { r.projectionErrors.push(`${o.id}:${e instanceof ProjectionError ? e.code : 'error'}`) }
  }

  const rows = await api.rows(dest.spreadsheet_id, dest.registry_tab)
  const seen = new Map<string, number>()
  const sheetOrders = new Set<string>()
  const orderCents = new Map<string, number>()
  for (const row of rows) {
    const key = String(row[KEY_COLUMN_INDEX] ?? '')
    if (!key) continue
    seen.set(key, (seen.get(key) ?? 0) + 1)
    if ((seen.get(key) ?? 0) > 1) { r.duplicateKeys.push(key); continue }
    const qty = Number(row[HEADERS.indexOf('Cantidad')])
    const cents = toCents(Number(row[HEADERS.indexOf('Precio')]))
    r.sheetLines++; r.sheetUnits += qty; r.sheetCents += cents
    const orderId = String(row[HEADERS.indexOf('ID pedido')])
    sheetOrders.add(orderId)
    orderCents.set(orderId, (orderCents.get(orderId) ?? 0) + cents)
    const exp = expected.get(key)
    if (!exp) { r.extraKeys.push(key); continue }
    if (exp.qty !== qty || exp.cents !== cents) r.lineMismatches.push(key)
  }
  r.sheetOrders = sheetOrders.size
  for (const k of expected.keys()) if (!seen.has(k)) r.missingKeys.push(k)
  const perOrder = new Map<string, number>()
  for (const e of expected.values()) perOrder.set(e.orderId, (perOrder.get(e.orderId) ?? 0) + e.cents)
  for (const [id, c] of perOrder) if (orderCents.has(id) && orderCents.get(id) !== c) r.orderAmountMismatches.push(id)
  r.differences = r.missingKeys.length + r.extraKeys.length + r.duplicateKeys.length + r.lineMismatches.length + r.orderAmountMismatches.length + r.projectionErrors.length
    + Math.abs(r.eligibleLines - r.sheetLines) + Math.abs(r.eligibleUnits - r.sheetUnits) + Math.abs(r.eligibleCents - r.sheetCents) + Math.abs(r.eligibleOrders - r.sheetOrders)
  return r
}
