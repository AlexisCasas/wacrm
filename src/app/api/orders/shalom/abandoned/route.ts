import { toErrorResponse } from '@/lib/auth/account'
import { authorizeShipments, respondShipment } from '@/lib/orders/shalom/http'
import { listAbandonedOrders } from '@/lib/orders/shalom/service'

// GET /api/orders/shalom/abandoned   the ids of the orders that are CURRENTLY "En abandono" (PR-05B) in the caller's account: the filter of Pedidos
// Confirmados. Read-only, with the caller's own client (RLS) behind the same authorization as the rest of PR-05 (Logística / Supervisor, both flags).
// "En abandono" is a WACRM operational condition, not a Shalom status; nothing here acts on the orders.
export async function GET() {
  try {
    const auth = await authorizeShipments()
    if (!auth.ok) return auth.response
    return respondShipment(await listAbandonedOrders(auth.ctx))
  } catch (error) {
    return toErrorResponse(error)
  }
}
