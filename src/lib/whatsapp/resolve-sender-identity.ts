import { normalizePhone } from './phone-utils'
import { cleanUsername, isValidBsuid, isValidParentBsuid } from './bsuid'

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

// ============================================================
// BSUID-aware resolution (migration 077)
// ============================================================

/** The fields of one webhook `messages[]` entry that carry identity. All optional on purpose. */
export interface InboundMessageIdentityFields {
  from?: string | null
  from_user_id?: string | null
  from_parent_user_id?: string | null
  type?: string
  system?: { type?: string; previous_user_id?: string | null } | null
}

/** The paired `contacts[]` entry. Every field is optional per Meta's contract. */
export interface InboundContactIdentityFields {
  wa_id?: string | null
  user_id?: string | null
  parent_user_id?: string | null
  profile?: { name?: string | null; username?: string | null } | null
}

export type InboundIdentity =
  | {
      ok: true
      /** Digits-only phone, when the event carried one. Preferred identity when present. */
      phone?: string
      /** Validated BSUID, when the event carried one. */
      bsuid?: string
      parentBsuid?: string
      /** Display only. */
      username?: string
      /** Display name from the profile, when present. */
      name?: string
      /** BSUID this event says was replaced (system message `user_changed_user_id` / `user_changed_number`). */
      previousBsuid?: string
      warnings: Array<'sender_identity_mismatch' | 'bsuid_mismatch' | 'bsuid_ignored_invalid' | 'parent_bsuid_ignored_invalid'>
    }
  | {
      ok: false
      reason: 'missing_sender_identity' | 'invalid_sender_identity'
      /** Presence only; never values. */
      present: { from: boolean; wa_id: boolean; from_user_id: boolean; user_id: boolean }
    }

/**
 * Identity of an inbound sender from the documented fields. Rules:
 *  - a valid phone (`from`, else `wa_id`) wins as the contact's primary identity, exactly as before;
 *  - the BSUID is read from `messages[].from_user_id` (authoritative for THIS message) and only falls back to
 *    `contacts[].user_id`; a contact whose own phone contradicts the message's phone is not trusted for it;
 *  - with no phone, a valid BSUID is enough; an id that is present but malformed is `invalid_sender_identity`
 *    (distinct from `missing_sender_identity`, where Meta sent neither);
 *  - the username and profile name are optional and display-only.
 */
export function resolveInboundIdentity(
  message: InboundMessageIdentityFields,
  contact: InboundContactIdentityFields | null | undefined,
): InboundIdentity {
  const phoneRes = resolveSenderIdentity(message.from, contact?.wa_id)
  const warnings: Array<'sender_identity_mismatch' | 'bsuid_mismatch' | 'bsuid_ignored_invalid' | 'parent_bsuid_ignored_invalid'> = []
  if (phoneRes.ok && phoneRes.warning) warnings.push(phoneRes.warning)

  // A contact entry whose explicit phone differs from the message's is probably paired by index with another sender.
  const contactTrusted =
    !phoneRes.ok || !contact?.wa_id || normalizePhone(contact.wa_id) === phoneRes.phone

  const fromUser = typeof message.from_user_id === 'string' && message.from_user_id ? message.from_user_id : undefined
  const contactUser = contactTrusted && typeof contact?.user_id === 'string' && contact.user_id ? contact.user_id : undefined
  if (fromUser && contactUser && fromUser !== contactUser) warnings.push('bsuid_mismatch')
  const bsuidCandidate = fromUser ?? contactUser
  let bsuid: string | undefined
  if (bsuidCandidate !== undefined) {
    if (isValidBsuid(bsuidCandidate)) bsuid = bsuidCandidate
    else warnings.push('bsuid_ignored_invalid')
  }

  const parentCandidate =
    (typeof message.from_parent_user_id === 'string' && message.from_parent_user_id) ||
    (contactTrusted && typeof contact?.parent_user_id === 'string' && contact.parent_user_id) ||
    undefined
  let parentBsuid: string | undefined
  if (parentCandidate) {
    if (isValidParentBsuid(parentCandidate)) parentBsuid = parentCandidate
    else warnings.push('parent_bsuid_ignored_invalid')
  }

  if (!phoneRes.ok && !bsuid) {
    return {
      ok: false,
      reason: bsuidCandidate !== undefined ? 'invalid_sender_identity' : 'missing_sender_identity',
      present: {
        from: Boolean(message.from),
        wa_id: Boolean(contact?.wa_id),
        from_user_id: Boolean(fromUser),
        user_id: Boolean(contact?.user_id),
      },
    }
  }

  const previous = message.system?.previous_user_id
  return {
    ok: true,
    phone: phoneRes.ok ? phoneRes.phone : undefined,
    bsuid,
    parentBsuid,
    username: contactTrusted ? cleanUsername(contact?.profile?.username) : undefined,
    name: contactTrusted && typeof contact?.profile?.name === 'string' && contact.profile.name.trim() ? contact.profile.name.trim() : undefined,
    previousBsuid: isValidBsuid(previous) ? previous : undefined,
    warnings,
  }
}
