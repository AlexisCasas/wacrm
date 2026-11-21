import { NextResponse } from 'next/server'

import { toErrorResponse } from '@/lib/auth/account'
import { authorizeShipments, respondShipment } from '@/lib/orders/shalom/http'
import { getShipmentSummary, MAX_SUMMARY_IDS } from '@/lib/orders/shalom/service'

// GET /api/orders/shalom/summary?ids=<uuid>,<uuid>…   the derived tracking status of the orders on screen (only shipments that exist are returned). Read
// with the caller's own client (RLS). The list asks lazily for the rows that become visible, exactly like the PR-04 indicator.
export async function GET(request: Request) {
  try {
    const auth = await authorizeShipments()
    if (!auth.ok) return auth.response
    const raw = new URL(request.url).searchParams.get('ids') ?? ''
    const ids = raw.split(',').map((s) => s.trim()).filter(Boolean)
    if (ids.length === 0 || ids.length > MAX_SUMMARY_IDS) return NextResponse.json({ error: 'invalid_ids' }, { status: 400 })
    return respondShipment(await getShipmentSummary(auth.ctx, ids))
  } catch (error) {
    return toErrorResponse(error)
  }
}
