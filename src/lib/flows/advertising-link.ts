/**
 * Pure helpers for the Flow trigger's WhatsApp advertising-link UX
 * (feat/flow-advertising-links). No React, no fetch — kept here (same
 * rationale as `@/lib/flows/edges`) so the keyword-sync and
 * link-construction logic is unit-testable without mounting the
 * builder.
 */

/**
 * Recover the "manual/technical" keyword subset from the full
 * persisted `trigger_config.keywords` array by dropping the exact
 * entry that matches the CURRENT advertising message (if any).
 *
 * This is what `KeywordsInput` is shown and re-parses — it must NEVER
 * see or comma-split the advertising message itself, since that
 * message is free text that can legitimately contain commas (e.g.
 * "Hola, quiero información sobre X, precio, stock y envío"). Editing
 * an unrelated technical keyword must not fragment it.
 */
export function manualKeywordsFrom(
  keywords: string[],
  advertisingMessage: string,
): string[] {
  const msg = advertisingMessage.trim();
  if (!msg) return keywords.slice();
  return keywords.filter((k) => k.trim() !== msg);
}

/**
 * Recombine the manual/technical keywords with the advertising message
 * into the single array persisted as `trigger_config.keywords`. The
 * message is appended WHOLE — never run through `split(',')` — so
 * commas inside it survive as one entry. Never adds a duplicate (e.g.
 * if a manual keyword already equals the message verbatim), and an
 * empty message contributes nothing (this is how "clearing" the field
 * is expressed).
 */
export function combineKeywords(
  manualKeywords: string[],
  advertisingMessage: string,
): string[] {
  const msg = advertisingMessage.trim();
  if (!msg) return manualKeywords.slice();
  if (manualKeywords.some((k) => k.trim() === msg)) return manualKeywords.slice();
  return [...manualKeywords, msg];
}

/**
 * Convenience composition of the two functions above: given the FULL
 * previous `keywords` array plus the previous and next advertising
 * message, produce the FULL next `keywords` array. Equivalent to
 * `combineKeywords(manualKeywordsFrom(keywords, previous), next)` —
 * kept as a named export because it mirrors exactly the "changing the
 * advertising message" mutation the trigger panel performs.
 */
export function syncAdvertisingMessageIntoKeywords(
  keywords: string[],
  previousAdvertisingMessage: string,
  nextAdvertisingMessage: string,
): string[] {
  return combineKeywords(
    manualKeywordsFrom(keywords, previousAdvertisingMessage),
    nextAdvertisingMessage,
  );
}

/**
 * Strip everything `wa.me` doesn't accept: a leading "+", spaces,
 * hyphens, parentheses, and any other non-digit character. `wa.me`
 * wants bare digits (country code + subscriber number).
 *
 * "+51 915 362 074" -> "51915362074"
 */
export function normalizeWhatsAppDigits(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.replace(/\D+/g, "");
}

export interface AdvertisingLinkInput {
  /** Meta's `phone_info.display_phone_number` from GET
   *  /api/whatsapp/config — NEVER `phone_number_id` or any other
   *  technical identifier. */
  displayPhoneNumber: string | null | undefined;
  advertisingMessage: string | null | undefined;
}

/**
 * Build the `wa.me` advertising link, or `null` when either input is
 * missing/unusable. Callers MUST show a helper state instead of a
 * broken link — this never returns a URL built from an empty digits
 * or empty text segment.
 *
 * The message is always run through `encodeURIComponent` — never
 * concatenated raw — so characters like "+" (which `wa.me` would
 * otherwise decode as a literal space in the query string) survive
 * intact.
 */
export function buildWhatsAppAdvertisingLink(input: AdvertisingLinkInput): string | null {
  const digits = normalizeWhatsAppDigits(input.displayPhoneNumber);
  const message = (input.advertisingMessage ?? "").trim();
  if (!digits || !message) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}
