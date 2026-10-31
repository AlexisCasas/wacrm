import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { validateOrderInput } from '@/lib/orders/fields'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// "Confirmar pedido": creates ONE frozen order record and queues it for delivery to InkaClick. The browser generates `request_key` when it opens
// the form, so a double click, a retried request or a reload that re-submits is the same order. Delivery is asynchronous (outbox); this endpoint
// never calls InkaClick, and the response says whether the order was held, queued or already existed, not whether InkaClick has it.
export async function POST(request: Request) {
  try {
    // 'agent' like sending a message: viewers cannot confirm orders.
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`order-confirm:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

    const requestKey = typeof body.request_key === 'string' ? body.request_key.trim() : ''
    if (!requestKey || requestKey.length > 100) return NextResponse.json({ error: 'request_key is required' }, { status: 400 })
    // The seller is a member of the account, identified by user id; it is NOT necessarily the person pressing the button.
    const sellerUserId = typeof body.seller_user_id === 'string' && UUID.test(body.seller_user_id) ? body.seller_user_id : null
    if (!sellerUserId) return NextResponse.json({ error: 'seller_user_id is required' }, { status: 400 })
    const contactId = typeof body.contact_id === 'string' && UUID.test(body.contact_id) ? body.contact_id : null
    const conversationId = typeof body.conversation_id === 'string' && UUID.test(body.conversation_id) ? body.conversation_id : null

    const validation = validateOrderInput(body)
    if (!validation.ok || !validation.value) {
      return NextResponse.json({ error: 'validation_failed', errors: validation.errors, warnings: validation.warnings }, { status: 422 })
    }

    // Snapshot of who confirmed (survives a later profile rename or removal, like the F1 message author).
    const { data: profile } = await supabase.from('profiles').select('full_name').eq('user_id', userId).eq('account_id', accountId).maybeSingle()
    const actorName = (profile?.full_name as string | null)?.trim() || 'Asesor no identificado'

    const admin = supabaseAdmin()
    const { data, error } = await admin.rpc('create_order_confirmation', {
      p_account: accountId,
      p_contact: contactId,
      p_conversation: conversationId,
      p_actor: userId,
      p_actor_name: actorName,
      p_request_key: requestKey,
      p_seller: sellerUserId,
      p_fields: validation.value,
    })
    if (error) {
      // Switched off for this account, or the confirmer lacks the role (also enforced here, in SQL, as a second layer).
      if (error.code === '42501') {
        const off = error.message === 'feature_disabled'
        return NextResponse.json({ error: off ? 'feature_disabled' : 'forbidden' }, { status: 403 })
      }
      // Ownership / seller violations are the caller's mistake (and must not reveal other accounts); everything else is ours.
      const client = /does not belong|not a member/.test(error.message)
      if (!client) console.error('[orders] create failed:', error.code)
      return NextResponse.json({ error: client ? 'invalid_reference' : 'Could not confirm the order' }, { status: client ? 422 : 500 })
    }
    const row = (Array.isArray(data) ? data[0] : data) as { order_id: string; created: boolean } | null
    if (!row) return NextResponse.json({ error: 'Could not confirm the order' }, { status: 500 })

    const { data: order } = await admin.from('order_confirmations').select('delivery_status').eq('id', row.order_id).eq('account_id', accountId).single()
    return NextResponse.json(
      { order_id: row.order_id, created: row.created, delivery_status: order?.delivery_status ?? null, warnings: validation.warnings },
      { status: row.created ? 201 : 200 },
    )
  } catch (error) {
    console.error('[orders] confirm error:', error instanceof Error ? error.name : 'unknown')
    return toErrorResponse(error)
  }
}
