import { NextResponse } from 'next/server'

import { toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { authorizePayments, readJsonObject, respondPayment } from '@/lib/orders/payments/http'
import { cancelOrder, confirmPayment, correctOrderTotal, editOrder, correctPayment, getPaymentsPanel, markDeliveredManual, registerPayment, rejectPayment, voidPayment } from '@/lib/orders/payments/service'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'

// PR-06 · the PAYMENTS of ONE order (the same order_id as Pedidos Confirmados / PR-04 / PR-05).
//
// GET  /api/orders/payments/orders/[orderId]   Total / Pagado / Saldo / Estado, the payments, the audit, the delivery state, the finalization and a voucher candidate.
// POST /api/orders/payments/orders/[orderId]   JSON { action, ... }
//        register       { request_key, amount, kind, method?, operation_number?, paid_at, evidence_document_id?, notes? }   Logistica / Supervisor.
//        confirm        { payment_id, expected_version?, overpayment_reason? }       Logistica / Supervisor. An excess over the balance: Supervisor + reason only.
//        reject         { payment_id, expected_version?, reason }                    Logistica / Supervisor.
//        void           { payment_id, expected_version?, reason }                    SUPERVISOR only.
//        correct        { payment_id, expected_version?, reason, request_key, ...payment }   SUPERVISOR only (void + a new confirmed payment, one transaction).
//        edit_order     { fields: {customer_name?, dni?, phone?, order_description?, agency?, destination?, department?, seller_user_id?, product?, quantity?, items?[]}, reason }   Logistica / Supervisor.
//        cancel_order   { reason, acknowledge_paid? }   Logistica / Supervisor; with confirmed payments: Supervisor + acknowledge_paid (flags a refund, deletes nothing).
//        mark_delivered { note? }                                                    Logistica / Supervisor. For orders WITHOUT an active Shalom shipment (e.g. Olva).
// The total is order_confirmations.price and the balance is computed by the database: nothing about money is taken from the browser except the amount of a NEW payment.
// The account and the actor come from the session; the database re-validates both flags, area, role and ownership. Commercial / viewers / no area: 403.
export async function GET(_request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    const auth = await authorizePayments()
    if (!auth.ok) return auth.response
    const { orderId } = await params
    return respondPayment(await getPaymentsPanel(auth.ctx, supabaseAdmin(), orderId, auth.isSupervisor))
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    const auth = await authorizePayments()
    if (!auth.ok) return auth.response
    const limit = checkRateLimit(`payments-actions:${auth.ctx.userId}`, { limit: 60, windowMs: 60_000 })
    if (!limit.success) return rateLimitResponse(limit) as NextResponse
    const body = await readJsonObject(request)
    if (!body) return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
    const { orderId } = await params
    const admin = supabaseAdmin()
    const who = { userId: auth.ctx.userId, accountId: auth.ctx.accountId }
    const payment = { requestKey: body.request_key, amount: body.amount, kind: body.kind, method: body.method, operationNumber: body.operation_number, paidAt: body.paid_at, evidenceDocumentId: body.evidence_document_id, notes: body.notes }

    switch (body.action) {
      case 'register':
        return respondPayment(await registerPayment(who, admin, orderId, payment))
      case 'confirm':
        return respondPayment(await confirmPayment(who, admin, body.payment_id, { expectedVersion: body.expected_version, overpaymentReason: body.overpayment_reason }))
      case 'reject':
        return respondPayment(await rejectPayment(who, admin, body.payment_id, { expectedVersion: body.expected_version, reason: body.reason }))
      case 'void':
        if (!auth.isSupervisor) return NextResponse.json({ error: 'supervisor_required' }, { status: 403 })
        return respondPayment(await voidPayment(who, admin, body.payment_id, { expectedVersion: body.expected_version, reason: body.reason }))
      case 'correct':
        if (!auth.isSupervisor) return NextResponse.json({ error: 'supervisor_required' }, { status: 403 })
        return respondPayment(await correctPayment(who, admin, body.payment_id, { ...payment, expectedVersion: body.expected_version, reason: body.reason, overpaymentReason: body.overpayment_reason }))
      case 'correct_total':
        if (!auth.isSupervisor) return NextResponse.json({ error: 'supervisor_required' }, { status: 403 })
        return respondPayment(await correctOrderTotal(who, admin, orderId, { newTotal: body.new_total, reason: body.reason }))
      case 'edit_order':
        return respondPayment(await editOrder(who, admin, orderId, { fields: body.fields, reason: body.reason }))
      case 'cancel_order':
        return respondPayment(await cancelOrder(who, admin, orderId, { reason: body.reason, acknowledgePaid: body.acknowledge_paid }))
      case 'mark_delivered':
        return respondPayment(await markDeliveredManual(who, admin, orderId, body.note))
      default:
        return NextResponse.json({ error: 'invalid_action' }, { status: 400 })
    }
  } catch (error) {
    return toErrorResponse(error)
  }
}
