import { createHash } from 'node:crypto'

import type { ShipmentStatus } from '@/lib/orders/shalom/types'

// RAW SHALOM → NORMALIZED. The initial mapping is taken from the evidence of the InkaClick poller (a proven mapping over thousands of real answers) and is
// NOT a Shalom contract: unknown shapes never advance an order (they become a technical exception). Priority, highest first:
//   entregado  >  destino with a date or completo  >  transito.completo  >  origen  >  registrado  >  (nothing recognizable = unknown)
// `reparto` and `demora` are stored raw and NOT interpreted yet.

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isTrue = (v: unknown): boolean => v === true || v === 'true'
const nonEmpty = (v: unknown): boolean => (v === null || v === undefined ? false : typeof v === 'string' ? v.trim() !== '' : true)

/** The answer's useful part: InkaClick tolerates both `{status,order}` and `{data:{status,order}}`. */
function unwrap(raw: unknown): { status: Obj; order: Obj } | null {
  if (!isObj(raw)) return null
  const data = isObj(raw.data) ? raw.data : raw
  return { status: isObj(data.status) ? data.status : {}, order: isObj(data.order) ? data.order : {} }
}

export function mapShalomStatus(raw: unknown): ShipmentStatus | null {
  const parts = unwrap(raw)
  if (!parts) return null
  const { status, order } = parts
  if (isTrue(order.entregado) || isTrue(status.entregado)) return 'delivered'
  if (isObj(status.destino) && (isTrue(status.destino.completo) || nonEmpty(status.destino.fecha))) return 'at_destination'
  if (isObj(status.transito) && isTrue(status.transito.completo)) return 'in_transit'
  if (status.origen) return 'at_origin'
  if (status.registrado) return 'at_origin'
  return null
}

/** The date Shalom reports for the arrival at destination (status.destino.fecha), as an ISO string, or null when absent / unparseable. */
export function extractDestinationDate(raw: unknown): string | null {
  const parts = unwrap(raw)
  if (!parts || !isObj(parts.status.destino)) return null
  const fecha = parts.status.destino.fecha
  if (typeof fecha !== 'string' || fecha.trim() === '') return null
  const t = Date.parse(fecha.trim())
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

const short = (v: unknown): unknown => (typeof v === 'string' ? v.slice(0, 40) : typeof v === 'number' || typeof v === 'boolean' || v === null ? v : v === undefined ? null : '[obj]')

/**
 * A SMALL, bounded summary of the raw answer for audit / debug (never the UI status): the flags that drive the mapping plus reparto / demora raw. No
 * customer data (order.remitente / destinatario / monto … are deliberately NOT kept) and no credentials.
 */
export function summarizeRaw(raw: unknown): Record<string, unknown> {
  const parts = unwrap(raw)
  if (!parts) return { shape: 'unrecognized' }
  const { status, order } = parts
  const destino = isObj(status.destino) ? status.destino : null
  const transito = isObj(status.transito) ? status.transito : null
  return {
    registrado: Boolean(status.registrado),
    origen: Boolean(status.origen),
    transito_completo: transito ? short(transito.completo) : null,
    destino_completo: destino ? short(destino.completo) : null,
    destino_fecha: destino ? short(destino.fecha) : null,
    entregado: short(status.entregado),
    order_entregado: short(order.entregado),
    reparto: short(status.reparto),
    demora: short(status.demora),
  }
}

/** Stable short hash of the summary: the same technical state always hashes the same (used to deduplicate exceptions / audit). */
export function hashRaw(raw: unknown): string {
  const summary = summarizeRaw(raw)
  const stable = JSON.stringify(Object.keys(summary).sort().map((k) => [k, summary[k]]))
  return createHash('sha256').update(stable).digest('hex').slice(0, 16)
}
