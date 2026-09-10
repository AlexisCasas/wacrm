import { normalizePhone } from './phone-utils'

/**
 * Resolve the phone number identifying an inbound WhatsApp message's
 * sender, from the two fields Meta's webhook payload carries:
 * `messages[].from` (the field the native webhook has always used) and
 * `contacts[].wa_id` (present in every payload but never consulted
 * before this fix). See docs/P1_DUPLICATE_CHATS_AUDIT.md section Q for
 * the incident this closes: `message.from` arriving empty/unresolved
 * let the webhook create a fresh `contact` + `conversation` per
 * message, because nothing ever tried `contact.wa_id` as a fallback or
 * refused to proceed without SOME valid identity.
 *
 * `message.from` is Meta's authoritative field for "who sent THIS
 * message" — whenever it normalizes to a non-empty value, it is used,
 * full stop. `contact.wa_id` is consulted ONLY as a fallback for when
 * `from` itself is empty/unresolvable; it is never allowed to VETO a
 * `from` that IS present and valid.
 *
 * An earlier version of this resolver refused to persist the message
 * at all when `from` and `wa_id` were both present but didn't agree
 * (not even via `phonesMatch()`'s trunk-prefix tolerance). That is a
 * regression, not a safety net: `contacts[i]` is paired with
 * `messages[i]` by array index in the caller
 * (`value.contacts[i] || value.contacts[0]` in the webhook route),
 * which Meta's payload shape does not formally guarantee for every
 * batch shape — so a disagreeing `wa_id` is at least as likely to mean
 * "this secondary field wasn't paired with this message" as "the
 * sender's real number is in question." There is no evidence anywhere
 * in this codebase's history that a *present* `message.from` has ever
 * been wrong. Refusing to store a real customer's message over an
 * unrelated/misaligned secondary field trades a bounded, evidence-free
 * identity risk for a guaranteed, visible one: a lost message. A
 * disagreement is still worth surfacing operationally (see `warning`
 * below) — it just must never silently drop the message.
 *
 * Both fields are normalized to digits-only before comparing, so a
 * missing/undefined/non-numeric value on either side is treated
 * uniformly as "absent" — this function never throws on bad input.
 */
export function resolveSenderIdentity(
  messageFrom: string | null | undefined,
  contactWaId: string | null | undefined,
): SenderIdentityResolution {
  const from = normalizePhone(messageFrom ?? '')
  const waId = normalizePhone(contactWaId ?? '')

  if (from) {
    return {
      ok: true,
      phone: from,
      source: 'message_from',
      // Diagnostic only — see the file-level comment for why this can
      // never refuse the message. Fires for ANY disagreement, whether
      // or not it's a `phonesMatch()`-recognized variant: the accept
      // decision no longer depends on that distinction, only the log.
      warning: waId && waId !== from ? 'sender_identity_mismatch' : undefined,
    }
  }

  if (waId) {
    return { ok: true, phone: waId, source: 'contact_wa_id', warning: undefined }
  }

  return { ok: false, reason: 'missing_sender_identity' }
}

export interface ResolvedSenderIdentity {
  ok: true
  /** Normalized (digits-only) phone to use as the contact's identity for this message. */
  phone: string
  /** Which payload field the identity was drawn from. */
  source: 'message_from' | 'contact_wa_id'
  /**
   * Set when `contact.wa_id` was present but didn't normalize to the
   * SAME value as the resolved `phone`. Purely diagnostic — log it,
   * never act on it. `phone` (from `message.from` whenever it's
   * present) is used exactly as if `wa_id` had agreed or been absent.
   */
  warning?: 'sender_identity_mismatch'
}

export interface UnresolvedSenderIdentity {
  ok: false
  /** Neither `message.from` nor `contact.wa_id` normalizes to any digits. */
  reason: 'missing_sender_identity'
}

export type SenderIdentityResolution = ResolvedSenderIdentity | UnresolvedSenderIdentity
