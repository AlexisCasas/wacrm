// Layout of the "Registro de pedidos" tab and the projection order -> rows. Pure functions, no I/O.
// One row per confirmed product line. General order data is repeated on every row; the order total lives in its own column and must never be summed.

export const LAYOUT_VERSION = 1

// A-N: the 14 original commercial columns (same order and names as the ManyChat-era sheet). O+: technical columns.
export const COMMERCIAL_HEADERS = [
  'Fecha', 'Fecha y hora', 'Nombre completo', 'DNI', 'Teléfono', 'Producto', 'Cantidad', 'Precio', 'Descripción de pedido',
  'Agencia', 'Destino', 'Vendedor', 'Estado de pedido', 'Departamento',
] as const
export const TECHNICAL_HEADERS = [
  'ID pedido', 'Línea', 'Clave de fila', 'Líneas del pedido', 'Unidades del pedido', 'Importe del pedido (no sumar)', 'Precio unitario',
  'Tipo', 'Cuenta', 'ID catálogo', 'Hash de fila', 'Exportado (UTC)', 'Versión de esquema',
] as const
export const HEADERS: readonly string[] = [...COMMERCIAL_HEADERS, ...TECHNICAL_HEADERS]
export const KEY_HEADER = 'Clave de fila'
export const KEY_COLUMN_INDEX = HEADERS.indexOf(KEY_HEADER)

export interface OrderInput {
  id: string
  account_id: string
  confirmed_at: string
  customer_name: string
  dni: string | null
  phone: string | null
  product: string
  quantity: number
  price: number | string
  order_description: string | null
  agency: string | null
  destination: string | null
  seller_name: string | null
  order_status: string
  department: string | null
}
export interface ItemInput {
  line_number: number
  catalog_product_id: string | null
  product_name: string
  quantity: number
  unit_price: number | string
  subtotal: number | string
}
export type Cell = string | number

export interface ProjectedLine {
  key: string
  cells: Cell[]
  cents: number
  units: number
}
export interface ProjectedOrder {
  orderId: string
  lines: ProjectedLine[]
  units: number
  totalCents: number
}

export class ProjectionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

export function toCents(v: number | string): number {
  const s = typeof v === 'number' ? v.toFixed(2) : String(v).trim()
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new ProjectionError('bad_amount', 'amount is not a decimal with at most 2 places')
  const [i, f = ''] = s.split('.')
  return Number(i) * 100 + Math.sign(Number(i) || 1) * Number((f + '00').slice(0, 2))
}
const money = (cents: number): number => cents / 100

// Google Sheets serial date for Lima wall-clock time (UTC-5, no DST), rounded to the second.
export function limaSerial(iso: string): { date: number; dateTime: number } {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) throw new ProjectionError('bad_timestamp', 'confirmed_at is not a timestamp')
  const lima = Math.floor(ms / 1000) - 5 * 3600
  const days = Math.floor(lima / 86400)
  const secs = lima - days * 86400
  const epoch = 25569 // 1970-01-01 as a Sheets serial
  return { date: epoch + days, dateTime: epoch + days + secs / 86400 }
}

const text = (v: string | null | undefined): string => (v ?? '').trim()

// Stable fingerprint of the commercial content of a row (columns A-N plus quantities), so drift between DB and sheet is detectable.
export function rowFingerprint(cells: Cell[]): string {
  const s = JSON.stringify(cells.slice(0, COMMERCIAL_HEADERS.length))
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}

export function projectOrder(o: OrderInput, items: ItemInput[], exportedAtIso: string): ProjectedOrder {
  const when = limaSerial(o.confirmed_at)
  const totalCents = toCents(o.price)
  const structured = items.length > 0
  const sorted = [...items].sort((a, b) => a.line_number - b.line_number)

  if (structured) {
    const sum = sorted.reduce((a, it) => a + toCents(it.subtotal), 0)
    if (sum !== totalCents) throw new ProjectionError('total_mismatch', 'sum of line subtotals differs from the order total')
    for (const it of sorted) if (toCents(it.unit_price) * it.quantity !== toCents(it.subtotal)) throw new ProjectionError('subtotal_mismatch', 'line subtotal is not quantity x unit price')
  }
  const src = structured
    ? sorted.map((it) => ({ line: it.line_number, product: it.product_name, qty: it.quantity, cents: toCents(it.subtotal), unit: money(toCents(it.unit_price)) as number | '', catalog: it.catalog_product_id ?? '' }))
    : [{ line: 1, product: o.product, qty: o.quantity, cents: totalCents, unit: '' as number | '', catalog: '' }]
  const units = src.reduce((a, l) => a + l.qty, 0)
  if (!structured && units !== o.quantity) throw new ProjectionError('units_mismatch', 'units mismatch')

  const lines = src.map((l): ProjectedLine => {
    const commercial: Cell[] = [
      when.date, when.dateTime, text(o.customer_name), text(o.dni), text(o.phone), text(l.product), l.qty, money(l.cents), text(o.order_description),
      text(o.agency), text(o.destination), text(o.seller_name), text(o.order_status), text(o.department),
    ]
    const key = `${o.id}:${l.line}`
    const cells: Cell[] = [
      ...commercial, o.id, l.line, key, src.length, units, money(totalCents), l.unit, structured ? 'multiproducto' : 'tradicional', o.account_id, l.catalog,
      rowFingerprint(commercial), exportedAtIso, LAYOUT_VERSION,
    ]
    return { key, cells, cents: l.cents, units: l.qty }
  })
  return { orderId: o.id, lines, units, totalCents }
}

// A1 column letter for a zero-based index.
export function columnLetter(index: number): string {
  let n = index + 1, s = ''
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26) }
  return s
}
export const quoteTab = (name: string): string => `'${name.replace(/'/g, "''")}'`
