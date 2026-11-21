import { toErrorResponse } from '@/lib/auth/account'
import { searchPendingOrders } from '@/lib/orders/logistics/bulk'
import { authorize, respond } from '@/lib/orders/logistics/http'

// GET /api/orders/logistics/orders/pending?q=   orders of the caller's account still waiting for a voucher (most recent first, max 20), optionally
// filtered by customer / product. It feeds the manual choice of a bulk voucher. Read with the caller's own client; no DNI / phone is selected.
export async function GET(request: Request) {
  try {
    const auth = await authorize()
    if (!auth.ok) return auth.response
    return respond(await searchPendingOrders(auth.ctx, new URL(request.url).searchParams.get('q')))
  } catch (error) {
    return toErrorResponse(error)
  }
}
