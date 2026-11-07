import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { captureAdAttribution } from "./ad-attribution";

// An in-memory contact_ad_attributions with the table's semantics: PRIMARY KEY contact_id, upsert + ignoreDuplicates = ON CONFLICT DO NOTHING.
function fakeDb(opts: { failWith?: { code: string } | "throw" } = {}) {
  const rows = new Map<string, Record<string, unknown>>();
  const db = {
    from: (table: string) => {
      if (table !== "contact_ad_attributions") throw new Error(`unexpected table ${table}`);
      return {
        upsert: async (row: Record<string, unknown>, o: { onConflict: string; ignoreDuplicates: boolean }) => {
          if (opts.failWith === "throw") throw new Error("boom");
          if (opts.failWith) return { error: opts.failWith };
          expect(o).toEqual({ onConflict: "contact_id", ignoreDuplicates: true });
          if (!rows.has(row.contact_id as string)) rows.set(row.contact_id as string, row);
          return { error: null };
        },
      };
    },
  };
  return { db: db as unknown as SupabaseClient, rows };
}

const AD = { source_type: "ad", source_id: "A", headline: "Anuncio A", source_url: "https://www.facebook.com/ads/a", ctwa_clid: "clidA" };

describe("captureAdAttribution", () => {
  it("stores a message's ad referral for the contact and its account", async () => {
    const { db, rows } = fakeDb();
    expect(await captureAdAttribution(db, { accountId: "acc-1", contactId: "c-1", referral: AD })).toBe("stored");
    expect(rows.get("c-1")).toMatchObject({ account_id: "acc-1", source_id: "A", headline: "Anuncio A", ctwa_clid: "clidA" });
  });
  it("a message without a referral stores nothing", async () => {
    const { db, rows } = fakeDb();
    expect(await captureAdAttribution(db, { accountId: "acc-1", contactId: "c-1", referral: undefined })).toBe("ignored");
    expect(rows.size).toBe(0);
  });
  it("keeps the first attribution: a later referral to another ad does not replace it, a later plain message does not clear it", async () => {
    const { db, rows } = fakeDb();
    await captureAdAttribution(db, { accountId: "acc-1", contactId: "c-1", referral: AD });
    await captureAdAttribution(db, { accountId: "acc-1", contactId: "c-1", referral: { ...AD, source_id: "B", headline: "Anuncio B" } });
    await captureAdAttribution(db, { accountId: "acc-1", contactId: "c-1", referral: undefined });
    expect(rows.get("c-1")).toMatchObject({ source_id: "A", headline: "Anuncio A" });
  });
  it("is isolated per contact and account: each keeps its own row, stamped with its own account", async () => {
    const { db, rows } = fakeDb();
    await captureAdAttribution(db, { accountId: "lorteg", contactId: "c-1", referral: AD });
    await captureAdAttribution(db, { accountId: "keyler", contactId: "c-2", referral: { ...AD, source_id: "K", headline: "Anuncio K" } });
    expect(rows.get("c-1")).toMatchObject({ account_id: "lorteg", headline: "Anuncio A" });
    expect(rows.get("c-2")).toMatchObject({ account_id: "keyler", headline: "Anuncio K" });
  });
  it("never throws: a database error or exception is reported as 'error' and logs no payload", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const failWith of [{ code: "42501" }, "throw"] as const) {
      const { db } = fakeDb({ failWith });
      expect(await captureAdAttribution(db, { accountId: "a", contactId: "c", referral: AD })).toBe("error");
    }
    expect(JSON.stringify(spy.mock.calls)).not.toContain("clidA");
    spy.mockRestore();
  });
});
