import { describe, expect, it } from "vitest";
import { extractFepEvidence, fepWindowState, formatRemaining, FEP_ENDING_SOON_MS } from "./fep-window";

const EXP = "1794000000";
const AD_CONV = { expiration_timestamp: EXP, origin: { type: "referral_conversion" } };

describe("extractFepEvidence", () => {
  it("free_entry_point + Meta's expiration: both, the expiration as the exact UTC instant Meta sent", () => {
    const e = extractFepEvidence({ pricing: { type: "free_entry_point", category: "service" }, conversation: AD_CONV });
    expect(e).toEqual({ pricingType: "free_entry_point", pricingCategory: "service", expiresAt: new Date(1794000000 * 1000) });
    expect(e!.expiresAt!.toISOString()).toBe("2026-11-06T21:20:00.000Z");
  });
  it("free_entry_point without any conversation: the type only, no end", () => {
    expect(extractFepEvidence({ pricing: { type: "free_entry_point", category: "service" } })).toEqual({ pricingType: "free_entry_point", pricingCategory: "service", expiresAt: null });
  });
  it("the expiration of an ad conversation without pricing (the `sent` half) is kept for the database to merge", () => {
    expect(extractFepEvidence({ conversation: AD_CONV })).toEqual({ pricingType: null, pricingCategory: null, expiresAt: new Date(1794000000 * 1000) });
  });
  it("regular and free_customer_service are not FEP evidence", () => {
    expect(extractFepEvidence({ pricing: { type: "regular", category: "marketing" } })).toBeNull();
    expect(extractFepEvidence({ pricing: { type: "free_customer_service", category: "service" } })).toBeNull();
  });
  it("no pricing and no conversation: nothing", () => {
    expect(extractFepEvidence({})).toBeNull();
    expect(extractFepEvidence({ pricing: null, conversation: null })).toBeNull();
  });
  it("an ordinary (non-ad) conversation expiration is NOT evidence, even with a timestamp (older API versions send it for every message)", () => {
    expect(extractFepEvidence({ conversation: { expiration_timestamp: EXP, origin: { type: "service" } } })).toBeNull();
    expect(extractFepEvidence({ conversation: { expiration_timestamp: EXP } })).toBeNull();
    expect(extractFepEvidence({ pricing: { type: "regular" }, conversation: { expiration_timestamp: EXP, origin: { type: "marketing" } } })).toBeNull();
  });
  it("FEP pricing next to an ordinary conversation never borrows that conversation's expiration", () => {
    expect(extractFepEvidence({ pricing: { type: "free_entry_point" }, conversation: { expiration_timestamp: EXP, origin: { type: "service" } } })?.expiresAt).toBeTruthy();
  });
  it("garbage is dropped, never thrown", () => {
    expect(extractFepEvidence({ pricing: { type: "FREE ENTRY; DROP" } })).toBeNull();
    expect(extractFepEvidence({ pricing: { type: "free_entry_point", category: 5 }, conversation: { expiration_timestamp: "soon" } })).toEqual({ pricingType: "free_entry_point", pricingCategory: null, expiresAt: null });
    expect(extractFepEvidence({ pricing: { type: "free_entry_point" }, conversation: { expiration_timestamp: -1 } })?.expiresAt).toBeNull();
  });
});

describe("fepWindowState", () => {
  const NOW = Date.parse("2026-11-07T00:00:00Z");
  const at = (ms: number) => ({ expiration_at: new Date(NOW + ms).toISOString() });
  it("no Meta evidence: nothing", () => expect(fepWindowState(null, NOW)).toEqual({ kind: "none" }));
  it("confirmed but Meta sent no end: active, no time", () => expect(fepWindowState({ expiration_at: null }, NOW)).toEqual({ kind: "active_unknown_end" }));
  it("a future expiration: the exact time left", () => expect(fepWindowState(at(2 * 86400_000 + 14 * 3600_000), NOW)).toEqual({ kind: "countdown", remainingMs: 2 * 86400_000 + 14 * 3600_000, endingSoon: false }));
  it("under 6 hours: ending soon", () => {
    expect(fepWindowState(at(FEP_ENDING_SOON_MS - 1), NOW)).toMatchObject({ kind: "countdown", endingSoon: true });
    expect(fepWindowState(at(FEP_ENDING_SOON_MS), NOW)).toMatchObject({ kind: "countdown", endingSoon: false });
  });
  it("reaching zero ends it, and so does any past real expiration", () => {
    expect(fepWindowState(at(0), NOW)).toEqual({ kind: "ended" });
    expect(fepWindowState(at(-1), NOW)).toEqual({ kind: "ended" });
    expect(fepWindowState(at(-5 * 86400_000), NOW)).toEqual({ kind: "ended" });
  });
  it("an unreadable expiration claims nothing", () => expect(fepWindowState({ expiration_at: "garbage" }, NOW)).toEqual({ kind: "none" }));
});

describe("formatRemaining", () => {
  it("days and hours / hours and minutes / minutes", () => {
    expect(formatRemaining(2 * 86400_000 + 14 * 3600_000 + 59_000)).toBe("2 d 14 h");
    expect(formatRemaining(3 * 3600_000 + 20 * 60_000)).toBe("3 h 20 min");
    expect(formatRemaining(45 * 60_000)).toBe("45 min");
    expect(formatRemaining(1_000)).toBe("1 min");
  });
});
