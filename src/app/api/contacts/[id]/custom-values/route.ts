import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/contacts/admin-client'

/**
 * DELETE /api/contacts/[id]/custom-values — clear ALL custom-field VALUES of ONE contact.
 *
 * Auth: requireRole('agent') (same gate as editing values in the Inbox). accountId comes from the session; the browser never supplies it.
 * The contact must exist AND belong to the caller's account before anything is deleted, so a foreign or unknown id is a 404 and deletes nothing.
 * The only write is `DELETE FROM contact_custom_values WHERE contact_id = <that contact>`: never custom_fields (definitions), never other
 * contacts, and never an unfiltered delete. Idempotent: a contact with no values returns success.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { accountId } = await requireRole('agent')
    const { id: contactId } = await params
    if (!contactId) {
      return NextResponse.json({ error: 'Contact id is required' }, { status: 400 })
    }

    const db = supabaseAdmin()
    const { data: contact, error: contactError } = await db
      .from('contacts')
      .select('id')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (contactError) {
      console.error('[contacts] custom-values contact lookup failed:', contactError.message)
      return NextResponse.json({ error: 'Failed to clear custom fields' }, { status: 500 })
    }
    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    const { error } = await db
      .from('contact_custom_values')
      .delete()
      .eq('contact_id', contact.id)
    if (error) {
      console.error('[contacts] custom-values delete failed:', error.message)
      return NextResponse.json({ error: 'Failed to clear custom fields' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
