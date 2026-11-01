import React from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'
import { ConfirmOrderButton } from '@/components/orders/confirm-order-button'
import { OrderHistory } from '@/components/orders/order-history'

const params = new URLSearchParams(location.search)
const scenario = params.get('s') ?? 'six'
// The app has ONE (dark) palette plus accent themes (data-theme on <html>); the harness exercises two of them.
const theme = params.get('theme') ?? 'violet'
document.documentElement.dataset.theme = theme

const CONV = '33333333-3333-4333-8333-333333333333'
const base = { quantity: 1, price: 110, confirmed_by_name: 'Keyler Ortega', seller_name: 'David Riveros', sent_at: null, acknowledged_at: null, attempts: 0 }
const o = (i: number, over: Record<string, unknown> = {}) => ({ id: `0000000${i}-5719-4ace-8adb-7e317141947c`, confirmed_at: `2026-10-31T${String(10 + i).padStart(2, '0')}:24:05Z`, product: `Producto sintético ${i}`, delivery_status: 'held', ...base, ...over })
const STATES = ['held', 'pending', 'sending', 'sent', 'acknowledged', 'failed', 'dead']
const data: Record<string, unknown> = {
  empty: { enabled: true, orders: [], has_more: false },
  one: { enabled: true, orders: [o(1, { delivery_status: 'acknowledged', sent_at: '2026-11-01T00:57:47Z', acknowledged_at: '2026-11-01T01:01:49Z', attempts: 1 })], has_more: false },
  six: { enabled: true, orders: [1, 2, 3, 4, 5, 6].map((i) => o(i, { delivery_status: STATES[i % 7] })), has_more: false },
  states: { enabled: true, orders: STATES.map((s, i) => o(i + 1, { delivery_status: s, product: i === 0 ? 'Adaptador para Sierra para taladro de banco con extensión larga y accesorios de repuesto incluidos' : `Producto ${s}` })), has_more: false },
  many: { enabled: true, orders: Array.from({ length: 50 }, (_, i) => o(i + 1)), has_more: true },
  off: { enabled: false, orders: [], has_more: false },
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
window.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input)
  if (url.includes('/api/orders/sellers')) return json({ enabled: true, sellers: [{ id: 'u1', name: 'Titular' }] })
  if (url.includes('/api/orders/history')) return scenario === 'error' ? json({ error: 'x' }, 500) : json(data[scenario] ?? data.six)
  return json({}, 404)
}) as typeof fetch

// Same column the contact sidebar uses (w-70 = 280px).
createRoot(document.getElementById('root')!).render(
  <div className="min-h-screen bg-background text-foreground">
    <div className="flex h-screen w-70 flex-col overflow-y-auto border-l border-border bg-card" id="col">
      <div className="p-4">
        <div className="mt-3 w-full">
          <ConfirmOrderButton contact={{ id: '22222222-2222-4222-8222-222222222222', name: 'Cliente Sintético', phone: '900000001' }} conversationId={CONV} />
          <OrderHistory key={CONV} conversationId={CONV} />
        </div>
      </div>
    </div>
  </div>,
)
