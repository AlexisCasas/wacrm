import { NextResponse } from 'next/server'

import { toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { authorize, readJsonObject, respond } from '@/lib/orders/logistics/http'
import { resolveDispatch, sendPackagingTemplate, startPackaging } from '@/lib/orders/logistics/packaging'

// POST /api/orders/logistics/orders/[orderId]/packaging   JSON { action, ... }
//   { action: 'start' }                                       voucher validated -> packing ("Embalaje en proceso"). Idempotent.
//   { action: 'send_template', request_key }                  sends the operational WhatsApp template through the EXISTING infrastructure (same
//                                                             conversation, same persisted messages) with the order's evidence as the header media;
//                                                             ONLY a confirmed send moves the order to ready_for_dispatch ("Listo para despacho").
//                                                             The same request_key is the same operation (double click / retry never sends twice).
//   { action: 'resolve', dispatch_id, resolution }            a person settles an `uncertain` send: 'confirmed_sent' | 'confirmed_not_sent'.
// Account and actor come from the session; the database re-validates flag, area, role, ownership and state.
export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    const auth = await authorize()
    if (!auth.ok) return auth.response
    const body = await readJsonObject(request)
    if (!body) return NextResponse.json({ error: 'invalid_body' }, { status: 400 })

    const { orderId } = await params
    switch (body.action) {
      case 'start':
        return respond(await startPackaging(auth.ctx, supabaseAdmin(), orderId))
      case 'send_template':
        return respond(await sendPackagingTemplate(auth.ctx, supabaseAdmin(), orderId, body.request_key))
      case 'resolve':
        return respond(await resolveDispatch(auth.ctx, supabaseAdmin(), orderId, { dispatchId: body.dispatch_id, resolution: body.resolution }))
      default:
        return NextResponse.json({ error: 'invalid_action' }, { status: 400 })
    }
  } catch (error) {
    return toErrorResponse(error)
  }
}
