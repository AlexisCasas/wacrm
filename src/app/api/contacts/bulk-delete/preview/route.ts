import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { supabaseAdmin } from '@/lib/contacts/admin-client'

const MAX_PREVIEW = 100
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * POST /api/contacts/bulk-delete/preview  { contact_ids: string[] }
 *
 * READ-ONLY. Tells the person what deleting these contacts would remove (conversations, messages, orders that lose their link,
 * blocked and recently active contacts, BSUID identities) and where the company stands against its deletion limits. Returns counts
 * only — never names or phone numbers. The account comes from the session; one foreign id rejects the request.
 */
export async function POST(request: Request) {
  try {
    const { accountId, role } = await requireRole('agent')
    const body = (await request.json().catch(() => null)) as { contact_ids?: unknown } | null
    const raw = body?.contact_ids
    if (!Array.isArray(raw) || raw.length === 0) {
      return NextResponse.json({ error: 'contact_ids must be a non-empty array' }, { status: 400 })
    }
    if (raw.length > MAX_PREVIEW) {
      return NextResponse.json({ error: `at most ${MAX_PREVIEW} contacts per request`, code: 'BATCH_TOO_LARGE' }, { status: 400 })
    }
    if (!raw.every((id) => typeof id === 'string' && UUID.test(id))) {
      return NextResponse.json({ error: 'contact_ids must be UUIDs' }, { status: 400 })
    }
    const ids = [...new Set((raw as string[]).map((id) => id.toLowerCase()))]

    const { data, error } = await supabaseAdmin().rpc('contact_delete_impact', { p_account_id: accountId, p_contact_ids: ids })
    if (error) {
      if (error.message?.includes('CONTACTS_NOT_IN_ACCOUNT')) {
        return NextResponse.json({ error: 'One or more contacts were not found' }, { status: 404 })
      }
      if (error.message?.includes('BATCH_TOO_LARGE')) {
        return NextResponse.json({ error: `at most ${MAX_PREVIEW} contacts per request`, code: 'BATCH_TOO_LARGE' }, { status: 400 })
      }
      console.error('[contacts] contact_delete_impact failed:', error.message)
      return NextResponse.json({ error: 'Failed to preview the deletion' }, { status: 500 })
    }
    return NextResponse.json({
      ...(data as Record<string, unknown>),
      role,
      can_bulk: hasMinRole(role, 'admin'),
      can_delete_with_orders: hasMinRole(role, 'admin'),
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
