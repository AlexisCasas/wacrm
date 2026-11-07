import { parseMetaTimestamp } from "./message-status";

/**
 * Meta's "free entry point" (FEP) window, from the STATUS webhooks. Nothing here knows how long a window lasts: the only end is the
 * `conversation.expiration_timestamp` Meta sends, and "free" is only what `pricing.type` says.
 */

export const FEP_PRICING_TYPE = "free_entry_point";
/** `conversation.origin.type` Meta documents for a conversation opened by an ad. */
const FEP_ORIGIN_TYPE = "referral_conversion";

/** The documented (all optional) parts of `statuses[]` this module reads. */
export interface MetaStatusPricingFields {
  pricing?: { type?: unknown; category?: unknown } | null;
  conversation?: { expiration_timestamp?: unknown; origin?: { type?: unknown } | null } | null;
}

export interface MessagePricingEvidence {
  pricingType: string | null;
  pricingCategory: string | null;
  expiresAt: Date | null;
}

const token = (v: unknown): string | null => (typeof v === "string" && /^[a-z_]{1,40}$/.test(v.trim().toLowerCase()) ? v.trim().toLowerCase() : null);

/**
 * FEP evidence of one status event, or null when it carries none (a regular / free_customer_service message, no pricing at all, ...).
 * Evidence is `pricing.type = free_entry_point` (alone it only says Meta treated THAT message as free), or an expiration inside a conversation Meta itself
 * marks as opened by an ad (`referral_conversion`):
 * `sent` carries the conversation and `delivered` / `read` the pricing, so the two halves of one message are merged by the database.
 * Never throws; every field is optional and a malformed one is dropped.
 */
export function extractFepEvidence(status: MetaStatusPricingFields): MessagePricingEvidence | null {
  const pricingType = token(status.pricing?.type);
  const pricingCategory = token(status.pricing?.category);
  const isFepPricing = pricingType === FEP_PRICING_TYPE;
  const isAdConversation = token(status.conversation?.origin?.type) === FEP_ORIGIN_TYPE;
  // The only end Meta gives for an FEP window is the expiration of the conversation it marks as opened by an ad. Any other conversation (before API v24.0
  // Meta sends one for EVERY message: the 24-hour customer service window) is a different window and is never read as the FEP end.
  const expiresAt = isAdConversation ? parseMetaTimestamp(status.conversation?.expiration_timestamp) : null;
  if (!isFepPricing && !(isAdConversation && expiresAt)) return null;
  return { pricingType: isFepPricing ? pricingType : null, pricingCategory: isFepPricing ? pricingCategory : null, expiresAt };
}

// ---------- presentation (pure) ----------

/** Below this many hours left the window is shown as "about to end". A display threshold only; it says nothing about how long a window lasts. */
export const FEP_ENDING_SOON_MS = 6 * 60 * 60 * 1000;

export type FepWindowState =
  | { kind: "none" }
  | { kind: "free_confirmed" }
  | { kind: "countdown"; remainingMs: number; endingSoon: boolean }
  | { kind: "ended" };

/**
 * Priority of what is known: (1) a real Meta expiration -> current state + counter; (2) `free_entry_point` pricing WITHOUT an expiration -> only "Meta
 * confirmed a free message" (nothing about time left or whether a window is still open); (3) no pricing -> nothing.
 * `row` is the contact's chosen FEP row (pricing_type already = free_entry_point), or null when Meta never confirmed one. */
export function fepWindowState(row: { expiration_at: string | null } | null, nowMs: number): FepWindowState {
  if (!row) return { kind: "none" };
  if (row.expiration_at == null) return { kind: "free_confirmed" };
  const end = Date.parse(row.expiration_at);
  if (Number.isNaN(end)) return { kind: "none" };
  const remainingMs = end - nowMs;
  if (remainingMs <= 0) return { kind: "ended" };
  return { kind: "countdown", remainingMs, endingSoon: remainingMs < FEP_ENDING_SOON_MS };
}

/** "2 d 14 h", "3 h 20 min", "45 min" (never "0 min": under a minute is shown as 1 min). */
export function formatRemaining(ms: number): string {
  const totalMin = Math.max(1, Math.floor(ms / 60000));
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}
