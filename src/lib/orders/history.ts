import { toTwoDecimals } from './payload'

// Read model of "Pedidos confirmados" (the order history shown in the inbox side panel). Read-only: nothing here changes an order.

/** The ONLY columns the history endpoint selects and returns. No DNI, phone, customer name or error codes. */
export const HISTORY_COLUMNS =
  'id, confirmed_at, product, quantity, price, confirmed_by_name, seller_name, delivery_status, sent_at, acknowledged_at, attempts' as const

export const HISTORY_PAGE_SIZE = 50

export type DeliveryStatus = 'held' | 'pending' | 'sending' | 'sent' | 'acknowledged' | 'failed' | 'dead'

export interface OrderHistoryItem {
  id: string
  confirmed_at: string
  product: string
  quantity: number
  price: number | string
  confirmed_by_name: string
  seller_name: string
  delivery_status: DeliveryStatus
  sent_at: string | null
  acknowledged_at: string | null
  attempts: number
}

export type StatusTone = 'neutral' | 'amber' | 'blue' | 'green' | 'red'

const STATUS: Record<DeliveryStatus, { key: string; tone: StatusTone }> = {
  held: { key: 'statusHeld', tone: 'neutral' },
  pending: { key: 'statusPending', tone: 'amber' },
  sending: { key: 'statusSending', tone: 'amber' },
  sent: { key: 'statusSent', tone: 'blue' },
  acknowledged: { key: 'statusAcknowledged', tone: 'green' },
  failed: { key: 'statusFailed', tone: 'red' },
  dead: { key: 'statusDead', tone: 'red' },
}

/** Unknown values (a future status) read as neutral rather than crashing the panel. */
export function statusInfo(status: string): { key: string; tone: StatusTone } {
  return STATUS[status as DeliveryStatus] ?? { key: 'statusUnknown', tone: 'neutral' }
}

/** Statuses that can still change on their own: only these justify refreshing the panel. `held` never moves by itself. */
export function isInFlight(status: string): boolean {
  return status === 'pending' || status === 'sending' || status === 'sent'
}

/** "31 oct 2026, 22:30" in America/Lima, whatever the browser's time zone is. */
export function formatLimaDateTime(iso: string, locale = 'es'): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'America/Lima',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d)
}

/** "S/ 110.00": the price is the order total, kept with exactly two decimals. */
export function formatPrice(price: number | string): string {
  return `S/ ${toTwoDecimals(price)}`
}
