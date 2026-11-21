import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { resolveConfirmedOrdersAccess } from '@/lib/orders/confirmed-orders'

// GET /api/orders/confirmed/access   Tells the UI whether to show the "Pedidos confirmados" entry. Hiding the menu is a convenience: the list
// endpoint enforces the same rules again. Fail-closed (anything other than a clear yes means `allowed: false`); 401 without a session.
export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const access = await resolveConfirmedOrdersAccess(ctx)
    return NextResponse.json({
      enabled: access.kind !== 'disabled',
      allowed: access.kind === 'ok',
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
