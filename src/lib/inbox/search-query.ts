import type { Conversation } from "@/types";

/**
 * Inbox search planning (FIX-01).
 *
 * Turns what the operator typed into (a) a PostgREST `or()` filter for the
 * embedded contact and (b) a LIKE pattern for the last message, and provides
 * the matching in-memory predicate so the DB result and the client-side
 * re-filter always agree.
 *
 * Phones are stored digits-only (`contacts.phone`, `contacts.phone_normalized`),
 * so a phone typed as "+51 987-654-321" must be reduced to digits before it is
 * compared. A complete number is matched EXACTLY on `phone_normalized`
 * (never by suffix); only an obvious fragment (6-8 digits, or 9 digits that
 * are not a Peruvian mobile) falls back to a substring match.
 *
 * No database change is needed: everything below runs on existing columns.
 */

/** Smallest digit run treated as a phone fragment (shorter stays a plain text search). */
export const MIN_PHONE_FRAGMENT_DIGITS = 6;

export interface InboxSearchPlan {
  /** Trimmed term exactly as typed. */
  term: string;
  /** Lower-cased term for the in-memory comparison. */
  lowerTerm: string;
  /** LIKE pattern (`%…%`) with LIKE wildcards in the term escaped. */
  likePattern: string;
  /** Full numbers to match exactly against the digits-only phone. Empty when not a full number. */
  phoneExact: string[];
  /** Digits for a substring phone match (fragments only). Null otherwise. */
  phoneFragment: string | null;
  /** PostgREST `or()` expression for the contact (name, username, phone). */
  contactOrFilter: string;
}

/** Characters a phone typed by a person can contain besides digits. */
const PHONE_LIKE = /^[+\d\s().\-–—]+$/;

/** Escape `\`, `%` and `_` so the term is matched literally by LIKE/ILIKE. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Quote a value for use inside a PostgREST `or()` expression. Double quotes make
 * `, ( ) : .` literal; `"` and `\` inside the value are backslash-escaped.
 */
export function quotePostgrestValue(value: string): string {
  return `"${value.replace(/[\\"]/g, (m) => `\\${m}`)}"`;
}

/**
 * Digits of a phone-looking term, or null when the term is plain text.
 * "0051…" (international dialling prefix) is reduced to the number itself.
 */
export function phoneDigitsFromTerm(term: string): string | null {
  const trimmed = term.trim();
  if (!trimmed || !PHONE_LIKE.test(trimmed)) return null;
  let digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("00") && digits.length > 11) digits = digits.slice(2);
  return digits;
}

/** Candidate stored forms for a COMPLETE number; empty when `digits` is only a fragment. */
export function exactPhoneCandidates(digits: string): string[] {
  // Peruvian mobile typed nationally: 9 digits starting with 9.
  if (digits.length === 9 && digits.startsWith("9")) return [`51${digits}`, digits];
  // Peruvian mobile with country code.
  if (digits.length === 11 && digits.startsWith("51")) return [digits, digits.slice(2)];
  // Any other full international number.
  if (digits.length >= 10 && digits.length <= 15) return [digits];
  return [];
}

/** Most contacts a phone-on-order lookup may expand into conversations (URL size / ambiguity guard). */
export const MAX_ORDER_MATCH_CONTACTS = 100;

/**
 * Full phone numbers whose ORDERS should be consulted. Only a complete number
 * qualifies (never a fragment or free text), so a short term can't fan out
 * across many unrelated orders. Same candidates the contact search uses.
 */
export function orderPhoneCandidates(plan: Pick<InboxSearchPlan, "phoneExact">): string[] {
  return plan.phoneExact;
}

/**
 * Progressive historical windows for an exact phone fallback through confirmed
 * orders. The UI never exposes these steps: callers try them oldest only when
 * newer windows have no match, and stop on the first hit.
 */
export const ORDER_PHONE_WINDOW_DAYS = [15, 30, 90, 180, 365] as const;

export interface PhoneSearchWindow {
  after: string | null;
  before: string | null;
}

export function orderPhoneSearchWindows(nowMs: number = Date.now()): PhoneSearchWindow[] {
  const isoBefore = (days: number) => new Date(nowMs - days * 86_400_000).toISOString();
  const out: PhoneSearchWindow[] = [];
  let previous: string | null = null;
  for (const days of ORDER_PHONE_WINDOW_DAYS) {
    const boundary = isoBefore(days);
    out.push({ after: boundary, before: previous });
    previous = boundary;
  }
  out.push({ after: null, before: previous });
  return out;
}

export interface OrderContactPick {
  /** Distinct contact ids, most recent order first, at most `MAX_ORDER_MATCH_CONTACTS`. */
  contactIds: string[];
  /** True when more matches exist than were expanded (cap or page limit hit). */
  truncated: boolean;
}

/**
 * Reduce order rows (newest first) to distinct contact ids. Several orders of
 * one contact collapse to one id; null contact ids (deleted contacts) are
 * ignored. `pageSize` is the page limit used to fetch `rows`: a full page means
 * there may be more orders than we saw.
 */
export function pickOrderContactIds(
  rows: ReadonlyArray<{ contact_id: string | null }>,
  pageSize: number,
): OrderContactPick {
  const seen = new Set<string>();
  for (const row of rows) if (row.contact_id) seen.add(row.contact_id);
  const all = Array.from(seen);
  return {
    contactIds: all.slice(0, MAX_ORDER_MATCH_CONTACTS),
    truncated: all.length > MAX_ORDER_MATCH_CONTACTS || rows.length >= pageSize,
  };
}

export function planInboxSearch(rawTerm: string): InboxSearchPlan {
  const term = rawTerm.trim();
  const likePattern = `%${escapeLike(term)}%`;
  const digits = phoneDigitsFromTerm(term);

  let phoneExact: string[] = [];
  let phoneFragment: string | null = null;
  if (digits) {
    phoneExact = exactPhoneCandidates(digits);
    if (phoneExact.length === 0 && digits.length >= MIN_PHONE_FRAGMENT_DIGITS) {
      phoneFragment = digits;
    }
  }

  const parts = [
    `name.ilike.${quotePostgrestValue(likePattern)}`,
    `wa_username.ilike.${quotePostgrestValue(likePattern)}`,
  ];
  if (phoneExact.length > 0) {
    // Digits only: safe unquoted inside in.(…).
    parts.push(`phone_normalized.in.(${phoneExact.join(",")})`);
  } else if (phoneFragment) {
    parts.push(`phone.ilike.${quotePostgrestValue(`%${phoneFragment}%`)}`);
  } else {
    parts.push(`phone.ilike.${quotePostgrestValue(likePattern)}`);
  }

  return {
    term,
    lowerTerm: term.toLowerCase(),
    likePattern,
    phoneExact,
    phoneFragment,
    contactOrFilter: parts.join(","),
  };
}

/** In-memory twin of the database search (name, username, phone, last message). */
export function matchesInboxSearch(
  conversation: Pick<Conversation, "id" | "contact" | "last_message_text">,
  plan: InboxSearchPlan,
  /** Conversations already matched through an order phone (see FIX 02). */
  orderMatchedIds?: ReadonlySet<string>,
): boolean {
  if (!plan.term) return true;
  if (orderMatchedIds?.has(conversation.id)) return true;
  const contact = conversation.contact;
  const name = contact?.name?.toLowerCase() ?? "";
  const username = contact?.wa_username?.toLowerCase() ?? "";
  const lastMessage = conversation.last_message_text?.toLowerCase() ?? "";
  if (
    name.includes(plan.lowerTerm) ||
    username.includes(plan.lowerTerm) ||
    lastMessage.includes(plan.lowerTerm)
  ) {
    return true;
  }

  const phone = contact?.phone ?? "";
  const phoneDigits = phone.replace(/\D/g, "");
  if (plan.phoneExact.length > 0) return plan.phoneExact.includes(phoneDigits);
  if (plan.phoneFragment) return phoneDigits.includes(plan.phoneFragment);
  return phone.toLowerCase().includes(plan.lowerTerm);
}
