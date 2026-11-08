import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEADERS = { 'Cache-Control': 'private, no-store' } as const

// Only a real account admin may classify a pre-existing tag as a sales product.
// It never creates new tags and can never change another account's labels.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId } = await requireRole('admin')
    const { id } = await params
    if (!UUID.test(id)) return NextResponse.json({ error: 'invalid_tag' }, { status: 400, headers: HEADERS })
    const body = await request.json().catch(() => null)
    if (!body || typeof body.is_order_product !== 'boolean') {
      return NextResponse.json({ error: 'invalid_boolean' }, { status: 400, headers: HEADERS })
    }
    const { data, error } = await supabaseAdmin()
      .from('tags')
      .update({ is_order_product: body.is_order_product })
      .eq('id', id)
      .eq('account_id', accountId)
      .select('id, name, is_order_product')
      .maybeSingle()
    if (error) return NextResponse.json({ error: 'catalog_unavailable' }, { status: 500, headers: HEADERS })
    if (!data) return NextResponse.json({ error: 'tag_not_found' }, { status: 404, headers: HEADERS })
    return NextResponse.json({ tag: data }, { headers: HEADERS })
  } catch (error) {
    return toErrorResponse(error)
  }
}
