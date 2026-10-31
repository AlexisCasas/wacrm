import type { SupabaseClient } from '@supabase/supabase-js'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { findOrCreateContact, type ContactOutcome } from '@/lib/contacts/find-or-create'
import type { InboundIdentity } from '@/lib/whatsapp/resolve-sender-identity'

type Resolved = Extract<InboundIdentity, { ok: true }>

export interface InboundContactOutcome extends ContactOutcome {
  /** Which identity located the contact. */
  via: 'phone' | 'bsuid' | 'phone+bsuid'
  /** Set when the phone and the BSUID of one event point at two different contacts. Nothing was merged. */
  conflict?: { phone_contact_id: string; bsuid_contact_id: string }
}

/**
 * Find or create the contact of an inbound sender, whichever identity Meta provided.
 *
 *  - phone only            → exactly the previous behaviour (`findOrCreateContact`).
 *  - phone + BSUID         → the phone contact (found or created) gains the BSUID. One event carrying both ids is the
 *                            evidence that they are the same person. If the BSUID already belongs to a DIFFERENT contact,
 *                            nothing is merged: the event goes to the BSUID's contact and the conflict is reported.
 *  - BSUID only            → the contact that owns the BSUID in this account, or a new phone-less contact created
 *                            atomically in the database (`resolve_bsuid_contact`).
 *  - BSUID + previous id   → a BSUID that Meta says replaced a known one attaches to that contact (history is kept).
 *
 * Never links by display name, by username or by a partial phone match, and never copies a BSUID into `phone`.
 * Any lookup error returns null (fail closed) rather than creating a possible duplicate.
 */
export async function resolveInboundContact(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  identity: Resolved,
  fallbackName: string,
): Promise<InboundContactOutcome | null> {
  const { phone, bsuid } = identity
  const name = identity.name ?? ''

  if (!bsuid) {
    if (!phone) return null
    const out = await findOrCreateContact(db, accountId, configOwnerUserId, phone, name || fallbackName)
    return out ? { ...out, via: 'phone' } : null
  }

  const owner = await findIdentityOwner(db, accountId, bsuid)
  if (owner === 'error') return null

  // The id is new here but Meta says it replaced one we know: same person, keep the history.
  if (!owner && identity.previousBsuid) {
    const previousOwner = await findIdentityOwner(db, accountId, identity.previousBsuid)
    if (previousOwner === 'error') return null
    if (previousOwner) {
      const linked = await linkBsuid(db, accountId, previousOwner, identity, identity.previousBsuid)
      if (!linked || linked.outcome === 'conflict') return null
      return withContact(db, accountId, previousOwner, false, 'bsuid', identity, name)
    }
  }

  if (phone) {
    const phoneContact = await findExistingContact(db, accountId, phone)
    if (owner && phoneContact && owner !== phoneContact.id) {
      const out = await withContact(db, accountId, owner, false, 'bsuid', identity, name)
      return out ? { ...out, conflict: { phone_contact_id: phoneContact.id, bsuid_contact_id: owner } } : null
    }
    if (owner) {
      // The BSUID's contact has no phone on file and the event now shows one nobody else owns: record it.
      const out = await withContact(db, accountId, owner, false, 'phone+bsuid', identity, name)
      if (out && !phoneContact && !String(out.contact.phone ?? '').replace(/\D/g, '')) {
        const { error } = await db.from('contacts').update({ phone }).eq('id', owner).eq('account_id', accountId)
        if (error && !isUniqueViolation(error)) console.error('[contacts] could not record the phone of a BSUID contact', { account_id: accountId })
        else if (!error) out.contact = { ...out.contact, phone }
      }
      return out
    }
    const base = phoneContact
      ? ({ contact: phoneContact, wasCreated: false } as ContactOutcome)
      : await findOrCreateContact(db, accountId, configOwnerUserId, phone, name || fallbackName)
    if (!base) return null
    const linked = await linkBsuid(db, accountId, base.contact.id, identity)
    if (!linked) return { ...base, via: 'phone' } // keep the message; the id is linked on a later event
    if (linked.outcome === 'conflict') {
      // Lost a race with another delivery that linked this id elsewhere: follow the id, merge nothing.
      const out = await withContact(db, accountId, linked.owner, false, 'bsuid', identity, name)
      return out ? { ...out, conflict: { phone_contact_id: base.contact.id, bsuid_contact_id: linked.owner } } : null
    }
    return { ...base, via: 'phone+bsuid' }
  }

  // BSUID only.
  if (owner) return withContact(db, accountId, owner, false, 'bsuid', identity, name)
  const { data, error } = await db.rpc('resolve_bsuid_contact', {
    p_account_id: accountId,
    p_owner_user_id: configOwnerUserId,
    p_bsuid: bsuid,
    p_parent_bsuid: identity.parentBsuid ?? null,
    p_username: identity.username ?? null,
    p_name: name || null,
  })
  const row = Array.isArray(data) ? data[0] : data
  if (error || !row?.contact_id) {
    console.error('[contacts] resolve_bsuid_contact failed', { account_id: accountId, code: (error as { code?: string } | null)?.code })
    return null
  }
  return withContact(db, accountId, row.contact_id as string, Boolean(row.created), 'bsuid', identity, name)
}

async function findIdentityOwner(db: SupabaseClient, accountId: string, bsuid: string): Promise<string | null | 'error'> {
  const { data, error } = await db
    .from('contact_identities')
    .select('contact_id')
    .eq('account_id', accountId)
    .eq('kind', 'bsuid')
    .eq('value', bsuid)
    .maybeSingle()
  if (error) {
    console.error('[contacts] BSUID lookup failed', { account_id: accountId, code: (error as { code?: string }).code })
    return 'error'
  }
  return (data as { contact_id: string } | null)?.contact_id ?? null
}

async function linkBsuid(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  identity: Resolved,
  supersedes?: string,
): Promise<{ outcome: 'linked' | 'already_linked' | 'conflict'; owner: string } | null> {
  const { data, error } = await db.rpc('link_contact_bsuid', {
    p_account_id: accountId,
    p_contact_id: contactId,
    p_bsuid: identity.bsuid,
    p_parent_bsuid: identity.parentBsuid ?? null,
    p_username: identity.username ?? null,
    p_supersedes: supersedes ?? null,
  })
  const row = Array.isArray(data) ? data[0] : data
  if (error || !row?.outcome) {
    console.error('[contacts] link_contact_bsuid failed', { account_id: accountId, code: (error as { code?: string } | null)?.code })
    return null
  }
  return { outcome: row.outcome, owner: row.owner_contact_id as string }
}

/** Load the contact row and sync the display name / username for a contact that is not blocked. */
async function withContact(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  wasCreated: boolean,
  via: InboundContactOutcome['via'],
  identity: Resolved,
  name: string,
): Promise<InboundContactOutcome | null> {
  const { data, error } = await db.from('contacts').select('*').eq('id', contactId).eq('account_id', accountId).maybeSingle()
  if (error || !data) {
    console.error('[contacts] contact row not readable after identity resolution', { account_id: accountId })
    return null
  }
  const contact = data as Record<string, unknown> & { id: string; blocked?: boolean; name?: string | null; wa_username?: string | null }
  if (!contact.blocked) {
    const patch: Record<string, unknown> = {}
    if (name && name !== contact.name) patch.name = name
    if (identity.username && identity.username !== contact.wa_username) patch.wa_username = identity.username
    if (Object.keys(patch).length) {
      patch.updated_at = new Date().toISOString()
      await db.from('contacts').update(patch).eq('id', contact.id).eq('account_id', accountId)
      Object.assign(contact, patch)
    }
  }
  return { contact, wasCreated, via }
}
