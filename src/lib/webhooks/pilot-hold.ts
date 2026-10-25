/**
 * Pilot hold for OUTBOUND webhooks (the public API's `webhook_endpoints`).
 *
 * While the BSUID pilot lasts, nothing about a contact known only by a WhatsApp user id may leave WACRM toward an external
 * endpoint: those endpoints can run arbitrary automations (including sending messages through other channels), and the events
 * carry the message text and the WhatsApp message id, which embeds the sender's identifier. The reception itself stays recorded
 * internally (message, conversation, `contact_identity_audit`).
 *
 * Only accounts listed in WHATSAPP_BSUID_PILOT can ever be held, so every other account behaves exactly as before and pays no
 * extra query. A read error for a pilot account holds (fails closed).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { accountHasBsuidPilot } from '@/lib/whatsapp/bsuid-pilot'
import { hasPhone } from '@/lib/contacts/display'

export async function externalEventsHeldForContact(db: SupabaseClient, accountId: string, contactId: string | null | undefined): Promise<boolean> {
  if (!accountHasBsuidPilot(accountId)) return false
  if (!contactId) return true
  const { data, error } = await db.from('contacts').select('phone').eq('id', contactId).eq('account_id', accountId).maybeSingle()
  if (error || !data) return true
  return !hasPhone(data as { phone?: string | null })
}

/** Record, internally, that an external event was withheld. Best effort: the hold itself already happened. */
export async function auditExternalEventHeld(db: SupabaseClient, accountId: string, contactId: string | null | undefined, event: string): Promise<void> {
  try {
    await db.rpc('audit_bsuid_event', { p_account_id: accountId, p_contact_id: contactId ?? null, p_event: 'external_webhook_skipped', p_origin: 'inbound', p_detail: { event } })
  } catch { /* best effort */ }
}
