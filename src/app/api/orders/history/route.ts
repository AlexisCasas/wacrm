import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { HISTORY_COLUMNS, HISTORY_PAGE_SIZE } from '@/lib/orders/history'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Read-only history of the confirmed orders of ONE conversation, for the "Pedidos confirmados" panel. It never writes, never calls InkaClick or
// WhatsApp and never changes a delivery status. The account always comes from the session; the orders are read with the CALLER's client, so
// the row-level policy (members with the agent role, own account only) applies on top of the explicit account filter. A conversation that is
// not in the caller's account simply has no orders. Only the columns in HISTORY_COLUMNS leave the server (no DNI, phone or error codes).
// Orders whose conversation was deleted keep their contact, so they are found through the conversation's contact as well.
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('agent')

    const url = new URL(request.url)
    const conversationId = url.searchParams.get('conversation_id') ?? ''
    if (!UUID.test(conversationId)) return NextResponse.json({ error: 'conversation_id is required' }, { status: 400 })
    const before = url.searchParams.get('before')
    if (before !== null && Number.isNaN(Date.parse(before))) return NextResponse.json({ error: 'invalid before' }, { status: 400 })

    // The "Confirmar pedido" switch also gates the history (an account without the feature sees nothing). The settings table is admin-only
    // for readers, so, like /api/orders/sellers, this one lookup is done with the service role, scoped to the session's account.
    const { data: settings, error: settingsError } = await supabaseAdmin()
      .from('order_integration_settings')
      .select('confirm_enabled')
      .eq('account_id', accountId)
      .maybeSingle()
    if (settingsError) return NextResponse.json({ error: 'Could not load the order settings' }, { status: 500 })
    if (!settings?.confirm_enabled) return NextResponse.json({ enabled: false, orders: [], has_more: false })

    const { data: conversation } = await supabase
      .from('conversations')
      .select('contact_id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!conversation) return NextResponse.json({ enabled: true, orders: [], has_more: false })
    const contactId = typeof conversation.contact_id === 'string' && UUID.test(conversation.contact_id) ? conversation.contact_id : null

    let query = supabase.from('order_confirmations').select(HISTORY_COLUMNS).eq('account_id', accountId)
    query = contactId ? query.or(`conversation_id.eq.${conversationId},contact_id.eq.${contactId}`) : query.eq('conversation_id', conversationId)
    if (before !== null) query = query.lt('confirmed_at', before)
    const { data, error } = await query.order('confirmed_at', { ascending: false }).limit(HISTORY_PAGE_SIZE + 1)
    if (error) {
      console.error('[orders] history failed:', error.code)
      return NextResponse.json({ error: 'Could not load the orders' }, { status: 500 })
    }

    const rows = data ?? []
    return NextResponse.json({ enabled: true, orders: rows.slice(0, HISTORY_PAGE_SIZE), has_more: rows.length > HISTORY_PAGE_SIZE })
  } catch (error) {
    return toErrorResponse(error)
  }
}
