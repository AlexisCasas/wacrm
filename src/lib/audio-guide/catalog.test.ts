import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ promote: vi.fn(), verify: vi.fn() }));
vi.mock("./voice-note-store", () => ({ promoteVoiceNote: store.promote, verifyStoredVoiceNote: store.verify }));

import { createMemoryDb, type Row } from "@/lib/flows/test-support/memory-db";
import { isVoiceNoteUrlForAccount } from "@/lib/media/voice-note-path";
import {
  addItem, createProduct, defaultLabelFromStagedPath, deleteProduct, getProduct, listProducts, removeItem, reorderItems, saveProduct, updateItem,
  type CatalogDb,
} from "./catalog";

const A = "046ff8c2-1111-4222-8333-444455556666";
const B = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const ORIGIN = "https://supabase.example.test";
const sha = (c: string) => c.repeat(64);

const product = (id: string, account: string, key: string, name: string, over: Row = {}): Row => ({ id, account_id: account, product_key: key, display_name: name, active: true, revision: 1, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", ...over });
const item = (id: string, productId: string, account: string, position: number, c: string, over: Row = {}): Row => ({ id, product_id: productId, account_id: account, position, voice_sha256: sha(c), bytes: 1000, duration_ms: 5000, label: null, pre_delay_seconds: 5, status: "active", ...over });

function setup(initial: Record<string, Row[]> = {}, rpc: Parameters<typeof createMemoryDb>[1] = {}) {
  const mem = createMemoryDb({
    audio_guide_products: [product("p1", A, "combo xtd", "Combo XTD"), product("p2", A, "taladro", "Taladro Pro"), product("pb", B, "combo xtd", "Combo XTD de B")],
    audio_guide_items: [item("i1", "p1", A, 1, "1"), item("i2", "p1", A, 2, "2", { status: "disabled", label: "Guía 2" }), item("ib", "pb", B, 1, "9")],
    ...initial,
  }, rpc);
  return { mem, db: mem.client as unknown as CatalogDb };
}

beforeEach(() => {
  store.promote.mockReset();
  store.verify.mockReset();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", ORIGIN);
});

describe("listProducts", () => {
  it("lists only the account's products with their audio counts", async () => {
    const { db } = setup();
    const r = await listProducts(db, A);
    expect(r.ok && r.value.map((p) => [p.id, p.itemCount, p.activeItemCount])).toEqual([["p1", 2, 1], ["p2", 0, 0]]);
    const other = await listProducts(db, B);
    expect(other.ok && other.value.map((p) => p.id)).toEqual(["pb"]);
  });
  it("searches the normalised key and the visible name (case, accents, spaces)", async () => {
    const { db } = setup();
    for (const q of ["combo", "COMBO", "  cómbo  ", "xtd"]) expect((await listProducts(db, A, q) as { value: Array<{ id: string }> }).value.map((p) => p.id)).toEqual(["p1"]);
    expect((await listProducts(db, A, "pro") as { value: Array<{ id: string }> }).value.map((p) => p.id)).toEqual(["p2"]);
    expect((await listProducts(db, A, "nada") as { value: unknown[] }).value).toEqual([]);
    expect((await listProducts(db, A, "   ") as { value: unknown[] }).value).toHaveLength(2); // a blank search lists everything
  });
  it("reports a database failure as db_error", async () => {
    const broken = { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: null, error: { message: "x" } }) }) }) }) }) } as unknown as CatalogDb;
    expect(await listProducts(broken, A)).toEqual({ ok: false, reason: "db_error" });
  });
});

describe("getProduct", () => {
  it("returns the product with its audios in order and a public URL built for the account", async () => {
    const { db } = setup();
    const r = await getProduct(db, A, "p1", ORIGIN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items.map((i) => [i.position, i.status, i.label])).toEqual([[1, "active", null], [2, "disabled", "Guía 2"]]);
    for (const i of r.value.items) expect(isVoiceNoteUrlForAccount(i.url, A, { sha256: i.sha256, origin: ORIGIN })).toBe(true);
  });
  it("never returns another account's product: not_found", async () => {
    const { db } = setup();
    expect(await getProduct(db, A, "pb", ORIGIN)).toEqual({ ok: false, reason: "not_found" });
    expect(await getProduct(db, A, "does-not-exist", ORIGIN)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("createProduct", () => {
  it("normalises the product value into the key and keeps the visible name as typed", async () => {
    const { db, mem } = setup();
    const r = await createProduct(db, A, { displayName: "Cómbo XTD Plus", productValue: "  CÓMBO   XTD  Plus " });
    expect(r.ok && r.value).toMatchObject({ productKey: "combo xtd plus", displayName: "Cómbo XTD Plus", items: [] });
    expect(mem.table("audio_guide_products").at(-1)).toMatchObject({ account_id: A, product_key: "combo xtd plus" });
  });
  it("always writes under the given account", async () => {
    const { db, mem } = setup();
    await createProduct(db, B, { displayName: "Nuevo", productValue: "nuevo" });
    expect(mem.table("audio_guide_products").at(-1)).toMatchObject({ account_id: B });
  });
  it("refuses an empty value before touching the database, and maps duplicates and check failures", async () => {
    const { db, mem } = setup();
    expect(await createProduct(db, A, { displayName: "X", productValue: "   " })).toEqual({ ok: false, reason: "invalid_value" });
    expect(mem.table("audio_guide_products")).toHaveLength(3);
    const dup = createMemoryDb({}, { failInsert: () => ({ message: "duplicate key", code: "23505" }) });
    expect(await createProduct(dup.client as unknown as CatalogDb, A, { displayName: "X", productValue: "x" })).toEqual({ ok: false, reason: "duplicate_key" });
    const bad = createMemoryDb({}, { failInsert: () => ({ message: "check", code: "23514" }) });
    expect(await createProduct(bad.client as unknown as CatalogDb, A, { displayName: "X", productValue: "x" })).toEqual({ ok: false, reason: "invalid_value" });
    const other = createMemoryDb({}, { failInsert: () => ({ message: "boom", code: "XX000" }) });
    expect(await createProduct(other.client as unknown as CatalogDb, A, { displayName: "X", productValue: "x" })).toEqual({ ok: false, reason: "db_error" });
  });
});

describe("changes go through the atomic functions, always with the session's account", () => {
  const seen: Array<{ fn: string; args: Row }> = [];
  const script = (fn: string, answer: Record<string, unknown>) => ({ [fn]: (args: Row) => { seen.push({ fn, args }); return { data: answer }; } });
  beforeEach(() => { seen.length = 0; });

  it("saveProduct: normalises a new product value and sends only what changes", async () => {
    const { db } = setup({}, { rpc: script("audio_guide_save_product", { ok: true, revision: 6 }) });
    expect(await saveProduct(db, A, "p1", { expectedRevision: 5, displayName: "Nuevo", productValue: " NUEVA  Clave ", active: false })).toEqual({ ok: true, value: { revision: 6 } });
    expect(seen[0]).toEqual({ fn: "audio_guide_save_product", args: { p_account: A, p_product: "p1", p_expected: 5, p_display_name: "Nuevo", p_product_key: "nueva clave", p_active: false } });
    seen.length = 0;
    await saveProduct(db, A, "p1", { expectedRevision: 5, active: true });
    expect(seen[0].args).toMatchObject({ p_display_name: null, p_product_key: null, p_active: true });
    expect(await saveProduct(db, A, "p1", { expectedRevision: 5, productValue: "  " })).toEqual({ ok: false, reason: "invalid_value" });
  });

  it("maps every refusal, including the current revision of a conflict, and never turns an unknown answer into success", async () => {
    for (const reason of ["not_found", "duplicate_key", "invalid_value", "limit_reached", "invalid_order", "file_not_stored", "conflict"]) {
      const { db } = setup({}, { rpc: { audio_guide_remove_item: () => ({ data: { ok: false, reason } }) } });
      expect(await removeItem(db, A, "i1", 1)).toEqual({ ok: false, reason });
    }
    const { db } = setup({}, { rpc: { audio_guide_remove_item: () => ({ data: { ok: false, reason: "revision_conflict", revision: 9 } }) } });
    expect(await removeItem(db, A, "i1", 1)).toEqual({ ok: false, reason: "revision_conflict", revision: 9 });
    for (const data of [{ ok: false, reason: "something new" }, {}, null, "ok", { ok: "true" }]) {
      const { db: d } = setup({}, { rpc: { audio_guide_remove_item: () => ({ data }) } });
      expect(await removeItem(d, A, "i1", 1)).toEqual({ ok: false, reason: "db_error" });
    }
    const { db: err } = setup({}, { rpc: { audio_guide_remove_item: () => ({ error: { message: "down" } }) } });
    expect(await removeItem(err, A, "i1", 1)).toEqual({ ok: false, reason: "db_error" });
  });

  it("reorder, update, delete and remove send the account and revision", async () => {
    const { db } = setup({}, {
      rpc: { ...script("audio_guide_reorder_items", { ok: true, revision: 3 }), ...script("audio_guide_update_item", { ok: true, revision: 4 }), ...script("audio_guide_delete_product", { ok: true }), ...script("audio_guide_remove_item", { ok: true, revision: 5 }) },
    });
    await reorderItems(db, A, "p1", 2, ["i2", "i1"]);
    await updateItem(db, A, "i1", { expectedRevision: 3, status: "disabled", preDelaySeconds: 9, label: "L" });
    await updateItem(db, A, "i1", { expectedRevision: 4, clearLabel: true });
    await removeItem(db, A, "i1", 4);
    await deleteProduct(db, A, "p1", 5);
    expect(seen.map((s) => s.fn)).toEqual(["audio_guide_reorder_items", "audio_guide_update_item", "audio_guide_update_item", "audio_guide_remove_item", "audio_guide_delete_product"]);
    expect(seen.every((s) => s.args.p_account === A)).toBe(true);
    expect(seen[0].args).toEqual({ p_account: A, p_product: "p1", p_expected: 2, p_item_ids: ["i2", "i1"] });
    expect(seen[1].args).toMatchObject({ p_status: "disabled", p_pre_delay: 9, p_label: "L", p_clear_label: false });
    expect(seen[2].args).toMatchObject({ p_status: null, p_pre_delay: null, p_label: null, p_clear_label: true });
  });
});

describe("addItem", () => {
  const args = { p: [] as Row[] };
  const rpcOk = { audio_guide_add_item: (a: Row) => { args.p.push(a); return { data: { ok: true, item_id: "new-item", position: 3, revision: 8 } }; } };
  beforeEach(() => { args.p = []; });

  it("staged upload: verifies and stores it first, then records ITS size, duration and hash (never the caller's)", async () => {
    store.promote.mockResolvedValue({ ok: true, sha256: sha("c"), bytes: 4321, durationMs: 7777, url: "u", objectPath: "o" });
    const { db } = setup({}, { rpc: rpcOk });
    const path = `account-${A}/voice-staging/1700000000000-Guia_1.ogg`;
    const r = await addItem(db, A, "p1", { expectedRevision: 7, source: { kind: "staged", path } });
    expect(r).toEqual({ ok: true, value: { itemId: "new-item", position: 3, revision: 8 } });
    expect(store.promote).toHaveBeenCalledWith({ admin: db, accountId: A, stagingPath: path });
    expect(args.p[0]).toEqual({ p_account: A, p_product: "p1", p_expected: 7, p_sha256: sha("c"), p_bytes: 4321, p_duration_ms: 7777, p_label: "Guia_1.ogg", p_pre_delay: 5 });
  });

  it("stored hash: re-verifies the file of THIS account", async () => {
    store.verify.mockResolvedValue({ ok: true, sha256: sha("d"), bytes: 100, durationMs: 2000 });
    const { db } = setup({}, { rpc: rpcOk });
    await addItem(db, A, "p1", { expectedRevision: 1, source: { kind: "stored", sha256: sha("d") }, label: "Mi guía", preDelaySeconds: 10 });
    expect(store.verify).toHaveBeenCalledWith({ admin: db, accountId: A, sha256: sha("d") });
    expect(args.p[0]).toMatchObject({ p_label: "Mi guía", p_pre_delay: 10, p_sha256: sha("d") });
  });

  it("a file the server rejects, cannot find or cannot store never reaches the catalog", async () => {
    const { db } = setup({}, { rpc: rpcOk });
    store.promote.mockResolvedValue({ ok: false, code: "rejected", reason: "not_mono" });
    expect(await addItem(db, A, "p1", { expectedRevision: 1, source: { kind: "staged", path: "x" } })).toEqual({ ok: false, reason: "file_rejected", voiceNoteReason: "not_mono" });
    store.promote.mockResolvedValue({ ok: false, code: "not_found" });
    expect(await addItem(db, A, "p1", { expectedRevision: 1, source: { kind: "staged", path: "x" } })).toEqual({ ok: false, reason: "file_not_stored" });
    store.promote.mockResolvedValue({ ok: false, code: "storage_error" });
    expect(await addItem(db, A, "p1", { expectedRevision: 1, source: { kind: "staged", path: "x" } })).toEqual({ ok: false, reason: "storage_error" });
    store.verify.mockResolvedValue({ ok: false, code: "not_found" });
    expect(await addItem(db, A, "p1", { expectedRevision: 1, source: { kind: "stored", sha256: sha("e") } })).toEqual({ ok: false, reason: "file_not_stored" });
    store.verify.mockResolvedValue({ ok: false, code: "rejected", reason: "crc_mismatch" });
    expect(await addItem(db, A, "p1", { expectedRevision: 1, source: { kind: "stored", sha256: sha("e") } })).toEqual({ ok: false, reason: "file_rejected", voiceNoteReason: "crc_mismatch" });
    expect(args.p).toHaveLength(0);
  });

  it("a product of another account (or an unknown one) is not_found BEFORE any file is verified or stored", async () => {
    const { db } = setup({}, { rpc: rpcOk });
    for (const productId of ["pb", "nope"]) {
      expect(await addItem(db, A, productId, { expectedRevision: 1, source: { kind: "staged", path: `account-${A}/voice-staging/1700000000000-x.ogg` } })).toEqual({ ok: false, reason: "not_found" });
      expect(await addItem(db, A, productId, { expectedRevision: 1, source: { kind: "stored", sha256: sha("d") } })).toEqual({ ok: false, reason: "not_found" });
    }
    expect(store.promote).not.toHaveBeenCalled();
    expect(store.verify).not.toHaveBeenCalled();
    expect(args.p).toHaveLength(0);
  });

  it("when the product refuses the audio (limit, stale revision) the answer says so", async () => {
    store.verify.mockResolvedValue({ ok: true, sha256: sha("d"), bytes: 100, durationMs: 2000 });
    const { db } = setup({}, { rpc: { audio_guide_add_item: () => ({ data: { ok: false, reason: "limit_reached" } }) } });
    expect(await addItem(db, A, "p1", { expectedRevision: 1, source: { kind: "stored", sha256: sha("d") } })).toEqual({ ok: false, reason: "limit_reached" });
  });
});

describe("addItem: the same audio is never added twice to one product", () => {
  const calls = { n: 0 };
  const rpcOk = { audio_guide_add_item: () => { calls.n++; return { data: { ok: true, item_id: "new-item", position: 3, revision: 8 } }; } };
  const staged = { kind: "staged" as const, path: `account-${A}/voice-staging/1700000000000-guia.ogg` };
  beforeEach(() => { calls.n = 0; });

  it("a staged file whose hash is already in the product is refused as duplicate_audio, without calling the add function", async () => {
    store.promote.mockResolvedValue({ ok: true, sha256: sha("1"), bytes: 1000, durationMs: 2000, url: "u", objectPath: "o" }); // p1 already has sha("1")
    const { db } = setup({}, { rpc: rpcOk });
    expect(await addItem(db, A, "p1", { expectedRevision: 1, source: staged })).toEqual({ ok: false, reason: "duplicate_audio" });
    expect(calls.n).toBe(0);
  });

  it("the same holds for a stored hash, and for a disabled audio already in the product", async () => {
    store.verify.mockResolvedValue({ ok: true, sha256: sha("2"), bytes: 1000, durationMs: 2000 }); // p1 has sha("2") (disabled)
    const { db } = setup({}, { rpc: rpcOk });
    expect(await addItem(db, A, "p1", { expectedRevision: 1, source: { kind: "stored", sha256: sha("2") } })).toEqual({ ok: false, reason: "duplicate_audio" });
    expect(calls.n).toBe(0);
  });

  it("a new hash is added; the same hash in ANOTHER product of the account is allowed (the stored file is immutable and shared)", async () => {
    store.promote.mockResolvedValue({ ok: true, sha256: sha("1"), bytes: 1000, durationMs: 2000, url: "u", objectPath: "o" });
    const { db } = setup({}, { rpc: rpcOk });
    expect((await addItem(db, A, "p2", { expectedRevision: 1, source: staged })).ok).toBe(true);
    store.promote.mockResolvedValue({ ok: true, sha256: sha("7"), bytes: 1000, durationMs: 2000, url: "u", objectPath: "o" });
    expect((await addItem(db, A, "p1", { expectedRevision: 1, source: staged })).ok).toBe(true);
    expect(calls.n).toBe(2);
  });

  it("another account's identical hash does not count (the check is scoped to the account and the product)", async () => {
    store.promote.mockResolvedValue({ ok: true, sha256: sha("9"), bytes: 1000, durationMs: 2000, url: "u", objectPath: "o" }); // only B's product has sha("9")
    const { db } = setup({}, { rpc: rpcOk });
    expect((await addItem(db, A, "p1", { expectedRevision: 1, source: staged })).ok).toBe(true);
  });

  it("a failure of the check is a db_error, never a silent add", async () => {
    store.promote.mockResolvedValue({ ok: true, sha256: sha("7"), bytes: 1000, durationMs: 2000, url: "u", objectPath: "o" });
    const { db, mem } = setup({}, { rpc: rpcOk });
    void mem;
    const broken = new Proxy(db as object, { get: (t, k) => (k === "from" ? (table: string) => (table === "audio_guide_items" ? { select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: null, error: { message: "boom" } }) }) }) }) }) } : (t as { from: (n: string) => unknown }).from(table)) : (t as Record<string | symbol, unknown>)[k]) }) as unknown as CatalogDb;
    expect(await addItem(broken, A, "p1", { expectedRevision: 1, source: staged })).toEqual({ ok: false, reason: "db_error" });
    expect(calls.n).toBe(0);
  });
});

describe("defaultLabelFromStagedPath", () => {
  it("drops the editor's epoch prefix and keeps a readable name", () => {
    expect(defaultLabelFromStagedPath(`account-${A}/voice-staging/1700000000000-Guia_1.ogg`)).toBe("Guia_1.ogg");
    expect(defaultLabelFromStagedPath("")).toBe("audio.ogg");
  });
});
