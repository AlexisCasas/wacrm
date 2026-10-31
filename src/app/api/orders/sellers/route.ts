import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

// Active sellers of the caller's account, for the "Vendedor" selector. RLS already scopes the read to the account.
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { data, error } = await supabase
      .from('order_sellers')
      .select('id, name')
      .eq('account_id', accountId)
      .eq('active', true)
      .order('name')
    if (error) return NextResponse.json({ error: 'Could not load sellers' }, { status: 500 })
    return NextResponse.json({ sellers: data ?? [] })
  } catch (error) {
    return toErrorResponse(error)
  }
}
