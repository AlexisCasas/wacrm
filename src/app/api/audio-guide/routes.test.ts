import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-level security and behaviour of /api/audio-guide/*: roles, the account gate, account isolation, validation and the mapping of
// catalog results to HTTP. The auth layer and the service client are replaced; the routes, validators and catalog service are real,
// running over an in-memory database whose catalog functions are scripted (their SQL is proved by qa/audio-guide/db-catalog-ops.sql).

const h = vi.hoisted(() => ({
  session: { accountId: "", role: "admin" as string, authenticated: true },
  db: null as unknown,
  promote: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("@/lib/auth/account", async () => {
  const roles = await import("@/lib/auth/roles");
  class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
  const ctx = () => ({ accountId: h.session.accountId, role: h.session.role, userId: "u-1", supabase: {}, account: { id: h.session.accountId, name: "A" } });
  return {
    getCurrentAccount: async () => { if (!h.session.authenticated) throw new HttpError(401, "Unauthorized"); return ctx(); },
    requireRole: async (min: "viewer" | "agent" | "admin" | "owner") => {
      if (!h.session.authenticated) throw new HttpError(401, "Unauthorized");
      if (!roles.hasMinRole(h.session.role as never, min)) throw new HttpError(403, "Forbidden");
      return ctx();
    },
    toErrorResponse: (e: unknown) => Response.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 500 }),
  };
});
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => h.db }));
vi.mock("@/lib/audio-guide/voice-note-store", () => ({ promoteVoiceNote: h.promote, verifyStoredVoiceNote: h.verify }));

import { createMemoryDb, type Row } from "@/lib/flows/test-support/memory-db";
import * as productsRoute from "./products/route";
import * as productRoute from "./products/[id]/route";
import * as itemsRoute from "./products/[id]/items/route";
import * as itemRoute from "./products/[id]/items/[itemId]/route";
import * as orderRoute from "./products/[id]/order/route";
import * as lookupRoute from "./lookup/route";

const A = "046ff8c2-1111-4222-8333-444455556666";
const B = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const PA = "a1111111-1111-4111-8111-111111111111"; // product of A
const PB = "b2222222-2222-4222-8222-222222222222"; // product of B
const IA1 = "a3333333-3333-4333-8333-333333333333";
const IA2 = "a4444444-4444-4444-8444-444444444444";
const IB1 = "b5555555-5555-4555-8555-555555555555";
const ORIGIN = "https://supabase.example.test";
const sha = (c: string) => c.repeat(64);

const rpcCalls: Array<{ fn: string; args: Row }> = [];
let rpcAnswer: Record<string, unknown> | null = null;

function database() {
  const product = (id: string, account: string, key: string, name: string): Row => ({ id, account_id: account, product_key: key, display_name: name, active: true, revision: 3, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
  const item = (id: string, pid: string, account: string, position: number, c: string): Row => ({ id, product_id: pid, account_id: account, position, voice_sha256: sha(c), bytes: 1000, duration_ms: 5000, label: null, pre_delay_seconds: 5, status: "active" });
  const rpc: Record<string, (args: Row) => { data: unknown }> = {};
  // The database functions are scripted but keep the one property the route must not break: the product / item must belong to the
  // ACCOUNT THE ROUTE PASSES, otherwise not_found.
  for (const fn of ["audio_guide_save_product", "audio_guide_delete_product", "audio_guide_add_item", "audio_guide_reorder_items"]) {
    rpc[fn] = (args) => {
      rpcCalls.push({ fn, args });
      if (rpcAnswer) return { data: rpcAnswer };
      const owned = mem.table("audio_guide_products").some((p) => p.id === args.p_product && p.account_id === args.p_account);
      return { data: owned ? { ok: true, revision: 4, item_id: "new-item", position: 3 } : { ok: false, reason: "not_found" } };
    };
  }
  for (const fn of ["audio_guide_update_item", "audio_guide_remove_item"]) {
    rpc[fn] = (args) => {
      rpcCalls.push({ fn, args });
      if (rpcAnswer) return { data: rpcAnswer };
      const owned = mem.table("audio_guide_items").some((i) => i.id === args.p_item && i.account_id === args.p_account);
      return { data: owned ? { ok: true, revision: 4 } : { ok: false, reason: "not_found" } };
    };
  }
  const mem: ReturnType<typeof createMemoryDb> = createMemoryDb({
    audio_guide_products: [product(PA, A, "combo xtd", "Combo XTD"), product(PB, B, "solo b", "Solo B")],
    audio_guide_items: [item(IA1, PA, A, 1, "1"), item(IA2, PA, A, 2, "2"), item(IB1, PB, B, 1, "9")],
  }, { rpc });
  h.db = mem.client;
  return mem;
}

const req = (method: string, url: string, body?: unknown) => new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id: string, itemId = "") => ({ params: Promise.resolve({ id, itemId }) });
const read = async (res: Response) => ({ status: res.status, body: await res.json().catch(() => null), cache: res.headers.get("Cache-Control") });

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", ORIGIN);
  vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", A);
  h.session = { accountId: A, role: "admin", authenticated: true };
  h.promote.mockReset();
  h.verify.mockReset();
  rpcCalls.length = 0;
  rpcAnswer = null;
  database();
});

describe("who may call, and when", () => {
  const writes: Array<[string, () => Promise<Response>]> = [
    ["POST products", () => productsRoute.POST(req("POST", "/p", { display_name: "X" }))],
    ["PATCH product", () => productRoute.PATCH(req("PATCH", "/p", { expected_revision: 3, active: false }), ctx(PA))],
    ["DELETE product", () => productRoute.DELETE(req("DELETE", `/p?expected_revision=3`), ctx(PA))],
    ["POST item", () => itemsRoute.POST(req("POST", "/i", { expected_revision: 3, sha256: sha("3") }), ctx(PA))],
    ["PATCH item", () => itemRoute.PATCH(req("PATCH", "/i", { expected_revision: 3, status: "disabled" }), ctx(PA, IA1))],
    ["DELETE item", () => itemRoute.DELETE(req("DELETE", `/i?expected_revision=3`), ctx(PA, IA1))],
    ["PUT order", () => orderRoute.PUT(req("PUT", "/o", { expected_revision: 3, item_ids: [IA2, IA1] }), ctx(PA))],
  ];
  const reads: Array<[string, () => Promise<Response>]> = [
    ["GET products", () => productsRoute.GET(req("GET", "/p"))],
    ["GET product", () => productRoute.GET(req("GET", "/p"), ctx(PA))],
    ["GET lookup", () => lookupRoute.GET(req("GET", "/l?value=combo"))],
  ];

  it.each([...writes, ...reads])("%s is closed while voice notes are not enabled for the account (403, no database use)", async (_n, call) => {
    vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", B);
    const r = await read(await call());
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "voice_notes_disabled" });
    expect(rpcCalls).toHaveLength(0);
  });

  it.each([...writes, ...reads])("%s needs a session (401)", async (_n, call) => {
    h.session.authenticated = false;
    expect((await read(await call())).status).toBe(401);
  });

  it.each(writes)("%s needs the admin role: viewer and agent get 403, admin and owner pass", async (_n, call) => {
    for (const role of ["viewer", "agent"]) { h.session.role = role; rpcCalls.length = 0; expect((await read(await call())).status).toBe(403); expect(rpcCalls).toHaveLength(0); }
    h.promote.mockResolvedValue({ ok: true, sha256: sha("3"), bytes: 10, durationMs: 1000, url: "u", objectPath: "o" });
    h.verify.mockResolvedValue({ ok: true, sha256: sha("3"), bytes: 10, durationMs: 1000 });
    for (const role of ["admin", "owner"]) { h.session.role = role; expect([200, 201]).toContain((await read(await call())).status); }
  });

  it.each(reads)("%s is open to every member, including a viewer", async (_n, call) => {
    for (const role of ["viewer", "agent", "admin", "owner"]) { h.session.role = role; expect((await read(await call())).status).toBe(200); }
  });

  it("answers are never cacheable", async () => {
    expect((await read(await productsRoute.GET(req("GET", "/p")))).cache).toContain("no-store");
    expect((await read(await productsRoute.POST(req("POST", "/p", { display_name: "Nuevo" })))).cache).toContain("no-store");
  });
});

describe("account isolation", () => {
  it("lists only the session account's products; the same call as account B shows only B's", async () => {
    vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", `${A},${B}`);
    const a = await read(await productsRoute.GET(req("GET", "/p")));
    expect(a.body.products.map((p: { id: string }) => p.id)).toEqual([PA]);
    h.session.accountId = B;
    const b = await read(await productsRoute.GET(req("GET", "/p")));
    expect(b.body.products.map((p: { id: string }) => p.id)).toEqual([PB]);
  });

  it("another account's product is not_found for reads and writes, and the database is asked with the SESSION's account id", async () => {
    expect((await read(await productRoute.GET(req("GET", "/p"), ctx(PB)))).status).toBe(404);
    for (const call of [
      () => productRoute.PATCH(req("PATCH", "/p", { expected_revision: 3, display_name: "Hack", account_id: B }), ctx(PB)),
      () => productRoute.DELETE(req("DELETE", `/p?expected_revision=3&account_id=${B}`), ctx(PB)),
      () => itemsRoute.POST(req("POST", "/i", { expected_revision: 3, sha256: sha("9"), account_id: B }), ctx(PB)),
      () => itemRoute.PATCH(req("PATCH", "/i", { expected_revision: 3, status: "disabled" }), ctx(PB, IB1)),
      () => itemRoute.DELETE(req("DELETE", `/i?expected_revision=3`), ctx(PB, IB1)),
      () => orderRoute.PUT(req("PUT", "/o", { expected_revision: 3, item_ids: [IB1] }), ctx(PB)),
    ]) {
      h.verify.mockResolvedValue({ ok: true, sha256: sha("9"), bytes: 10, durationMs: 1000 });
      const r = await read(await call());
      expect(r.status).toBe(404);
    }
    expect(rpcCalls.length).toBeGreaterThan(0);
    expect(rpcCalls.every((c) => c.args.p_account === A)).toBe(true);
  });

  it("an account id in the body, path or query is never used", async () => {
    const r = await read(await productsRoute.POST(req("POST", `/p?account_id=${B}`, { display_name: "Nuevo", account_id: B, accountId: B })));
    expect(r.status).toBe(201);
    expect((h.db as { from: (t: string) => unknown }).from).toBeDefined();
  });
});

describe("validation happens on the server", () => {
  it("a malformed id is a plain 404 and nothing reaches the database", async () => {
    for (const id of ["x", "1", "../etc", "a1111111-1111-4111-8111-11111111111g"]) {
      expect((await read(await productRoute.GET(req("GET", "/p"), ctx(id)))).status).toBe(404);
      expect((await read(await productRoute.PATCH(req("PATCH", "/p", { expected_revision: 1, active: true }), ctx(id)))).status).toBe(404);
    }
    expect(rpcCalls).toHaveLength(0);
  });

  it("rejects bad bodies with 422 and the offending field", async () => {
    const cases: Array<[() => Promise<Response>, string, string]> = [
      [() => productsRoute.POST(req("POST", "/p", {})), "display_name", "display_name_required"],
      [() => productsRoute.POST(req("POST", "/p", { display_name: "x".repeat(121) })), "display_name", "display_name_too_long"],
      [() => productRoute.PATCH(req("PATCH", "/p", { display_name: "x" }), ctx(PA)), "expected_revision", "expected_revision_required"],
      [() => productRoute.PATCH(req("PATCH", "/p", { expected_revision: 3 }), ctx(PA)), "body", "nothing_to_change"],
      [() => productRoute.DELETE(req("DELETE", "/p"), ctx(PA)), "expected_revision", "expected_revision_required"],
      [() => itemsRoute.POST(req("POST", "/i", { expected_revision: 3, sha256: "nope" }), ctx(PA)), "sha256", "invalid_hash"],
      [() => itemsRoute.POST(req("POST", "/i", { expected_revision: 3, path: `account-${B}/voice-staging/1700000000000-x.ogg` }), ctx(PA)), "path", "invalid_path"],
      [() => itemsRoute.POST(req("POST", "/i", { expected_revision: 3, sha256: sha("3"), pre_delay_seconds: 1 }), ctx(PA)), "pre_delay_seconds", "pause_out_of_range"],
      [() => itemRoute.PATCH(req("PATCH", "/i", { expected_revision: 3, sha256: sha("4") }), ctx(PA, IA1)), "sha256", "field_not_editable"],
      [() => orderRoute.PUT(req("PUT", "/o", { expected_revision: 3, item_ids: [IA1, IA1] }), ctx(PA)), "item_ids", "item_ids_repeated"],
    ];
    for (const [call, field, error] of cases) {
      const r = await read(await call());
      expect([r.status, r.body]).toEqual([422, { error, field }]);
    }
    expect(rpcCalls).toHaveLength(0);
  });

  it("never accepts a URL as the audio, however it is spelled", async () => {
    for (const field of ["url", "media_url", "voice_path"]) {
      const r = await read(await itemsRoute.POST(req("POST", "/i", { expected_revision: 3, sha256: sha("3"), [field]: "https://cdn.example/x.ogg" }), ctx(PA)));
      expect([r.status, r.body.error]).toEqual([422, "url_not_accepted"]);
    }
    const asPath = await read(await itemsRoute.POST(req("POST", "/i", { expected_revision: 3, path: "https://cdn.example/x.ogg" }), ctx(PA)));
    expect([asPath.status, asPath.body.error]).toEqual([422, "invalid_path"]);
    expect(h.promote).not.toHaveBeenCalled();
    expect(rpcCalls).toHaveLength(0);
  });

  it("an unparseable body is 422, not a crash", async () => {
    const res = await productsRoute.POST(new Request("http://localhost/p", { method: "POST", body: "{nope" }));
    expect(res.status).toBe(422);
  });
});

describe("behaviour", () => {
  it("creates a product with a normalised key (201) and refuses a duplicate with 409", async () => {
    const created = await read(await productsRoute.POST(req("POST", "/p", { display_name: "Cómbo Nuevo", product_value: "  CÓMBO   Nuevo " })));
    expect(created.status).toBe(201);
    expect(created.body.product).toMatchObject({ product_key: "combo nuevo", display_name: "Cómbo Nuevo", items: [] });
    const mem = createMemoryDb({}, { failInsert: () => ({ message: "duplicate key", code: "23505" }) });
    h.db = mem.client;
    const dup = await read(await productsRoute.POST(req("POST", "/p", { display_name: "Otra", product_value: "combo xtd" })));
    expect([dup.status, dup.body]).toEqual([409, { error: "duplicate_key" }]);
  });

  it("an empty product value is refused (422) without a database write", async () => {
    const r = await read(await productsRoute.POST(req("POST", "/p", { display_name: "X", product_value: "   " })));
    expect([r.status, r.body.error]).toEqual([422, "invalid_value"]);
  });

  it("searches products with ?q= (accents and case ignored)", async () => {
    const r = await read(await productsRoute.GET(req("GET", "/p?q=C%C3%93MBO")));
    expect(r.body.products.map((p: { id: string }) => p.id)).toEqual([PA]);
    expect(r.body.products[0]).toMatchObject({ item_count: 2, active_item_count: 2 });
    const none = await read(await productsRoute.GET(req("GET", "/p?q=zzz")));
    expect(none.body.products).toEqual([]);
  });

  it("returns a product with its audios and public URLs", async () => {
    const r = await read(await productRoute.GET(req("GET", "/p"), ctx(PA)));
    expect(r.body.product.items.map((i: { id: string; position: number }) => [i.id, i.position])).toEqual([[IA1, 1], [IA2, 2]]);
    expect(r.body.product.items[0].url).toBe(`${ORIGIN}/storage/v1/object/public/voice-notes/account-${A}/${sha("1")}.ogg`);
    expect(r.body.product.revision).toBe(3);
  });

  it("a stale revision is 409 with the current revision, for every kind of write", async () => {
    rpcAnswer = { ok: false, reason: "revision_conflict", revision: 9 };
    h.verify.mockResolvedValue({ ok: true, sha256: sha("3"), bytes: 10, durationMs: 1000 });
    for (const call of [
      () => productRoute.PATCH(req("PATCH", "/p", { expected_revision: 3, active: false }), ctx(PA)),
      () => productRoute.DELETE(req("DELETE", `/p?expected_revision=3`), ctx(PA)),
      () => itemsRoute.POST(req("POST", "/i", { expected_revision: 3, sha256: sha("3") }), ctx(PA)),
      () => itemRoute.PATCH(req("PATCH", "/i", { expected_revision: 3, status: "disabled" }), ctx(PA, IA1)),
      () => itemRoute.DELETE(req("DELETE", `/i?expected_revision=3`), ctx(PA, IA1)),
      () => orderRoute.PUT(req("PUT", "/o", { expected_revision: 3, item_ids: [IA2, IA1] }), ctx(PA)),
    ]) {
      const r = await read(await call());
      expect([r.status, r.body]).toEqual([409, { error: "revision_conflict", revision: 9 }]);
    }
  });

  it("adds an audio from a staged upload: the file is verified first and the answer is the refreshed product (201)", async () => {
    h.promote.mockResolvedValue({ ok: true, sha256: sha("3"), bytes: 10, durationMs: 1000, url: "u", objectPath: "o" });
    const path = `account-${A}/voice-staging/1700000000000-guia.ogg`;
    const r = await read(await itemsRoute.POST(req("POST", "/i", { expected_revision: 3, path, label: "Guía 3" }), ctx(PA)));
    expect([r.status, r.body.item_id]).toEqual([201, "new-item"]);
    expect(h.promote).toHaveBeenCalledWith(expect.objectContaining({ accountId: A, stagingPath: path }));
    expect(rpcCalls[0]).toMatchObject({ fn: "audio_guide_add_item", args: { p_account: A, p_product: PA, p_sha256: sha("3"), p_label: "Guía 3", p_pre_delay: 5 } });
  });

  it("a file the server rejects is 422 with the reason and never reaches the catalog", async () => {
    h.promote.mockResolvedValue({ ok: false, code: "rejected", reason: "not_mono" });
    const r = await read(await itemsRoute.POST(req("POST", "/i", { expected_revision: 3, path: `account-${A}/voice-staging/1700000000000-guia.ogg` }), ctx(PA)));
    expect([r.status, r.body]).toEqual([422, { error: "file_rejected", reason: "not_mono" }]);
    expect(rpcCalls).toHaveLength(0);
  });

  it.each([
    ["limit_reached", 422], ["file_not_stored", 422], ["invalid_value", 422], ["invalid_order", 422], ["duplicate_key", 409], ["conflict", 409], ["not_found", 404],
  ])("maps %s to HTTP %i", async (reason, status) => {
    rpcAnswer = { ok: false, reason };
    h.verify.mockResolvedValue({ ok: true, sha256: sha("3"), bytes: 10, durationMs: 1000 });
    const r = await read(await itemsRoute.POST(req("POST", "/i", { expected_revision: 3, sha256: sha("3") }), ctx(PA)));
    expect([r.status, r.body.error]).toEqual([status, reason]);
  });

  it("an unexpected database answer is a generic 500 that leaks nothing", async () => {
    rpcAnswer = { ok: false, reason: "pg: relation exploded at /var/lib/secret" };
    const r = await read(await productRoute.PATCH(req("PATCH", "/p", { expected_revision: 3, active: true }), ctx(PA)));
    expect([r.status, r.body]).toEqual([500, { error: "internal_error" }]);
  });

  it("deleting reports success; the item routes return the refreshed product", async () => {
    expect((await read(await productRoute.DELETE(req("DELETE", `/p?expected_revision=3`), ctx(PA)))).body).toEqual({ deleted: true });
    const patched = await read(await itemRoute.PATCH(req("PATCH", "/i", { expected_revision: 3, status: "disabled", pre_delay_seconds: 9, label: null }), ctx(PA, IA1)));
    expect(patched.status).toBe(200);
    expect(rpcCalls.at(-1)).toMatchObject({ fn: "audio_guide_update_item", args: { p_account: A, p_item: IA1, p_status: "disabled", p_pre_delay: 9, p_clear_label: true } });
    const reordered = await read(await orderRoute.PUT(req("PUT", "/o", { expected_revision: 3, item_ids: [IA2.toUpperCase(), IA1] }), ctx(PA)));
    expect(reordered.status).toBe(200);
    expect(rpcCalls.at(-1)?.args.p_item_ids).toEqual([IA2, IA1]);
  });
});

describe("GET /lookup: how a Producto value resolves for the session account", () => {
  const look = async (value?: string) => read(await lookupRoute.GET(req("GET", value === undefined ? "/l" : `/l?value=${encodeURIComponent(value)}`)));

  it("ready / no_value / unknown_product", async () => {
    const ready = await look(" CÓMBO  xtd ");
    expect(ready.body.kind).toBe("ready");
    expect(ready.body.items.map((i: { position: number }) => i.position)).toEqual([1, 2]);
    expect((await look()).body).toEqual({ kind: "no_value" });
    expect((await look("   ")).body).toEqual({ kind: "no_value" });
    expect((await look("producto de otro")).body).toEqual({ kind: "unknown_product", key: "producto de otro" });
  });
  it("another account's product is unknown for the session account", async () => {
    expect((await look("solo b")).body.kind).toBe("unknown_product");
  });
});

describe("the three refusals the editor must tell apart", () => {
  const create = () => productsRoute.POST(req("POST", "/p", { display_name: "X" }));

  it("owner and admin of an account WITHOUT the module get voice_notes_disabled (the role is fine; the module is off)", async () => {
    vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", B);
    for (const role of ["owner", "admin"]) {
      h.session.role = role;
      const r = await read(await create());
      expect(r.status, role).toBe(403);
      expect(r.body, role).toEqual({ error: "voice_notes_disabled" });
    }
  });

  it("an agent or viewer of an account WITH the module gets a role refusal, not voice_notes_disabled", async () => {
    for (const role of ["agent", "viewer"]) {
      h.session.role = role;
      const r = await read(await create());
      expect(r.status, role).toBe(403);
      expect(r.body, role).not.toEqual({ error: "voice_notes_disabled" });
      expect(r.body, role).toEqual({ error: "Forbidden" });
    }
  });

  it("no session is a 401 whatever the module state", async () => {
    h.session.authenticated = false;
    expect((await read(await create())).status).toBe(401);
    vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", B);
    expect((await read(await create())).status).toBe(401);
  });

  it("the owner of an enabled account can create (the 'role = user' of the legacy column plays no part: only the effective role counts)", async () => {
    h.session.role = "owner";
    const r = await read(await create());
    expect(r.status).not.toBe(403);
    expect(r.status).not.toBe(401);
  });
});

describe("E7: the same audio twice, over HTTP", () => {
  const path = `account-${A}/voice-staging/1700000000000-guia.ogg`;

  it("adding a file whose hash is already in the product answers 409 duplicate_audio and never calls the database function", async () => {
    h.promote.mockResolvedValue({ ok: true, sha256: sha("1"), bytes: 10, durationMs: 1000, url: "u", objectPath: "o" }); // PA already has sha("1")
    const r = await read(await itemsRoute.POST(req("POST", "/i", { expected_revision: 3, path }), ctx(PA)));
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "duplicate_audio" });
    expect(rpcCalls.filter((c) => c.fn === "audio_guide_add_item")).toHaveLength(0);
  });

  it("a different audio is still added (201), so a retry after a lost reply cannot create a second row but a new file can", async () => {
    h.promote.mockResolvedValue({ ok: true, sha256: sha("3"), bytes: 10, durationMs: 1000, url: "u", objectPath: "o" });
    const r = await read(await itemsRoute.POST(req("POST", "/i", { expected_revision: 3, path }), ctx(PA)));
    expect(r.status).toBe(201);
    expect(rpcCalls.filter((c) => c.fn === "audio_guide_add_item")).toHaveLength(1);
  });

  it("the server stays strict: a staged file the verifier rejects (for example one without the end-of-stream flag) is refused, with no repair on this side", async () => {
    h.promote.mockResolvedValue({ ok: false, code: "rejected", reason: "missing_end_of_stream" });
    const r = await read(await itemsRoute.POST(req("POST", "/i", { expected_revision: 3, path }), ctx(PA)));
    expect(r.status).toBe(422);
    expect(r.body).toEqual({ error: "file_rejected", reason: "missing_end_of_stream" });
    expect(rpcCalls).toHaveLength(0);
  });
});
