// The BODY variables of the operational template ({{1}}, {{2}}, ...) are filled from the order, in the order the account's settings list them
// (order_logistics_settings.packaging_template_params). Nothing about the template (name, language, variables, header) is hardcoded: the real template
// is not defined yet, so only the MECHANISM exists here. Pure function, unit-tested.

export const TEMPLATE_PARAM_FIELDS = ['customer_name', 'product', 'quantity', 'total', 'destination', 'seller_name', 'dni', 'pending_balance', 'payment_instructions', 'shalom_number', 'shalom_code'] as const
export type TemplateParamField = (typeof TEMPLATE_PARAM_FIELDS)[number]

/**
 * WhatsApp does not accept an empty template parameter. What goes in when a value is empty (typically the DNI, which is optional on an order) is a
 * business decision that is STILL PENDING (DECISIÓN PENDIENTE: exact wording for an empty DNI); this neutral placeholder keeps the send valid until it is
 * decided, and lives in ONE place.
 */
export const EMPTY_PARAM_FALLBACK = '-'

const MAX_PARAM_LENGTH = 200

export interface OrderForTemplate {
  customer_name: string
  product_summary: string
  quantity: number
  total: number
  destination: string
  seller_name: string
  dni: string | null
  /**
   * The PR-06 pending balance already formatted for a template (e.g. "S/ 150.00"), or `null` when it is NOT AVAILABLE (the order is not tracked / payments are off).
   * `null` is never turned into zero: a template that asks for it is refused instead.
   */
  pending_balance?: string | null
  /** The account's configured one-line payment instructions, or `null` when none is configured. */
  payment_instructions?: string | null
  /** The registered Shalom guide (order number and code), or `null` when the shipment has none. */
  shalom_number?: string | null
  shalom_code?: string | null
}

/** Why a template cannot be filled. Configuration / data problems: a retry cannot fix them by itself. */
export type TemplateParamError = 'invalid_params_config' | 'pending_balance_unavailable' | 'payment_instructions_not_configured' | 'shalom_guide_unavailable'

/** Meta rejects newlines / tabs and long runs of spaces inside a parameter: flatten them, trim and cap the length. */
export function sanitizeParam(value: string): string {
  const flat = value.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim()
  return flat.slice(0, MAX_PARAM_LENGTH)
}

export function isTemplateParamField(value: unknown): value is TemplateParamField {
  return typeof value === 'string' && (TEMPLATE_PARAM_FIELDS as readonly string[]).includes(value)
}

export function buildTemplateBodyParams(order: OrderForTemplate, fields: readonly unknown[]): { ok: true; params: string[] } | { ok: false; error: TemplateParamError } {
  const params: string[] = []
  for (const field of fields) {
    if (!isTemplateParamField(field)) return { ok: false, error: 'invalid_params_config' }
    // Values that must never be invented: refuse instead of sending a made-up one (a missing balance is NOT zero).
    if (field === 'pending_balance' && (order.pending_balance ?? null) === null) return { ok: false, error: 'pending_balance_unavailable' }
    if (field === 'payment_instructions' && (order.payment_instructions ?? null) === null) return { ok: false, error: 'payment_instructions_not_configured' }
    if ((field === 'shalom_number' && !order.shalom_number) || (field === 'shalom_code' && !order.shalom_code)) return { ok: false, error: 'shalom_guide_unavailable' }
    const raw: string | null =
      field === 'customer_name' ? order.customer_name
      : field === 'product' ? order.product_summary
      : field === 'quantity' ? String(order.quantity)
      : field === 'total' ? order.total.toFixed(2)
      : field === 'destination' ? order.destination
      : field === 'seller_name' ? order.seller_name
      : field === 'pending_balance' ? order.pending_balance ?? null
      : field === 'payment_instructions' ? order.payment_instructions ?? null
      : field === 'shalom_number' ? order.shalom_number ?? null
      : field === 'shalom_code' ? order.shalom_code ?? null
      : order.dni
    const clean = sanitizeParam(raw ?? '')
    params.push(clean === '' ? EMPTY_PARAM_FALLBACK : clean)
  }
  return { ok: true, params }
}
