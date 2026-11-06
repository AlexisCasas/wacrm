// Structured confirmed-order items. The exact same summary is stored in the
// frozen legacy header and sent unchanged to InkaClick; only WACRM keeps lines.
import { normalizePrice } from './fields'

export interface OrderItem {
  product_name: string
  catalog_product_id: string | null
  quantity: number
  unit_price: string
}

export type OrderItemsResult =
  | { ok: true; items: OrderItem[]; product: string; quantity: number; price: string }
  | { ok: false; error: 'invalid_items' | 'too_many_items' | 'invalid_product' | 'invalid_quantity' | 'invalid_price' | 'invalid_catalog_product' | 'too_long' | 'total_exceeded' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Money is in INTEGER cents, never accumulated as floats. */
export function priceToCents(price: string): number {
  const [units, cents] = price.split('.')
  return Number(units) * 100 + Number(cents)
}

export function validateOrderItems(raw: unknown): OrderItemsResult {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'invalid_items' }
  if (raw.length > 20) return { ok: false, error: 'too_many_items' }
  const items: OrderItem[] = []
  let units = 0
  let totalCents = 0
  for (const rawItem of raw) {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) return { ok: false, error: 'invalid_items' }
    const o = rawItem as Record<string, unknown>
    const product_name = typeof o.product_name === 'string' ? o.product_name.trim() : ''
    if (!product_name || product_name.length > 150 || /[\r\n\t]/.test(product_name)) return { ok: false, error: 'invalid_product' }
    const quantityRaw = o.quantity
    const quantity = typeof quantityRaw === 'number'
      ? quantityRaw
      : typeof quantityRaw === 'string' && /^\d{1,5}$/.test(quantityRaw.trim()) ? Number(quantityRaw.trim()) : NaN
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) return { ok: false, error: 'invalid_quantity' }
    const unit_price = normalizePrice(o.unit_price)
    if (!unit_price) return { ok: false, error: 'invalid_price' }
    const catalog_product_id = o.catalog_product_id === undefined || o.catalog_product_id === null || o.catalog_product_id === ''
      ? null : o.catalog_product_id
    if (catalog_product_id !== null && (typeof catalog_product_id !== 'string' || !UUID.test(catalog_product_id))) {
      return { ok: false, error: 'invalid_catalog_product' }
    }
    units += quantity
    totalCents += priceToCents(unit_price) * quantity
    if (units > 10000 || totalCents >= 1_000_000_000) return { ok: false, error: 'total_exceeded' }
    items.push({ product_name, quantity, unit_price, catalog_product_id })
  }
  const product = items.map((item) => `${item.quantity} x ${item.product_name}`).join('\n')
  if (product.length > 500) return { ok: false, error: 'too_long' }
  return {
    ok: true,
    items,
    product,
    quantity: units,
    price: `${Math.floor(totalCents / 100)}.${String(totalCents % 100).padStart(2, '0')}`,
  }
}
