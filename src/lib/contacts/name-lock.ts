import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * FIX 03 — names edited by a person survive inbound WhatsApp messages.
 *
 *  - Automatic sync (webhook, ManyChat, send-by-API): `applyAutomaticName` updates the name ONLY while
 *    `name_locked = false`, in a single conditional UPDATE, so it cannot overwrite a protected name even
 *    when a manual edit lands between its read and its write.
 *  - Manual edits (UI, API, automations): `manualNameChange` returns the patch that sets the name AND the lock
 *    in the same UPDATE, or rejects an empty name without touching the stored name or the lock.
 */

export type ManualNameChange =
  | { ok: true; patch: { name: string; name_locked: true } | Record<string, never> }
  | { ok: false; reason: 'empty' }

/** `current` = the name stored when the editor loaded; `next` = what the person typed. */
export function manualNameChange(current: string | null | undefined, next: string | null | undefined): ManualNameChange {
  const wanted = (next ?? '').trim()
  const existing = (current ?? '').trim()
  if (wanted === existing) return { ok: true, patch: {} } // not a name edit: no lock
  if (!wanted) return { ok: false, reason: 'empty' } // never blank an existing name, never flip the lock
  return { ok: true, patch: { name: wanted, name_locked: true } }
}

/**
 * Refresh a contact's name from the WhatsApp/ManyChat profile unless a person set it. Never throws: a failure
 * here must not stop an inbound message from being processed. Returns true only when a row was updated.
 */
export async function applyAutomaticName(
  db: SupabaseClient,
  contactId: string,
  name: string,
  opts: { accountId?: string } = {},
): Promise<boolean> {
  try {
    let query = db
      .from('contacts')
      .update({ name, updated_at: new Date().toISOString() })
      .eq('id', contactId)
      .eq('name_locked', false)
    if (opts.accountId) query = query.eq('account_id', opts.accountId)
    const { data, error } = await query.select('id')
    if (error) {
      console.error('[contacts] automatic name update failed (message processing continues)', { code: (error as { code?: string }).code })
      return false
    }
    return Array.isArray(data) && data.length > 0
  } catch {
    console.error('[contacts] automatic name update threw (message processing continues)')
    return false
  }
}
