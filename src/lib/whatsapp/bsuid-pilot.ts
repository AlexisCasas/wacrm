/**
 * Server-side switch for BSUID support. OFF by default, per business number, never a generic "all accounts" value.
 *
 *   WHATSAPP_BSUID_PILOT = <account_id>:<phone_number_id>:<waba_id>[,<account_id>:<phone_number_id>:<waba_id>...]
 *
 * An event or a send is in scope only when ALL THREE match the account's own `whatsapp_config` row (account id and WABA from
 * the database, `phone_number_id` from the delivery's metadata, and the envelope's `entry.id` when present). Names,
 * usernames, a display phone or a partial number are never consulted. The value stays on the server (never in a
 * `NEXT_PUBLIC_*` variable, never returned by an API), a missing, empty or malformed value means "off", and a malformed
 * entry never widens the scope: it is ignored on its own.
 *
 * What the switch changes (see docs/whatsapp/BSUID_IDENTITY.md):
 *  - receive: a sender identified only by a BSUID is stored (contact + conversation + message) instead of being dropped;
 *  - during the pilot those phone-less contacts are NOT offered to Flows, automations or the AI;
 *  - send: a BSUID is only addressed by an explicitly authorized manual reply (contact_identities.send_authorized_remaining).
 * With the switch off, nothing about phone senders changes, and a BSUID is neither stored nor addressed.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DIGITS = /^\d{6,25}$/

export const BSUID_PILOT_ENV = 'WHATSAPP_BSUID_PILOT'

export interface BsuidPilotScope {
  accountId: string
  phoneNumberId: string
  wabaId: string
}

export function parseBsuidPilot(raw: string | undefined): BsuidPilotScope[] {
  if (!raw) return []
  const out: BsuidPilotScope[] = []
  for (const entry of raw.split(',')) {
    const parts = entry.trim().split(':')
    if (parts.length !== 3) continue
    const [accountId, phoneNumberId, wabaId] = parts.map((p) => p.trim())
    if (UUID.test(accountId) && DIGITS.test(phoneNumberId) && DIGITS.test(wabaId)) {
      out.push({ accountId: accountId.toLowerCase(), phoneNumberId, wabaId })
    }
  }
  return out
}

export interface PilotSubject {
  /** From the matched whatsapp_config row. */
  accountId: string
  wabaId: string | null | undefined
  /** From the delivery's metadata, or from the config row on the send side. */
  phoneNumberId: string | null | undefined
  /** `entry.id` of the webhook envelope (the WABA id per Meta); optional because only deliveries have it. */
  envelopeWabaId?: string | null
}

export function isBsuidPilotEnabled(subject: PilotSubject, env: Record<string, string | undefined> = process.env): boolean {
  const { accountId, wabaId, phoneNumberId, envelopeWabaId } = subject
  if (!accountId || !wabaId || !phoneNumberId) return false
  if (envelopeWabaId !== undefined && envelopeWabaId !== null && String(envelopeWabaId) !== String(wabaId)) return false
  return parseBsuidPilot(env[BSUID_PILOT_ENV]).some(
    (s) => s.accountId === accountId.toLowerCase() && s.phoneNumberId === String(phoneNumberId) && s.wabaId === String(wabaId),
  )
}
