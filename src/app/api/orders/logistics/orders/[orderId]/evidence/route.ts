import { NextResponse } from 'next/server'

import { toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { UPLOAD_RATE_LIMIT } from '@/lib/orders/logistics/constants'
import { selectEvidenceFromChat } from '@/lib/orders/logistics/evidence'
import { authorize, readJsonObject, respond } from '@/lib/orders/logistics/http'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'

// POST /api/orders/logistics/orders/[orderId]/evidence   JSON { message_id, request_key }
// Keeps a PRIVATE snapshot of a media message of the order's own conversation as the packaging evidence of that order. Only while the order is in
// packaging; idempotent on request_key (selecting the same message again changes nothing); a different message supersedes the previous evidence
// (kept as history) unless a template send is open. The account and the actor come from the session; the database re-validates account, order,
// conversation and message. The chat message and its file are never touched.
export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    const auth = await authorize()
    if (!auth.ok) return auth.response
    const limit = checkRateLimit(`logistics-upload:${auth.ctx.userId}`, UPLOAD_RATE_LIMIT)
    if (!limit.success) return rateLimitResponse(limit) as NextResponse
    const body = await readJsonObject(request)
    if (!body) return NextResponse.json({ error: 'invalid_body' }, { status: 400 })

    const { orderId } = await params
    return respond(await selectEvidenceFromChat(auth.ctx, supabaseAdmin(), orderId, { messageId: body.message_id, requestKey: body.request_key }))
  } catch (error) {
    return toErrorResponse(error)
  }
}
