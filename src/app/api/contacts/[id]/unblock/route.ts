import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/contacts/admin-client'

/**
 * POST /api/contacts/[id]/unblock — reverses an internal WACRM block
 * (P0, migration 044). Auth: requireRole('agent'), account-scoped.
 *
 * Delegates to the `unblock_contact_internal` SQL function so the
 * contact UPDATE and the audit INSERT happen in one transaction, same
 * rationale as the block route.
 *
 * Unblocking enables FUTURE activity only:
 *   - `blocked_inbound_count` / `last_blocked_inbound_at` are historical
 *     operational counters and are deliberately NOT reset.
 *   - Flow runs paused with end_reason='contact_blocked' stay ended —
 *     they never revive.
 *   - Automation pending executions cancelled (status='done') while
 *     blocked stay done — they never revive either.
 * The SQL function itself never touches flow_runs or
 * automation_pending_executions at all.
 * A brand-new inbound message or a fresh manual/Flow/Automation
 * trigger after this point is unaffected and behaves normally.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { accountId, userId } = await requireRole('agent')
    const { id: contactId } = await params

    // Same nullable-BOOLEAN contract as block_contact_internal:
    // NULL = not found, TRUE = already unblocked (no-op), FALSE = the
    // transition was performed.
    const { data, error } = await supabaseAdmin().rpc('unblock_contact_internal', {
      p_account_id: accountId,
      p_contact_id: contactId,
      p_user_id: userId,
    })
    if (error) {
      console.error('[contacts] unblock_contact_internal rpc failed:', error.message)
      return NextResponse.json({ error: 'Failed to unblock contact' }, { status: 500 })
    }
    if (data === null) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    return NextResponse.json({ success: true, blocked: false })
  } catch (error) {
    return toErrorResponse(error)
  }
}
