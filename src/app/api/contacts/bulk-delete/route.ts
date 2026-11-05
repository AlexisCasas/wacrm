import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/contacts/admin-client'

export const MAX_BULK_DELETE = 100
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * POST /api/contacts/bulk-delete  { contact_ids: string[] }
 *
 * Permanently deletes EXACTLY the given contacts together with their chats and messages (database cascades), in one transaction:
 * all of them or none. The account comes from the session (never the body); a single id that is not in that account rejects the
 * whole batch with nothing deleted. Deals, broadcast recipients and Flow run history survive (contact_id SET NULL).
 * Auth: requireRole('agent') — same as the contacts DELETE policy.
 */
export async function POST(request: Request) {
  try {
    const { accountId } = await requireRole('agent')

    const body = (await request.json().catch(() => null)) as { contact_ids?: unknown } | null
    const raw = body?.contact_ids
    if (!Array.isArray(raw) || raw.length === 0) {
      return NextResponse.json({ error: 'contact_ids must be a non-empty array' }, { status: 400 })
    }
    if (raw.length > MAX_BULK_DELETE) {
      return NextResponse.json({ error: `at most ${MAX_BULK_DELETE} contacts per request` }, { status: 400 })
    }
    if (!raw.every((id) => typeof id === 'string' && UUID.test(id))) {
      return NextResponse.json({ error: 'contact_ids must be UUIDs' }, { status: 400 })
    }
    const ids = [...new Set((raw as string[]).map((id) => id.toLowerCase()))]

    const { data, error } = await supabaseAdmin().rpc('bulk_delete_contacts_internal', { p_account_id: accountId, p_contact_ids: ids })
    if (error) {
      if (error.message?.includes('CONTACTS_NOT_IN_ACCOUNT')) {
        return NextResponse.json({ error: 'One or more contacts were not found', deleted: 0 }, { status: 404 })
      }
      console.error('[contacts] bulk_delete_contacts_internal failed:', error.message)
      return NextResponse.json({ error: 'Failed to delete contacts', deleted: 0 }, { status: 500 })
    }
    const result = (data ?? {}) as { deleted?: number; conversations_deleted?: number; messages_deleted?: number }
    return NextResponse.json({
      success: true,
      deleted: result.deleted ?? 0,
      conversations_deleted: result.conversations_deleted ?? 0,
      messages_deleted: result.messages_deleted ?? 0,
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
