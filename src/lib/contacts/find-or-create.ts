import type { SupabaseClient } from '@supabase/supabase-js'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

export interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row — callers use this to decide
   *  whether a `new_contact_created`-style trigger should fire. */
  wasCreated: boolean
}

/**
 * Find-or-create a contact by phone, scoped to `accountId`. Shared by
 * every inbound path that mirrors a customer message into the CRM (the
 * Meta webhook, and the ManyChat bridge — see
 * src/app/api/integrations/manychat/inbound/route.ts) so they agree on
 * what "same contact" means and how a create-race is resolved.
 *
 * Extracted verbatim from the Meta webhook's private helper (issue
 * #212's dedupe logic already lived in `dedupe.ts`; this just gives the
 * find-or-create *shape* around it a second caller) — behavior is
 * unchanged, confirmed by the webhook's existing test suite passing
 * after the extraction.
 */
export async function findOrCreateContact(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string,
): Promise<ContactOutcome | null> {
  const existingContact = await findExistingContact(db, accountId, phone)

  if (existingContact) {
    if (name && name !== existingContact.name) {
      await db
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  // account_id is the tenancy column; user_id is the NOT NULL FK audit
  // column (no inbound message has a single "user who created" it — we
  // attribute to the WhatsApp config owner as a stable default).
  const { data: newContact, error: createError } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert, and the
    // unique index (migration 022) rejected the duplicate. Re-resolve
    // the existing row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(db, accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}
