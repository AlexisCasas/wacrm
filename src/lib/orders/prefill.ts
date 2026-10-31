// Pre-fills the "Confirmar pedido" form from what WACRM already knows about the contact: its native name and phone, and the custom fields a Flow
// or an agent already filled in (Producto, Precio, Destino, ...). Matching is by name, ignoring case and accents, so "Descripción de pedido" and
// "descripcion de pedido" are the same field. Nothing is sent from here: the agent reviews and corrects every value before confirming.

export interface PrefillContact {
  name?: string | null
  phone?: string | null
}
export interface PrefillValue {
  field_name: string
  value: string | null
}

export interface OrderFormValues {
  customer_name: string
  dni: string
  phone: string
  product: string
  quantity: string
  price: string
  order_description: string
  agency: string
  destination: string
  department: string
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()

const ALIASES: Record<Exclude<keyof OrderFormValues, 'customer_name' | 'phone'>, string[]> = {
  dni: ['dni'],
  product: ['producto'],
  quantity: ['cantidad'],
  price: ['precio'],
  order_description: ['descripcion de pedido', 'descripcion del pedido', 'descripcion'],
  agency: ['agencia'],
  destination: ['destino'],
  department: ['departamento'],
}

export function buildPrefill(contact: PrefillContact, values: PrefillValue[]): OrderFormValues {
  const byName = new Map<string, string>()
  for (const v of values) if (v.value && v.value.trim()) byName.set(fold(v.field_name), v.value.trim())
  const pick = (key: keyof typeof ALIASES) => {
    for (const alias of ALIASES[key]) {
      const hit = byName.get(alias)
      if (hit) return hit
    }
    return ''
  }
  return {
    customer_name: contact.name?.trim() ?? '',
    // Kept as text: never coerced to a number.
    phone: contact.phone?.trim() ?? '',
    dni: pick('dni'),
    product: pick('product'),
    quantity: pick('quantity') || '1',
    price: pick('price'),
    order_description: pick('order_description'),
    agency: pick('agency') || 'Shalom',
    destination: pick('destination'),
    department: pick('department'),
  }
}
