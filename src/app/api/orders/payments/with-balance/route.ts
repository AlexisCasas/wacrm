import { toErrorResponse } from '@/lib/auth/account'
import { authorizePayments, respondPayment } from '@/lib/orders/payments/http'
import { listOrdersWithBalance } from '@/lib/orders/payments/service'

// GET /api/orders/payments/with-balance   the ids of the TRACKED orders that still have a balance (the "Con saldo" filter of Pedidos Confirmados). Read-only.
export async function GET() {
  try {
    const auth = await authorizePayments()
    if (!auth.ok) return auth.response
    return respondPayment(await listOrdersWithBalance(auth.ctx))
  } catch (error) {
    return toErrorResponse(error)
  }
}
