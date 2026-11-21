import { NextResponse } from 'next/server'

import { toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { associateDocument } from '@/lib/orders/logistics/bulk'
import { authorize, readJsonObject, respond } from '@/lib/orders/logistics/http'

// POST /api/orders/logistics/documents/[id]/associate   JSON { order_id }   MANUAL association of a bulk voucher by a person (the way out of every
// ambiguous / unmatched case). Allowed while the voucher is still pending review and its order has not started packaging; a voucher uploaded from an
// order screen (direct) can never be moved. The database checks that the order belongs to the caller's account (another account = 404).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authorize()
    if (!auth.ok) return auth.response
    const body = await readJsonObject(request)
    if (!body) return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
    const { id } = await params
    return respond(await associateDocument(auth.ctx, supabaseAdmin(), id, body.order_id))
  } catch (error) {
    return toErrorResponse(error)
  }
}
