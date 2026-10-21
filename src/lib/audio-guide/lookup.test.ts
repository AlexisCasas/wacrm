import { describe, expect, it } from "vitest";

import { createMemoryDb, type Row } from "@/lib/flows/test-support/memory-db";
import { isVoiceNoteUrlForAccount } from "@/lib/media/voice-note-path";
import { CatalogLookupError, lookupProductAudios } from "./lookup";
import type { CatalogDb } from "./catalog";

// Synthetic fixtures only: no contact, no real account.
const A = "046ff8c2-1111-4222-8333-444455556666";
const B = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const ORIGIN = "https://supabase.example.test";
const sha = (c: string) => c.repeat(64);

const product = (id: string, account: string, key: string, over: Row = {}): Row => ({ id, account_id: account, product_key: key, display_name: key.toUpperCase(), active: true, revision: 4, ...over });
const item = (id: string, productId: string, account: string, position: number, c: string, over: Row = {}): Row => ({ id, product_id: productId, account_id: account, position, voice_sha256: sha(c), bytes: 1000 * position, duration_ms: 5000, pre_delay_seconds: 5, status: "active", ...over });

function setup(rows: { products?: Row[]; items?: Row[] } = {}) {
  const mem = createMemoryDb({
    audio_guide_products: rows.products ?? [
      product("p-xtd", A, "combo xtd"),
      product("p-off", A, "combo viejo", { active: false }),
      product("p-empty", A, "combo vacio"),
      product("p-alldis", A, "combo apagado"),
      product("p-b", B, "solo en b"),
    ],
    audio_guide_items: rows.items ?? [
      item("i3", "p-xtd", A, 3, "3"), item("i1", "p-xtd", A, 1, "1"), item("i2", "p-xtd", A, 2, "2", { status: "disabled" }),
      item("i-off", "p-off", A, 1, "4"),
      item("i-d1", "p-alldis", A, 1, "5", { status: "disabled" }), item("i-d2", "p-alldis", A, 2, "6", { status: "disabled" }),
      item("i-b", "p-b", B, 1, "7"),
    ],
  });
  return { mem, db: mem.client as unknown as CatalogDb };
}
const look = (db: CatalogDb, productValue: unknown, accountId = A) => lookupProductAudios({ db, accountId, productValue, origin: ORIGIN });

describe("lookupProductAudios: the cases a Flow node branches on", () => {
  it("no_value: null, undefined, empty, blank, invisible-only and non-text values", async () => {
    const { db } = setup();
    for (const v of [null, undefined, "", "   ", "\t\n", "​", 42, {}, []]) expect(await look(db, v)).toEqual({ kind: "no_value" });
  });

  it("unknown_product: a value the account has no product for (and an over-long value)", async () => {
    const { db } = setup();
    expect(await look(db, "Producto que no existe")).toEqual({ kind: "unknown_product", key: "producto que no existe" });
    expect(await look(db, "x".repeat(500))).toEqual({ kind: "unknown_product", key: null, reason: "too_long" });
  });

  it("no_audios: an active product with none, and one whose audios are all disabled", async () => {
    const { db } = setup();
    expect(await look(db, "Combo Vacío")).toMatchObject({ kind: "no_audios", disabledItems: 0, product: { id: "p-empty" } });
    expect(await look(db, "combo apagado")).toMatchObject({ kind: "no_audios", disabledItems: 2, product: { id: "p-alldis" } });
  });

  it("product_inactive: an admin switched the product off (its audios are not returned)", async () => {
    const { db } = setup();
    expect(await look(db, "combo viejo")).toMatchObject({ kind: "product_inactive", product: { id: "p-off", revision: 4 } });
  });

  it("ready: ACTIVE audios only, in playing order, each with its public URL, hash and the pause before it", async () => {
    const { db } = setup();
    const result = await look(db, "Combo XTD");
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.product).toEqual({ id: "p-xtd", productKey: "combo xtd", displayName: "COMBO XTD", revision: 4 });
    expect(result.items.map((i) => [i.position, i.itemId, i.sha256[0]])).toEqual([[1, "i1", "1"], [3, "i3", "3"]]); // i2 is disabled
    expect(result.items.every((i) => i.preDelaySeconds === 5)).toBe(true);
    for (const i of result.items) expect(isVoiceNoteUrlForAccount(i.url, A, { sha256: i.sha256, origin: ORIGIN })).toBe(true);
  });

  it("carries a custom pause per audio", async () => {
    const { db } = setup({ products: [product("p", A, "x")], items: [item("a", "p", A, 1, "1", { pre_delay_seconds: 5 }), item("b", "p", A, 2, "2", { pre_delay_seconds: 12 })] });
    const r = await look(db, "x");
    expect(r.kind === "ready" && r.items.map((i) => i.preDelaySeconds)).toEqual([5, 12]);
  });
});

describe("lookupProductAudios: deterministic normalisation", () => {
  it("the same product under any case, accents, spacing or invisible characters", async () => {
    const { db } = setup();
    for (const v of ["combo xtd", "COMBO XTD", " Combo   XTD ", "Cómbo XTD", "combo xtd", "ＣＯＭＢＯ ＸＴＤ", "combo\nxtd"]) {
      expect(await look(db, v)).toMatchObject({ kind: "ready", product: { id: "p-xtd" } });
    }
  });
  it("is exact: a different or partial value does not match (no fuzzy matching)", async () => {
    const { db } = setup();
    for (const v of ["combo xtd 2", "combo", "xtd", "combo xt", "combo-xtd"]) expect(await look(db, v)).toMatchObject({ kind: "unknown_product" });
  });
});

describe("lookupProductAudios: account isolation", () => {
  it("only reads the given account's products: another account's key is unknown", async () => {
    const { db } = setup();
    expect(await look(db, "solo en b", A)).toEqual({ kind: "unknown_product", key: "solo en b" });
    expect(await look(db, "solo en b", B)).toMatchObject({ kind: "ready", product: { id: "p-b" } });
    expect(await look(db, "combo xtd", B)).toMatchObject({ kind: "unknown_product" });
  });
  it("an item stored under another account is never returned, even if it points at the right product id", async () => {
    const { db } = setup({ products: [product("p", A, "x")], items: [item("mine", "p", A, 1, "1"), item("foreign", "p", B, 2, "2")] });
    const r = await look(db, "x");
    expect(r.kind === "ready" && r.items.map((i) => i.itemId)).toEqual(["mine"]);
  });
  it("the same key in two accounts resolves to each account's own product", async () => {
    const { db } = setup({ products: [product("pa", A, "combo"), product("pb", B, "combo")], items: [item("ia", "pa", A, 1, "1"), item("ib", "pb", B, 1, "2")] });
    expect((await look(db, "combo", A) as { items: Array<{ itemId: string }> }).items[0].itemId).toBe("ia");
    expect((await look(db, "combo", B) as { items: Array<{ itemId: string }> }).items[0].itemId).toBe("ib");
  });
});

describe("lookupProductAudios: failures are not 'unknown'", () => {
  it("throws when the database fails, instead of answering unknown_product", async () => {
    const broken = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "boom" } }) }) }) }) }) } as unknown as CatalogDb;
    await expect(look(broken, "combo xtd")).rejects.toBeInstanceOf(CatalogLookupError);
  });
  it("throws when the audios cannot be read", async () => {
    const half = { from: (t: string) => t === "audio_guide_products"
      ? { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: "p", product_key: "x", display_name: "X", active: true, revision: 1 }, error: null }) }) }) }) }
      : { select: () => ({ eq: () => ({ eq: () => ({ order: async () => ({ data: null, error: { message: "boom" } }) }) }) }) } } as unknown as CatalogDb;
    await expect(look(half, "x")).rejects.toBeInstanceOf(CatalogLookupError);
  });
  it("needs the storage origin configured to build URLs (fails closed)", async () => {
    const { db } = setup();
    const previous = process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    try { await expect(lookupProductAudios({ db, accountId: A, productValue: "combo xtd" })).rejects.toThrow(/NEXT_PUBLIC_SUPABASE_URL/); }
    finally { if (previous !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = previous; }
  });
});
