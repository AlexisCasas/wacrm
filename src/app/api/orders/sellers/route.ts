import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'

// Who can be the commercial seller of an order, for the "Vendedor" selector: every CURRENT member of the caller's account, resolved from the real
// profiles by `order_seller_candidates` (pending invitations are not members; removed members are gone; a rename shows up at once). The answer also
// tells the UI whether "Confirmar pedido" is switched on for this account (`confirm_enabled`, OFF by default and independent of the InkaClick
// delivery switch). When it is off nothing about the roster is returned. The account always comes from the session.
export async function GET() {
  try {
    const { accountId } = await requireRole('agent')
    const admin = supabaseAdmin()

    const { data: settings, error: settingsError } = await admin
      .from('order_integration_settings')
      .select('confirm_enabled')
      .eq('account_id', accountId)
      .maybeSingle()
    if (settingsError) return NextResponse.json({ error: 'Could not load the order settings' }, { status: 500 })
    if (!settings?.confirm_enabled) return NextResponse.json({ enabled: false, sellers: [] })

    const { data, error } = await admin.rpc('order_seller_candidates', { p_account: accountId })
    if (error) return NextResponse.json({ error: 'Could not load sellers' }, { status: 500 })
    const sellers = ((data ?? []) as { user_id: string; name: string }[]).map((m) => ({ id: m.user_id, name: m.name }))
    return NextResponse.json({ enabled: true, sellers })
  } catch (error) {
    return toErrorResponse(error)
  }
}
