/**
 * WhatsApp business-scoped user ids (BSUID) — validation and extraction helpers.
 *
 * Contract (Meta, "Business-scoped user IDs", consulted 2026-10-25):
 *   inbound   messages[].from_user_id      the sender's BSUID (messages[].from may be absent)
 *             contacts[].user_id           same id, on the contact object (contacts[].wa_id may be absent)
 *             contacts[].parent_user_id    only when parent BSUIDs are enabled (shape `CC.ENT.<id>`)
 *             contacts[].profile.username  only when the user enabled the username feature
 *   status    statuses[].recipient_user_id (statuses[].recipient_id is omitted when the phone cannot be shown)
 *   outbound  `recipient: <BSUID>` instead of `to` (when both are sent, `to` wins)
 * A BSUID is a country-code prefix, a dot and an opaque id (for example `CC.xxxxxxxx`). It is scoped to a business
 * portfolio, so it is only ever a key together with the WACRM account that owns the number. Usernames can change and are
 * display data, never an identifier.
 *
 * The message id (`wamid.…`) is NOT an identity, even when it happens to embed one: it is never read here.
 */

/** Opaque id with a two-letter prefix: `CC.<id>`. Deliberately permissive about the id part, strict about control chars. */
const BSUID = /^[A-Za-z]{2}\.[A-Za-z0-9._-]{3,150}$/
/** Parent BSUID: `CC.ENT.<id>`. */
const PARENT_BSUID = /^[A-Za-z]{2}\.ENT\.[A-Za-z0-9._-]{3,150}$/

export function isValidBsuid(value: unknown): value is string {
  return typeof value === 'string' && BSUID.test(value) && !PARENT_BSUID.test(value)
}

export function isValidParentBsuid(value: unknown): value is string {
  return typeof value === 'string' && PARENT_BSUID.test(value)
}

/** A username is display text only; trim, drop control characters and bound the length. */
export function cleanUsername(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100)
  return cleaned || undefined
}

/** For logs: shows that an id exists and its prefix, never the id. */
export function describeBsuid(value: unknown): string {
  if (typeof value !== 'string' || !value) return 'absent'
  return isValidBsuid(value) || isValidParentBsuid(value) ? `valid:${value.slice(0, 2).toUpperCase()}` : 'invalid-shape'
}
