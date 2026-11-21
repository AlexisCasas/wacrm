import { maskTail, nameTokens, normalizeAmount, normalizeDni, normalizePhone } from '@/lib/orders/logistics/normalize'

// Comparison of what the OCR read against the order the voucher belongs to (the review screen shows the differences; it never decides anything).
// The order is already determined by context, so this is VALIDATION, not matching. All thresholds live here, centralized and testable.

export const COMPARISON_CONFIG = {
  /** amount: absolute tolerance in currency units. */
  amountTolerance: 0.005,
  /** customer_name: share of the shorter name's words that must appear in the other name... */
  nameMinOverlap: 0.75,
  /** ...and at least this many words must be shared. */
  nameMinSharedWords: 2,
} as const

export type ComparableField = 'dni' | 'phone' | 'customer_name' | 'amount'
export type ComparisonStatus = 'match' | 'mismatch' | 'missing' | 'not_comparable'

export interface FieldComparison {
  field: ComparableField
  status: ComparisonStatus
  /** What the OCR read (voucher content: visible to the reviewer). */
  ocr_value: string | null
  /** What the order has. DNI and phone are only ever shown masked (PR-02 deliberately keeps them out of its API). */
  order_value: string | null
}

export interface OrderForComparison {
  customer_name: string
  dni: string | null
  phone: string
  price: number | string
}

const valueOf = (fields: Record<string, { value?: unknown }>, key: string): string | null => {
  const v = fields[key]?.value
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

export function compareWithOrder(fields: Record<string, { value?: unknown }>, order: OrderForComparison): FieldComparison[] {
  const out: FieldComparison[] = []

  // dni
  {
    const ocr = valueOf(fields, 'dni')
    const orderDni = normalizeDni(order.dni)
    const ocrDni = normalizeDni(ocr)
    out.push({
      field: 'dni',
      ocr_value: ocr,
      order_value: orderDni ? maskTail(orderDni) : null,
      status: !ocr ? 'missing' : !orderDni || !ocrDni ? 'not_comparable' : ocrDni === orderDni ? 'match' : 'mismatch',
    })
  }

  // phone
  {
    const ocr = valueOf(fields, 'phone')
    const orderPhone = normalizePhone(order.phone)
    const ocrPhone = normalizePhone(ocr)
    out.push({
      field: 'phone',
      ocr_value: ocr,
      order_value: orderPhone ? maskTail(orderPhone) : null,
      status: !ocr ? 'missing' : !orderPhone || !ocrPhone ? 'not_comparable' : ocrPhone === orderPhone ? 'match' : 'mismatch',
    })
  }

  // customer_name
  {
    const ocr = valueOf(fields, 'customer_name')
    const a = new Set(nameTokens(ocr))
    const b = new Set(nameTokens(order.customer_name))
    const shared = [...a].filter((t) => b.has(t)).length
    const shorter = Math.min(a.size, b.size)
    let status: ComparisonStatus
    if (!ocr) status = 'missing'
    else if (shorter === 0) status = 'not_comparable'
    else status = shared >= COMPARISON_CONFIG.nameMinSharedWords && shared / shorter >= COMPARISON_CONFIG.nameMinOverlap ? 'match' : 'mismatch'
    out.push({ field: 'customer_name', ocr_value: ocr, order_value: order.customer_name, status })
  }

  // amount
  {
    const ocr = valueOf(fields, 'amount')
    const ocrAmount = normalizeAmount(ocr)
    const orderAmount = normalizeAmount(String(order.price))
    out.push({
      field: 'amount',
      ocr_value: ocr,
      order_value: orderAmount === null ? null : orderAmount.toFixed(2),
      status: !ocr ? 'missing' : ocrAmount === null || orderAmount === null ? 'not_comparable' : Math.abs(ocrAmount - orderAmount) <= COMPARISON_CONFIG.amountTolerance ? 'match' : 'mismatch',
    })
  }

  return out
}
