import { beforeEach, describe, expect, it, vi } from "vitest";

// F2-A: purposes, identifiers and the classification of an audio (migration 076) over HTTP. The auth layer and the service client are replaced;
// routes, validators and services are real, running over the in-memory database whose 076 functions are a JS model that is checked against the
// parameter names of the REAL migration (audio-selection-model.ts). The SQL itself is proved by qa/audio-guide/db-selection.sql.

const h = vi.hoisted(() => ({ session: { accountId: "", role: "admin" as string, authenticated: true }, db: null as unknown }));

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

import { createMemoryDb, type Row } from "@/lib/flows/test-support/memory-db";
import { createClock } from "@/lib/flows/test-support/audio-guide-model";
import { audioSelectionRpc, migrationSignatures } from "@/lib/flows/test-support/audio-selection-model";
import * as purposesRoute from "./purposes/route";
import * as purposeRoute from "./purposes/[id]/route";
import * as identifiersRoute from "./identifiers/route";
import * as identifierRoute from "./identifiers/[id]/route";
import * as classificationRoute from "./products/[id]/items/[itemId]/classification/route";
import * as productRoute from "./products/[id]/route";

const A = "a0a0a0a0-1111-4222-8333-444455556666";
const B = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const PA = "a1111111-1111-4111-8111-111111111111";
const PA2 = "a1111111-1111-4111-8111-222222222222";
const PB = "b2222222-2222-4222-8222-222222222222";
const IA1 = "a3333333-3333-4333-8333-333333333333";
const IA2 = "a4444444-4444-4444-8444-444444444444";
const IA3 = "a4444444-4444-4444-8444-555555555555"; // belongs to PA2
const IB1 = "b5555555-5555-4555-8555-555555555555";
const ORIGIN = "https://supabase.example.test";
const sha = (c: string) => c.repeat(64);
const NIL = "00000000-0000-4000-8000-000000000000";

let mem: ReturnType<typeof createMemoryDb>;
const rpcFns = () => mem.rpcCalls.map((c) => c.fn);

function database() {
  const product = (id: string, account: string, key: string, name: string): Row => ({ id, account_id: account, product_key: key, display_name: name, active: true, revision: 3, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
  const item = (id: string, pid: string, account: string, position: number, c: string, status = "active"): Row => ({ id, product_id: pid, account_id: account, position, voice_sha256: sha(c), bytes: 1000, duration_ms: 5000, label: null, pre_delay_seconds: 5, status, purpose_id: null, identifier_id: null });
  const clock = createClock();
  mem = createMemoryDb({
    audio_guide_products: [product(PA, A, "combo xtd", "Combo XTD"), product(PA2, A, "otro", "Otro"), product(PB, B, "solo b", "Solo B")],
    audio_guide_items: [item(IA1, PA, A, 1, "1"), item(IA2, PA, A, 2, "2", "disabled"), item(IA3, PA2, A, 1, "3"), item(IB1, PB, B, 1, "9")],
  }, { rpc: audioSelectionRpc((name) => mem.table(name), clock) });
  h.db = mem.client;
}

const req = (method: string, url: string, body?: unknown) => new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id: string, itemId = "") => ({ params: Promise.resolve({ id, itemId }) });
const read = async (res: Response) => ({ status: res.status, body: await res.json().catch(() => null), cache: res.headers.get("Cache-Control") });
const create = async (kind: "purposes" | "identifiers", name: string) => {
  const route = kind === "purposes" ? purposesRoute : identifiersRoute;
  const r = await read(await route.POST(req("POST", `/${kind}`, { name })));
  return { ...r, id: (r.body?.purpose?.id ?? r.body?.identifier?.id) as string };
};
const classify = async (item: string, body: unknown, product = PA) => read(await classificationRoute.PUT(req("PUT", "/c", body), ctx(product, item)));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", ORIGIN);
  vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", A);
  h.session = { accountId: A, role: "admin", authenticated: true };
  database();
});

describe("the contract with migration 076", () => {
  it("the model checks the real parameter names: seven functions, with the defaults the migration declares", () => {
    const s = migrationSignatures();
    expect(Object.keys(s).sort()).toEqual(["audio_guide_classify_item", "audio_guide_delete_identifier", "audio_guide_delete_purpose", "audio_guide_open_selected_request", "audio_guide_record_selected_skip", "audio_guide_save_identifier", "audio_guide_save_purpose"]);
    expect(Object.keys(s.audio_guide_classify_item)).toEqual(["p_account", "p_item", "p_expected", "p_purpose", "p_identifier"]);
    expect(s.audio_guide_open_selected_request.p_node_key).toBe(true); // DEFAULT NULL
    expect(s.audio_guide_open_selected_request.p_trigger).toBe(false);
    expect(s.audio_guide_save_purpose.p_name).toBe(true);
  });
  it("the routes call the functions with exactly those parameters (a wrong name would throw in the model)", async () => {
    const p = await create("purposes", "Pago"), i = await create("identifiers", "Principal");
    expect(p.status).toBe(201); expect(i.status).toBe(201);
    expect((await classify(IA1, { expected_revision: 3, purpose_id: p.id, identifier_id: i.id })).status).toBe(200);
    expect((await read(await purposeRoute.PATCH(req("PATCH", "/p", { active: false }), ctx(p.id)))).status).toBe(200);
    expect((await read(await identifierRoute.DELETE(req("DELETE", "/i"), ctx(i.id)))).status).toBe(409);
    expect(new Set(rpcFns())).toEqual(new Set(["audio_guide_save_purpose", "audio_guide_save_identifier", "audio_guide_classify_item", "audio_guide_delete_identifier"]));
  });
});

describe("who may call", () => {
  const writes: Array<[string, () => Promise<Response>]> = [
    ["POST purposes", () => purposesRoute.POST(req("POST", "/p", { name: "X" }))],
    ["PATCH purpose", () => purposeRoute.PATCH(req("PATCH", "/p", { active: false }), ctx(NIL))],
    ["DELETE purpose", () => purposeRoute.DELETE(req("DELETE", "/p"), ctx(NIL))],
    ["POST identifiers", () => identifiersRoute.POST(req("POST", "/i", { name: "X" }))],
    ["PATCH identifier", () => identifierRoute.PATCH(req("PATCH", "/i", { active: false }), ctx(NIL))],
    ["DELETE identifier", () => identifierRoute.DELETE(req("DELETE", "/i"), ctx(NIL))],
    ["PUT classification", () => classificationRoute.PUT(req("PUT", "/c", { expected_revision: 3, purpose_id: null, identifier_id: null }), ctx(PA, IA1))],
  ];
  const reads: Array<[string, () => Promise<Response>]> = [
    ["GET purposes", () => purposesRoute.GET()],
    ["GET identifiers", () => identifiersRoute.GET()],
  ];
  it.each([...writes, ...reads])("%s is closed while voice notes are not enabled for the account", async (_n, call) => {
    vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", B);
    const r = await read(await call());
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "voice_notes_disabled" });
    expect(mem.rpcCalls).toHaveLength(0);
  });
  it.each([...writes, ...reads])("%s needs a session (401)", async (_n, call) => {
    h.session.authenticated = false;
    expect((await read(await call())).status).toBe(401);
  });
  it.each(writes)("%s needs the admin role: viewer and agent get 403 and nothing reaches the database", async (_n, call) => {
    for (const role of ["viewer", "agent"]) { h.session.role = role; expect((await read(await call())).status).toBe(403); }
    expect(mem.rpcCalls).toHaveLength(0);
  });
  it.each(reads)("%s is open to every member, including a viewer", async (_n, call) => {
    for (const role of ["viewer", "agent", "admin", "owner"]) { h.session.role = role; expect((await read(await call())).status).toBe(200); }
  });
  it("answers are never cacheable", async () => {
    expect((await read(await purposesRoute.GET())).cache).toContain("no-store");
    expect((await create("purposes", "Pago")).cache).toContain("no-store");
  });
});

describe("purposes and identifiers: create, rename, activate, delete", () => {
  it.each(["purposes", "identifiers"] as const)("%s: creates with a tidy display name, lists them by name, and refuses the same normalised name (case, accents, spacing)", async (kind) => {
    const first = await create(kind, "  Pago   Contra   Entrega ");
    expect(first.status).toBe(201);
    const dto = first.body[kind === "purposes" ? "purpose" : "identifier"];
    expect(dto).toMatchObject({ name: "Pago Contra Entrega", active: true, in_use: 0 });
    for (const dup of ["pago contra entrega", "PAGO CONTRA ENTREGA", "Pagó  contra  entregá", "pago\tcontra\nentrega"]) expect((await create(kind, dup)).status, dup).toBe(409);
    expect((await create(kind, "Provincia")).status).toBe(201);
    const route = kind === "purposes" ? purposesRoute : identifiersRoute;
    const list = await read(await route.GET());
    expect(list.body[kind].map((n: { name: string }) => n.name)).toEqual(["Pago Contra Entrega", "Provincia"]);
  });
  it("409 duplicate_name names the reason; names over 60 characters, empty or not text are 422, and the id of the account is never read from the body", async () => {
    await create("purposes", "Pago");
    expect((await read(await purposesRoute.POST(req("POST", "/p", { name: "pago" })))).body).toEqual({ error: "duplicate_name" });
    expect((await create("purposes", "x".repeat(61))).status).toBe(422);
    expect((await create("purposes", "x".repeat(60))).status).toBe(201);
    expect((await create("purposes", "   ")).status).toBe(422);
    expect((await read(await purposesRoute.POST(req("POST", "/p", { name: 5 })))).body).toMatchObject({ error: "name_required", field: "name" });
    expect((await read(await purposesRoute.POST(req("POST", "/p", { name: "Con cuenta", account_id: B })))).status).toBe(201);
    expect(mem.table("audio_guide_purposes").find((r) => r.name === "Con cuenta")?.account_id).toBe(A);
    expect((await read(await purposesRoute.POST(req("POST", "/p", "no json")))).status).toBe(422);
  });
  it("renames (a change of case or accents only is the SAME key and is allowed), refuses another existing name, and deactivates and reactivates", async () => {
    const a = await create("purposes", "pago"), b = await create("purposes", "Provincia");
    const rename = async (id: string, name: string) => read(await purposeRoute.PATCH(req("PATCH", "/p", { name }), ctx(id)));
    expect((await rename(a.id, "Pago")).body.purpose.name).toBe("Pago");
    expect((await rename(a.id, "PROVINCIA")).status).toBe(409);
    expect((await rename(b.id, "Provincia Lima")).status).toBe(200);
    const off = await read(await purposeRoute.PATCH(req("PATCH", "/p", { active: false }), ctx(a.id)));
    expect(off.body.purpose.active).toBe(false);
    expect((await read(await purposeRoute.PATCH(req("PATCH", "/p", { active: true }), ctx(a.id)))).body.purpose.active).toBe(true);
    expect((await read(await purposeRoute.PATCH(req("PATCH", "/p", {}), ctx(a.id)))).body).toMatchObject({ error: "nothing_to_change" });
    expect((await read(await purposeRoute.PATCH(req("PATCH", "/p", { active: "yes" }), ctx(a.id)))).status).toBe(422);
  });
  it("limits: 50 purposes and 100 identifiers per account, then 422 limit_reached; another account is unaffected", async () => {
    const seed = (table: string, n: number, account: string) => { for (let k = 0; k < n; k++) mem.table(table).push({ id: `s-${table}-${account}-${k}`, account_id: account, name: `n${k}`, name_key: `n${k}`, active: true }); };
    seed("audio_guide_purposes", 50, A); seed("audio_guide_identifiers", 100, A);
    expect((await read(await purposesRoute.POST(req("POST", "/p", { name: "Uno mas" })))).body).toEqual({ error: "limit_reached" });
    expect((await read(await identifiersRoute.POST(req("POST", "/i", { name: "Uno mas" })))).status).toBe(422);
    h.session.accountId = B; vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", `${A},${B}`);
    expect((await create("purposes", "Uno mas")).status).toBe(201);
  });
  it("deletes one nobody uses; refuses one an audio uses (409 in_use) and deactivating keeps working; a malformed id is a plain 404", async () => {
    const p = await create("purposes", "Pago"), i = await create("identifiers", "Principal");
    expect((await classify(IA1, { expected_revision: 3, purpose_id: p.id, identifier_id: i.id })).status).toBe(200);
    const used = await read(await purposesRoute.GET());
    expect(used.body.purposes[0]).toMatchObject({ name: "Pago", in_use: 1 });
    expect((await read(await purposeRoute.DELETE(req("DELETE", "/p"), ctx(p.id)))).body).toEqual({ error: "in_use" });
    expect((await read(await purposeRoute.PATCH(req("PATCH", "/p", { active: false }), ctx(p.id)))).status).toBe(200);
    const spare = await create("purposes", "Sobrante");
    expect((await read(await purposeRoute.DELETE(req("DELETE", "/p"), ctx(spare.id)))).status).toBe(200);
    expect(mem.table("audio_guide_purposes").some((r) => r.id === spare.id)).toBe(false);
    expect((await read(await purposeRoute.DELETE(req("DELETE", "/p"), ctx("not-a-uuid")))).status).toBe(404);
    expect((await read(await purposeRoute.DELETE(req("DELETE", "/p"), ctx(NIL)))).status).toBe(404);
  });
});

describe("isolation between accounts", () => {
  it("the same names can exist in two accounts; each sees only its own; another account's id is simply not_found", async () => {
    const mine = await create("purposes", "Pago");
    h.session.accountId = B; vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", `${A},${B}`);
    expect((await create("purposes", "Pago")).status).toBe(201);
    expect((await read(await purposesRoute.GET())).body.purposes).toHaveLength(1);
    for (const call of [
      () => purposeRoute.PATCH(req("PATCH", "/p", { name: "Hack" }), ctx(mine.id)),
      () => purposeRoute.PATCH(req("PATCH", "/p", { active: false }), ctx(mine.id)),
      () => purposeRoute.DELETE(req("DELETE", "/p"), ctx(mine.id)),
    ]) expect((await read(await call())).status).toBe(404);
    expect(mem.table("audio_guide_purposes").find((r) => r.id === mine.id)).toMatchObject({ name: "Pago", active: true, account_id: A });
  });
  it("an audio cannot be classified with another account's purpose or identifier, nor an audio of another account touched", async () => {
    const mineP = await create("purposes", "Pago"), mineI = await create("identifiers", "Principal");
    h.session.accountId = B; vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", `${A},${B}`);
    const theirI = await create("identifiers", "Principal");
    const cross = await classify(IB1, { expected_revision: 3, purpose_id: mineP.id, identifier_id: theirI.id }, PB);
    expect(cross.body).toEqual({ error: "purpose_not_found" });
    expect((await classify(IB1, { expected_revision: 3, purpose_id: mineP.id, identifier_id: mineI.id }, PB)).status).toBe(422);
    expect((await classify(IA1, { expected_revision: 3, purpose_id: null, identifier_id: null }, PA)).status).toBe(404); // A's audio, B's session
    expect(mem.table("audio_guide_items").find((i) => i.id === IB1)).toMatchObject({ purpose_id: null, identifier_id: null });
  });
});

describe("classifying an audio", () => {
  let pay: string, prov: string, main: string, alt: string;
  beforeEach(async () => {
    pay = (await create("purposes", "Pago")).id; prov = (await create("purposes", "Provincia")).id;
    main = (await create("identifiers", "Principal")).id; alt = (await create("identifiers", "Alternativo")).id;
  });
  const items = async () => (await read(await productRoute.GET(req("GET", "/p"), ctx(PA)))).body.product.items as Array<{ id: string; purpose_id: string | null; identifier_id: string | null; sha256: string }>;

  it("every audio starts unclassified (null, null); classifying returns the refreshed product and never touches the file", async () => {
    const before = await items();
    expect(before.every((i) => i.purpose_id === null && i.identifier_id === null)).toBe(true);
    const r = await classify(IA1, { expected_revision: 3, purpose_id: pay, identifier_id: main });
    expect(r.status).toBe(200);
    const after = r.body.product.items;
    expect(after.find((i: { id: string }) => i.id === IA1)).toMatchObject({ purpose_id: pay, identifier_id: main, sha256: sha("1") });
    expect(after.find((i: { id: string }) => i.id === IA2)).toMatchObject({ purpose_id: null, identifier_id: null }); // nothing else changed
    expect(r.body.product.revision).toBe(4);
  });
  it("both ids or neither: one alone, names, bad ids and a missing revision are 422 and reach no database function", async () => {
    const bad: Array<[unknown, string]> = [
      [{ expected_revision: 3, purpose_id: pay, identifier_id: null }, "both_or_neither"],
      [{ expected_revision: 3, purpose_id: null, identifier_id: main }, "both_or_neither"],
      [{ expected_revision: 3, purpose_id: pay }, "both_ids_required"],
      [{ expected_revision: 3, purpose: "Pago", identifier: "Principal", purpose_id: null, identifier_id: null }, "reference_by_id_only"],
      [{ expected_revision: 3, purpose_id: "Pago", identifier_id: main }, "invalid_id"],
      [{ purpose_id: pay, identifier_id: main }, "expected_revision_required"],
      ["nope", "invalid_body"],
    ];
    for (const [body, error] of bad) { const r = await classify(IA1, body); expect(r.status, JSON.stringify(body)).toBe(422); expect(r.body.error).toBe(error); }
    expect(rpcFns().filter((f) => f === "audio_guide_classify_item")).toHaveLength(0);
  });
  it("the same pair twice in one product is 409 duplicate_classification with the conflicting audio; a DISABLED audio still reserves its pair", async () => {
    expect((await classify(IA2, { expected_revision: 3, purpose_id: pay, identifier_id: main })).status).toBe(200); // IA2 is disabled
    const clash = await classify(IA1, { expected_revision: 4, purpose_id: pay, identifier_id: main });
    expect(clash.status).toBe(409);
    expect(clash.body).toEqual({ error: "duplicate_classification", conflict_item: IA2 });
    expect((await classify(IA1, { expected_revision: 4, purpose_id: pay, identifier_id: alt })).status).toBe(200); // another identifier: fine
    expect((await classify(IA3, { expected_revision: 3, purpose_id: pay, identifier_id: main }, PA2)).status).toBe(200); // another product: fine
  });
  it("an inactive or unknown purpose / identifier cannot be newly assigned (409 inactive, 422 unknown); the audio keeps its previous classification", async () => {
    expect((await classify(IA1, { expected_revision: 3, purpose_id: pay, identifier_id: main })).status).toBe(200);
    await purposeRoute.PATCH(req("PATCH", "/p", { active: false }), ctx(prov));
    await identifierRoute.PATCH(req("PATCH", "/i", { active: false }), ctx(alt));
    expect((await classify(IA1, { expected_revision: 4, purpose_id: prov, identifier_id: main })).body).toEqual({ error: "purpose_inactive" });
    expect((await classify(IA1, { expected_revision: 4, purpose_id: pay, identifier_id: alt })).body).toEqual({ error: "identifier_inactive" });
    expect((await classify(IA1, { expected_revision: 4, purpose_id: NIL, identifier_id: main })).body).toEqual({ error: "purpose_not_found" });
    expect((await classify(IA1, { expected_revision: 4, purpose_id: pay, identifier_id: NIL })).body).toEqual({ error: "identifier_not_found" });
    expect((await items()).find((i) => i.id === IA1)).toMatchObject({ purpose_id: pay, identifier_id: main });
    // deactivating a value already in use keeps the audio classified and the value readable
    await purposeRoute.PATCH(req("PATCH", "/p", { active: false }), ctx(pay));
    expect((await items()).find((i) => i.id === IA1)).toMatchObject({ purpose_id: pay, identifier_id: main });
  });
  it("clears the classification with null, null (and that works even when the old values are now inactive)", async () => {
    await classify(IA1, { expected_revision: 3, purpose_id: pay, identifier_id: main });
    await purposeRoute.PATCH(req("PATCH", "/p", { active: false }), ctx(pay));
    const r = await classify(IA1, { expected_revision: 4, purpose_id: null, identifier_id: null });
    expect(r.status).toBe(200);
    expect(r.body.product.items.find((i: { id: string }) => i.id === IA1)).toMatchObject({ purpose_id: null, identifier_id: null });
  });
  it("optimistic concurrency: two editors with the same revision, the second gets 409 revision_conflict with the current revision", async () => {
    expect((await classify(IA1, { expected_revision: 3, purpose_id: pay, identifier_id: main })).status).toBe(200);
    const stale = await classify(IA3, { expected_revision: 3, purpose_id: prov, identifier_id: alt }, PA2);
    expect(stale.status).toBe(200); // another product has its own revision
    const sameProduct = await classify(IA2, { expected_revision: 3, purpose_id: prov, identifier_id: alt });
    expect(sameProduct.status).toBe(409);
    expect(sameProduct.body).toEqual({ error: "revision_conflict", revision: 4 });
    expect((await items()).find((i) => i.id === IA2)).toMatchObject({ purpose_id: null });
  });
  it("the audio must belong to the product of the path: a mismatch or a malformed id is 404", async () => {
    expect((await classify(IA3, { expected_revision: 3, purpose_id: pay, identifier_id: main }, PA)).status).toBe(404);
    expect((await read(await classificationRoute.PUT(req("PUT", "/c", {}), ctx("nope", IA1)))).status).toBe(404);
    expect(rpcFns().filter((f) => f === "audio_guide_classify_item")).toHaveLength(0);
  });
});
