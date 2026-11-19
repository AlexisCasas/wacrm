import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { respondPayment } from '@/lib/orders/payments/http'
import { getConversationFinancials } from '@/lib/orders/payments/service'

// GET /api/orders/payments/conversation?conversation_id=<uuid>   READ-ONLY Total / Pagado / Saldo / Estado of the tracked orders of ONE chat, for the chat panel.
// Open to Comercial (for a chat it can currently work, PR-03 routing), Logistica and Supervisor. Never returns payments, evidence or audit; no write exists here.
// The database decides (order_payments_summary_access: both flags + role + routing); anyone else gets a 404.
export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const conversationId = new URL(request.url).searchParams.get('conversation_id') ?? ''
    const result = await getConversationFinancials(ctx, conversationId)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return respondPayment(result)
  } catch (error) {
    return toErrorResponse(error)
  }
}
