// The JSON WACRM sends to InkaClick. Typed (quantity is a number, price a two-decimal string), `source` is always `wacrm`, and the stable
// per-order identifier is `external_order_id` (the WACRM order id). Nothing here derives from ManyChat ids.

export interface OrderRow {
  id: string
  confirmed_at: string
  customer_name: string
  dni: string | null
  phone: string
  product: string
  quantity: number
  price: string | number
  order_description: string | null
  agency: string
  destination: string
  seller_name: string
  order_status: string
  department: string | null
}

export interface InkaclickOrderPayload {
  source: 'wacrm'
  external_order_id: string
  fecha_hora: string
  nombre_completo: string
  dni: string | null
  telefono: string
  producto: string
  cantidad_productos: number
  precio: string
  descripcion_pedido: string | null
  agencia: string
  destino: string
  vendedor: string
  estado_pedido: string
  departamento: string | null
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** ISO-8601 in America/Lima. Peru has no daylight saving time, so the offset is a constant -05:00 (the same shape ManyChat's `fecha_hora` uses). */
export function toLimaIso(iso: string): string {
  const d = new Date(new Date(iso).getTime() - 5 * 3600 * 1000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}-05:00`
}

export function toTwoDecimals(value: string | number): string {
  const [i, f = ''] = String(value).split('.')
  return `${i}.${f.padEnd(2, '0').slice(0, 2)}`
}

export function buildInkaclickPayload(o: OrderRow): InkaclickOrderPayload {
  return {
    source: 'wacrm',
    external_order_id: o.id,
    fecha_hora: toLimaIso(o.confirmed_at),
    nombre_completo: o.customer_name,
    dni: o.dni || null,
    telefono: o.phone,
    producto: o.product,
    cantidad_productos: o.quantity,
    precio: toTwoDecimals(o.price),
    descripcion_pedido: o.order_description || null,
    agencia: o.agency,
    destino: o.destination,
    vendedor: o.seller_name,
    estado_pedido: o.order_status,
    departamento: o.department || null,
  }
}
