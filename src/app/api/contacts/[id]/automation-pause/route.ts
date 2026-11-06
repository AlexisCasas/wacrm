import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/contacts/admin-client'

/**
 * PUT /api/contacts/[id]/automation-pause  { paused: boolean }
 *
 * Pause / resume NEW keyword-triggered automation (Flows by keyword + `keyword_match` automations) for ONE contact. Reads of the state
 * go through RLS (table contact_automation_settings, members only); this route is the only writer.
 *
 * Auth: requireRole('agent') (same gate as block/unblock). accountId/userId come from the session; the browser never supplies them, and the
 * contact must belong to the caller's account. It touches ONLY contact_automation_settings: never flow_runs, automation_logs, waits or
 * pending executions.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { accountId, userId } = await requireRole('agent')
    const { id: contactId } = await params

    const body = (await request.json().catch(() => null)) as { paused?: unknown } | null
    if (!body || typeof body.paused !== 'boolean') {
      return NextResponse.json({ error: 'paused must be a boolean' }, { status: 400 })
    }

    const db = supabaseAdmin()
    const { data: contact, error: contactError } = await db
      .from('contacts')
      .select('id')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (contactError) {
      console.error('[contacts] automation-pause contact lookup failed:', contactError.message)
      return NextResponse.json({ error: 'Failed to update automations' }, { status: 500 })
    }
    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    const { error } = await db.from('contact_automation_settings').upsert(
      {
        contact_id: contactId,
        account_id: accountId,
        keyword_automations_paused: body.paused,
        updated_at: new Date().toISOString(),
        updated_by_user_id: userId,
      },
      { onConflict: 'contact_id' },
    )
    if (error) {
      console.error('[contacts] automation-pause write failed:', error.message)
      return NextResponse.json({ error: 'Failed to update automations' }, { status: 500 })
    }

    return NextResponse.json({ success: true, paused: body.paused })
  } catch (error) {
    return toErrorResponse(error)
  }
}
