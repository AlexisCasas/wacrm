import { NextResponse } from 'next/server'

import { toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { fail } from '@/lib/orders/logistics/documents'
import { retryCustomerMessage, resolveCustomerMessage } from '@/lib/orders/shalom/customer-message'
import { isShalomGloballyEnabled, readShalomConfig } from '@/lib/orders/shalom/config'
import { authorizeShipments, readJsonObject, respondShipment } from '@/lib/orders/shalom/http'
import { resolveShalomProvider } from '@/lib/orders/shalom/providers'
import { correctShipment, getShipmentPanel, refreshShipment, registerShipment, stopShipment } from '@/lib/orders/shalom/service'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'

// PR-05 · Tracking Shalom of ONE order (the same order_id as Pedidos Confirmados / PR-04).
//
// GET  /api/orders/shalom/orders/[orderId]   the tracking panel (guide, status, last / next query, error, alert, history).
// POST /api/orders/shalom/orders/[orderId]   JSON { action, ... }
//        register  { numero_orden, codigo }                     Logística / Supervisor. Only for an order PR-04 left ready_for_dispatch.
//        correct   { numero_orden, codigo, expected_version? }  Logística / Supervisor. identifier_version + 1, tracking restarts, history kept.
//        refresh   {}                                           Logística / Supervisor. Rate limited per order; ONE query now.
//        retry_message   { message_id }                          Logística / Supervisor. PR-05A: re-queues a FAILED day-15 customer message (the sender tick sends it; never a duplicate).
//        resolve_message { message_id, resolution }              Logística / Supervisor. PR-05A: closes an UNCERTAIN message as confirmed_sent / confirmed_not_sent (never re-sent automatically).
//        stop      { reason? }                                  SUPERVISOR only. Keeps the history; the late-cancellation FLOW is not built here.
// Needs logistics_mvp_enabled AND shalom_tracking_enabled. The account and the actor come from the session. Commercial / viewers / no area: 403.
// The forced refresh is the only call that reaches the provider, and it honours the global server-side kill switch.

export async function GET(_request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    const auth = await authorizeShipments()
    if (!auth.ok) return auth.response
    const { orderId } = await params
    return respondShipment(await getShipmentPanel(auth.ctx, orderId, auth.isSupervisor))
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    const auth = await authorizeShipments()
    if (!auth.ok) return auth.response
    const limit = checkRateLimit(`shalom-actions:${auth.ctx.userId}`, { limit: 60, windowMs: 60_000 })
    if (!limit.success) return rateLimitResponse(limit) as NextResponse
    const body = await readJsonObject(request)
    if (!body) return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
    const { orderId } = await params
    const admin = supabaseAdmin()

    switch (body.action) {
      case 'register':
        return respondShipment(await registerShipment(auth.ctx, admin, orderId, { numero: body.numero_orden, codigo: body.codigo }))
      case 'correct':
        return respondShipment(await correctShipment(auth.ctx, admin, orderId, { numero: body.numero_orden, codigo: body.codigo, expectedVersion: body.expected_version }))
      case 'stop':
        if (!auth.isSupervisor) return NextResponse.json({ error: 'supervisor_required' }, { status: 403 })
        return respondShipment(await stopShipment(auth.ctx, admin, orderId, body.reason))
      case 'retry_message':
        return respondShipment(await retryCustomerMessage(auth.ctx, admin, body.message_id))
      case 'resolve_message':
        return respondShipment(await resolveCustomerMessage(auth.ctx, admin, body.message_id, body.resolution))
      case 'refresh': {
        if (!isShalomGloballyEnabled()) return respondShipment(fail(409, 'tracking_disabled'))
        return respondShipment(await refreshShipment(auth.ctx, admin, orderId, { provider: resolveShalomProvider(), cfg: readShalomConfig() }))
      }
      default:
        return NextResponse.json({ error: 'invalid_action' }, { status: 400 })
    }
  } catch (error) {
    return toErrorResponse(error)
  }
}
