import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/contacts/admin-client'

/**
 * POST /api/contacts/[id]/block — internal WACRM contact block (P0).
 * NOT WhatsApp/Meta's native block — see migration 044.
 *
 * Auth: requireRole('agent'). accountId/userId come from the session;
 * the browser never supplies account_id.
 *
 * Delegates entirely to the `block_contact_internal` SQL function
 * (migration 044) so the contact UPDATE, the audit INSERT, the
 * flow_runs pause, and the automation_pending_executions cancellation
 * all happen in ONE Postgres transaction — a partial failure between
 * them (a crash, a thrown error) rolls back everything, rather than
 * leaving the contact blocked with, say, no audit row or a Flow run
 * still active. Never deletes messages, conversations, flow_runs, or
 * automation_logs.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { accountId, userId } = await requireRole('agent')
    const { id: contactId } = await params

    // NULL = not found in this account; TRUE = already blocked
    // (idempotent no-op); FALSE = the transition was performed.
    // p_account_id/p_user_id come from the session above, never the
    // browser — the function itself also filters every write by
    // account_id regardless.
    const { data, error } = await supabaseAdmin().rpc('block_contact_internal', {
      p_account_id: accountId,
      p_contact_id: contactId,
      p_user_id: userId,
    })
    if (error) {
      console.error('[contacts] block_contact_internal rpc failed:', error.message)
      return NextResponse.json({ error: 'Failed to block contact' }, { status: 500 })
    }
    if (data === null) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    return NextResponse.json({ success: true, blocked: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
