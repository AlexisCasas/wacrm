import { NextResponse } from 'next/server'

import { toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { authorizeShipments, respondShipment } from '@/lib/orders/shalom/http'
import { acknowledgeAlert } from '@/lib/orders/shalom/service'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'

// POST /api/orders/shalom/alerts/[id]/ack   Logística / Supervisor mark the 15-day En destino alert as ATTENDED. This is NOT the notification being read
// (read_at): it is the alert lifecycle (open → acknowledged → resolved). Idempotent and audited. The account and actor come from the session.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authorizeShipments()
    if (!auth.ok) return auth.response
    const limit = checkRateLimit(`shalom-actions:${auth.ctx.userId}`, { limit: 60, windowMs: 60_000 })
    if (!limit.success) return rateLimitResponse(limit) as NextResponse
    const { id } = await params
    return respondShipment(await acknowledgeAlert(auth.ctx, supabaseAdmin(), id))
  } catch (error) {
    return toErrorResponse(error)
  }
}
