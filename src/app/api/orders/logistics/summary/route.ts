import { NextResponse } from 'next/server'

import { toErrorResponse } from '@/lib/auth/account'
import { authorize, respond } from '@/lib/orders/logistics/http'
import { getLogisticsSummary, MAX_SUMMARY_IDS } from '@/lib/orders/logistics/panel'

// GET /api/orders/logistics/summary?ids=<uuid>,<uuid>,...   (max 50)   the logistic status + voucher indicator of the orders on screen, for the compact
// indicator of the "Pedidos confirmados" list. A SEPARATE endpoint on purpose: GET /api/orders/confirmed (PR-02) is not touched. Read with the caller's
// own client (RLS); flag OFF / no logistics area -> 403 and the list simply shows no indicator.
export async function GET(request: Request) {
  try {
    const auth = await authorize()
    if (!auth.ok) return auth.response
    const raw = new URL(request.url).searchParams.get('ids') ?? ''
    const ids = raw.split(',').map((x) => x.trim()).filter(Boolean)
    if (ids.length > MAX_SUMMARY_IDS) return NextResponse.json({ error: 'invalid_ids' }, { status: 400 })
    return respond(await getLogisticsSummary(auth.ctx, ids))
  } catch (error) {
    return toErrorResponse(error)
  }
}
