import { NextResponse } from 'next/server'

import { toErrorResponse } from '@/lib/auth/account'
import { authorizePayments, respondPayment } from '@/lib/orders/payments/http'
import { getPaymentsSummary, MAX_SUMMARY_IDS } from '@/lib/orders/payments/service'

// GET /api/orders/payments/summary?ids=<uuid>,<uuid>…   the financial status of the TRACKED orders on screen (the list chip). Read with the caller's own client (RLS).
export async function GET(request: Request) {
  try {
    const auth = await authorizePayments()
    if (!auth.ok) return auth.response
    const ids = (new URL(request.url).searchParams.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    if (ids.length === 0 || ids.length > MAX_SUMMARY_IDS) return NextResponse.json({ error: 'invalid_ids' }, { status: 400 })
    return respondPayment(await getPaymentsSummary(auth.ctx, ids))
  } catch (error) {
    return toErrorResponse(error)
  }
}
