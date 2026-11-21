import { toErrorResponse } from '@/lib/auth/account'
import { authorize, respond } from '@/lib/orders/logistics/http'
import { getOrderPanel } from '@/lib/orders/logistics/panel'

// GET /api/orders/logistics/orders/[orderId]   everything the logistics panel of ONE confirmed order shows: the order (PR-02 read model, no DNI / phone),
// its logistic status (no row = pending_voucher), its vouchers and its audit trail. Read with the caller's own client (RLS); another account's order
// is a plain 404.
export async function GET(_request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    const auth = await authorize()
    if (!auth.ok) return auth.response
    const { orderId } = await params
    return respond(await getOrderPanel(auth.ctx, orderId))
  } catch (error) {
    return toErrorResponse(error)
  }
}
