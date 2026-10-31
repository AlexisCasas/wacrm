// "Confirmar pedido": validation and normalisation of the 13 business fields. Pure, no I/O.
//
// Evidence behind what is required (InkaClick `confirmed_orders`, 4 054 orders, 2026-10-31):
//   * DNI is empty in 0.4 % and not 8 digits in 2.9 %: optional, with a warning (InkaClick only links a customer DNI when it has 8 digits).
//   * Destination is empty in 0.1 % and Seller was NULL in 83 % of the historical rows; both are required here (the seller is chosen from a
//     catalogue, and a missing destination makes the package undeliverable).
//   * `precio` is the order TOTAL (InkaClick computes `pago_restante = precio - pago_inicial`), and a price of 0 would flag it as paid.
//   * The phone must end up as `51` + 9 digits or InkaClick will not create the customer.

export const PERU_DEPARTMENTS = [
  'Amazonas', 'Áncash', 'Apurímac', 'Arequipa', 'Ayacucho', 'Cajamarca', 'Callao', 'Cusco', 'Huancavelica', 'Huánuco', 'Ica', 'Junín',
  'La Libertad', 'Lambayeque', 'Lima', 'Loreto', 'Madre de Dios', 'Moquegua', 'Pasco', 'Piura', 'Puno', 'San Martín', 'Tacna', 'Tumbes', 'Ucayali',
] as const

export interface OrderInput {
  customer_name?: unknown
  dni?: unknown
  phone?: unknown
  product?: unknown
  quantity?: unknown
  price?: unknown
  order_description?: unknown
  agency?: unknown
  destination?: unknown
  department?: unknown
}

export interface OrderFields {
  customer_name: string
  dni: string
  phone: string
  product: string
  quantity: number
  /** Decimal string with exactly two decimals: never a float. */
  price: string
  order_description: string
  agency: string
  destination: string
  department: string
}

export type OrderFieldName = keyof OrderFields

export interface OrderValidation {
  ok: boolean
  value: OrderFields | null
  errors: Partial<Record<OrderFieldName, string>>
  warnings: Partial<Record<OrderFieldName, string>>
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
const DEPARTMENT_BY_KEY = new Map<string, string>(PERU_DEPARTMENTS.map((d) => [fold(d), d]))

function text(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\r\n/g, '\n').trim() : typeof raw === 'number' ? String(raw) : ''
}

/** `51` + 9 digits, from `9XXXXXXXX`, `519XXXXXXXX`, `+51 9XX XXX XXX`, etc. The phone is always TEXT (a spreadsheet number loses leading digits). */
export function normalizePeruPhone(raw: unknown): string | null {
  const digits = text(raw).replace(/\D/g, '')
  if (digits.length === 9 && digits.startsWith('9')) return `51${digits}`
  if (digits.length === 11 && digits.startsWith('519')) return digits
  return null
}

/** "150", "150.5", "150,50" -> "150.50". Rejects <= 0, more than two decimals, thousands separators and anything non numeric. */
export function normalizePrice(raw: unknown): string | null {
  const s = typeof raw === 'number' ? String(raw) : text(raw).replace(',', '.')
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(s)
  if (!m) return null
  const whole = m[1].replace(/^0+(?=\d)/, '')
  const fraction = (m[2] ?? '').padEnd(2, '0')
  if (Number(whole) === 0 && Number(fraction) === 0) return null
  return `${whole}.${fraction}`
}

export function validateOrderInput(input: OrderInput): OrderValidation {
  const errors: OrderValidation['errors'] = {}
  const warnings: OrderValidation['warnings'] = {}

  const customer_name = text(input.customer_name)
  if (!customer_name) errors.customer_name = 'required'
  else if (customer_name.length > 150) errors.customer_name = 'too_long'

  const dni = text(input.dni).replace(/\s+/g, '')
  if (dni && !/^\d{8}$/.test(dni)) warnings.dni = 'not_8_digits'

  const phone = normalizePeruPhone(input.phone)
  if (!text(input.phone)) errors.phone = 'required'
  else if (!phone) errors.phone = 'invalid_peru_phone'

  const product = text(input.product)
  if (!product) errors.product = 'required'
  else if (product.length > 500) errors.product = 'too_long'

  const qRaw = typeof input.quantity === 'string' ? input.quantity.trim() : input.quantity
  const quantity = typeof qRaw === 'number' ? qRaw : /^\d{1,5}$/.test(String(qRaw ?? '')) ? Number(qRaw) : NaN
  if (qRaw === undefined || qRaw === '' || qRaw === null) errors.quantity = 'required'
  else if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) errors.quantity = 'invalid_quantity'

  const price = normalizePrice(input.price)
  if (input.price === undefined || input.price === null || text(input.price) === '') errors.price = 'required'
  else if (!price) errors.price = 'invalid_price'

  const order_description = text(input.order_description)
  if (order_description.length > 2000) errors.order_description = 'too_long'

  const agency = text(input.agency) || 'Shalom'
  if (agency.length > 60) errors.agency = 'too_long'

  const destination = text(input.destination)
  if (!destination) errors.destination = 'required'
  else if (destination.length > 120) errors.destination = 'too_long'

  const departmentRaw = text(input.department)
  let department = ''
  if (departmentRaw) {
    const canonical = DEPARTMENT_BY_KEY.get(fold(departmentRaw))
    if (canonical) department = canonical
    else errors.department = 'unknown_department'
  }

  if (Object.keys(errors).length > 0 || !phone || !price) return { ok: false, value: null, errors, warnings }
  return {
    ok: true,
    value: { customer_name, dni, phone, product, quantity, price, order_description, agency, destination, department },
    errors,
    warnings,
  }
}
