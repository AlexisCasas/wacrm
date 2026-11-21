import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { applyInkaclickVoucherEvent, parseVoucherValidatedPayload } from '@/lib/orders/sync/voucher-transport'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EVENT = /^[a-z][a-z0-9_]{0,31}\.[a-z][a-z0-9_]{0,63}$/
const PAYMENT_KEYS = new Set(['total', 'paid', 'balance'])

function authorized(request: Request): boolean {
  const expected = process.env.ORDER_SYNC_TOKEN?.trim()
  if (!expected) return false
  const supplied = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function codeFromError(error: { code?: string } | null | undefined): string {
  if (error?.code === '23505') return 'sync_event_identity_conflict'
  if (error?.code === 'P0002') return 'sync_event_not_found'
  return 'internal_error'
}

export async function POST(request: Request) {
  if (process.env.ORDER_SYNC_ENABLED !== 'true' || !process.env.ORDER_SYNC_TOKEN?.trim()) {
    return NextResponse.json({ code: 'not_configured' }, { status: 503 })
  }
  if (!authorized(request)) return NextResponse.json({ code: 'unauthorized' }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ code: 'invalid_json' }, { status: 400 })
  }

  const originEvent = typeof body.origin_event_id === 'string' ? body.origin_event_id : ''
  const canonicalOrder = typeof body.canonical_order_id === 'string' ? body.canonical_order_id : ''
  const eventType = typeof body.event_type === 'string' ? body.event_type : ''
  const idempotencyKey = typeof body.idempotency_key === 'string' ? body.idempotency_key : ''
  const occurredAt = typeof body.occurred_at === 'string' ? body.occurred_at : ''
  const version = Number(body.event_version)
  const payload = body.payload

  if (
    body.origin_system !== 'inkaclick' ||
    !UUID.test(originEvent) ||
    !UUID.test(canonicalOrder) ||
    !EVENT.test(eventType) ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > 1000 ||
    idempotencyKey.length < 1 ||
    idempotencyKey.length > 160 ||
    !occurredAt ||
    Number.isNaN(Date.parse(occurredAt)) ||
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    return NextResponse.json({ code: 'invalid_event' }, { status: 400 })
  }

  if (request.headers.get('idempotency-key') !== originEvent) {
    return NextResponse.json({ code: 'invalid_idempotency_key' }, { status: 400 })
  }
  if (version !== 1) return NextResponse.json({ code: 'unsupported_event_version' }, { status: 422 })

  let voucherPayload = null
  if (eventType === 'payment.snapshot') {
    const keys = Object.keys(payload as Record<string, unknown>)
    if (keys.some((k) => !PAYMENT_KEYS.has(k))) {
      return NextResponse.json({ code: 'invalid_payment_payload' }, { status: 422 })
    }
  } else if (eventType === 'voucher.validated') {
    voucherPayload = parseVoucherValidatedPayload(payload)
    if (!voucherPayload) return NextResponse.json({ code: 'invalid_voucher_payload' }, { status: 422 })
  } else if (eventType === 'packing.completed') {
    const p = payload as Record<string, unknown>
    if (Object.keys(p).length !== 1 || typeof p.customer_message_sent !== 'boolean') {
      return NextResponse.json({ code: 'invalid_packaging_payload' }, { status: 422 })
    }
  } else if (eventType === 'shipment.snapshot') {
    const p = payload as Record<string, unknown>
    const allowed = new Set(['tracking_number','tracking_code','status'])
    if (
      Object.keys(p).some((k) => !allowed.has(k)) ||
      typeof p.tracking_number !== 'string' ||
      !/^[0-9]{6,12}$/.test(p.tracking_number) ||
      typeof p.tracking_code !== 'string' ||
      !/^[A-Za-z0-9]{3,6}$/.test(p.tracking_code) ||
      (p.status !== null && p.status !== undefined && !['at_origin','in_transit','at_destination','delivered'].includes(String(p.status)))
    ) {
      return NextResponse.json({ code: 'invalid_shipment_payload' }, { status: 422 })
    }
  } else {
    return NextResponse.json({ code: 'unsupported_event_type' }, { status: 422 })
  }

  const admin = supabaseAdmin()
  const { error: recordError } = await admin.rpc('record_order_sync_event', {
    p_canonical_order: canonicalOrder,
    p_origin_system: 'inkaclick',
    p_origin_event: originEvent,
    p_event_type: eventType,
    p_event_version: version,
    p_idempotency_key: idempotencyKey,
    p_occurred_at: occurredAt,
    p_payload: payload,
  })
  if (recordError) {
    const code = codeFromError(recordError)
    return NextResponse.json({ code }, { status: code === 'sync_event_identity_conflict' ? 409 : 500 })
  }

  if (eventType === 'payment.snapshot') {
    const { data, error } = await admin.rpc('apply_inkaclick_payment_snapshot', { p_origin_event: originEvent })
    if (error) return NextResponse.json({ code: codeFromError(error) }, { status: 500 })
    const result = data as { status?: string; reason?: string; changed?: boolean } | null
    if (result?.status === 'conflict') {
      const code = typeof result.reason === 'string' && /^[a-z0-9_]{1,64}$/.test(result.reason) ? result.reason : 'sync_conflict'
      return NextResponse.json({ code }, { status: 409 })
    }
    return NextResponse.json({ status: 'applied', changed: result?.changed === true })
  }

  if (eventType === 'voucher.validated') {
    const voucher = await applyInkaclickVoucherEvent(admin, {
      origin_event_id: originEvent,
      canonical_order_id: canonicalOrder,
      occurred_at: occurredAt,
      payload: voucherPayload!,
    })
    if (!voucher.ok) return NextResponse.json({ code: voucher.code }, { status: voucher.status })
    return NextResponse.json({ status: 'applied', changed: voucher.changed })
  }

  if (eventType === 'packing.completed') {
    const { data, error } = await admin.rpc('apply_inkaclick_packaging_completed', { p_origin_event: originEvent })
    if (error) return NextResponse.json({ code: codeFromError(error) }, { status: 500 })
    const result = data as { ok?: boolean; status?: string; reason?: string; changed?: boolean } | null
    if (result?.ok !== true) {
      const code = typeof result?.reason === 'string' && /^[a-z0-9_]{1,64}$/.test(result.reason) ? result.reason : 'sync_conflict'
      return NextResponse.json({ code }, { status: 409 })
    }
    return NextResponse.json({ status: 'applied', changed: result.changed === true })
  }

  const { data, error } = await admin.rpc('apply_inkaclick_shipment_snapshot', { p_origin_event: originEvent })
  if (error) return NextResponse.json({ code: codeFromError(error) }, { status: 500 })
  const result = data as { ok?: boolean; status?: string; reason?: string; changed?: boolean } | null
  if (result?.ok !== true) {
    const code = typeof result?.reason === 'string' && /^[a-z0-9_]{1,64}$/.test(result.reason) ? result.reason : 'sync_conflict'
    return NextResponse.json({ code }, { status: 409 })
  }
  return NextResponse.json({ status: 'applied', changed: result.changed === true })
}
