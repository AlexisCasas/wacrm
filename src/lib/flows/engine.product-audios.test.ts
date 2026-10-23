import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================
// Runner-level coverage of the `send_product_audios` node: the REAL dispatchInboundToFlows + advance loop + node executor + sequencer +
// engineSendMedia, over an in-memory database (whose sequencer functions are a JS model of migration 075) and a simulated Meta. Timers are
// fake, so the 5-second pauses are real in the test's timeline without waiting. qa/audio-guide runs the same flow against real PostgreSQL.
// ============================================================

const h = vi.hoisted(() => ({
  db: null as unknown,
  transport: "meta" as "meta" | "manychat",
  sendMediaMessage: vi.fn(),
  sendTextMessage: vi.fn(),
}));

vi.mock("./admin-client", () => ({ supabaseAdmin: () => h.db }));
vi.mock("@/lib/whatsapp/send-message", () => ({ resolveOutboundTransport: () => h.transport }));
vi.mock("@/lib/whatsapp/encryption", () => ({ decrypt: (v: string) => v }));
vi.mock("@/lib/whatsapp/meta-api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendMediaMessage: (...a: unknown[]) => h.sendMediaMessage(...a),
  sendTextMessage: (...a: unknown[]) => h.sendTextMessage(...a),
}));

import { MetaApiError } from "@/lib/whatsapp/meta-api";
import { resumeAudioRequests, type SequencerDb } from "@/lib/audio-guide/sequencer";
import { sendVoiceNoteViaEngine } from "@/lib/audio-guide/sender";
import { dispatchInboundToFlows } from "./engine";
import { createMemoryDb, type Row } from "./test-support/memory-db";
import { audioGuideRpc } from "./test-support/audio-guide-model";
import { audioSelectionRpc } from "./test-support/audio-selection-model";

const A = "046ff8c2-1111-4222-8333-444455556666";
const B = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const TAG = "11111111-1111-4111-8111-111111111111";
const TAG_B = "22222222-2222-4222-8222-222222222222";
const FIELD = "33333333-3333-4333-8333-333333333333";
const ORIGIN = "https://supabase.example.test";
const sha = (c: string) => c.repeat(64);
const url = (c: string) => `${ORIGIN}/storage/v1/object/public/voice-notes/account-${A}/${sha(c)}.ogg`;

const FLOW: Row = { id: "flow-1", account_id: A, user_id: "u-1", status: "active", trigger_type: "keyword", trigger_config: { keywords: ["provincia"] }, entry_node_id: "start", created_at: "2026-01-01T00:00:00Z" };
const NODE_CFG = { gate_tag_id: TAG, product_field_id: "", next_node_key: "ok", unknown_node_key: "unk", no_audios_node_key: "noa", gate_closed_node_key: "gate" };
const graph = (cfg: Row = NODE_CFG): Row[] => [
  { flow_id: "flow-1", node_key: "start", node_type: "start", config: { next_node_key: "vp" } },
  { flow_id: "flow-1", node_key: "vp", node_type: "send_product_audios", config: cfg },
  ...["ok", "unk", "noa", "gate"].map((k) => ({ flow_id: "flow-1", node_key: k, node_type: "end", config: {} })),
];
const items = (pauses: number[], product = "p-xtd", account = A): Row[] => pauses.map((p, i) => ({ id: `${product}-i${i + 1}`, account_id: account, product_id: product, position: i + 1, voice_sha256: sha(String(i + 1)), status: "active", pre_delay_seconds: p }));

function setup(over: { nodes?: Row[]; items?: Row[]; products?: Row[]; tagged?: boolean; value?: string | null; fields?: Row[]; contact?: Row; extra?: Record<string, Row[]> } = {}) {
  const clock = { now: () => Date.now(), advance: () => {} };
  const mem: ReturnType<typeof createMemoryDb> = createMemoryDb({
    flows: [FLOW], flow_nodes: over.nodes ?? graph(),
    contacts: [{ id: "ct-1", account_id: A, name: "Ana", phone: "+15551234567", blocked: false, ...over.contact }],
    conversations: [{ id: "cv-1", account_id: A, user_id: "u-1" }],
    whatsapp_config: [{ account_id: A, phone_number_id: "pn-1", access_token: "token" }],
    tags: [{ id: TAG, account_id: A }, { id: TAG_B, account_id: B }],
    contact_tags: over.tagged === false ? [] : [{ contact_id: "ct-1", tag_id: TAG }],
    custom_fields: over.fields ?? [{ id: FIELD, account_id: A, field_name: "Producto" }],
    contact_custom_values: over.value === null ? [] : [{ contact_id: "ct-1", custom_field_id: FIELD, value: over.value ?? "Combo XTD" }],
    audio_guide_products: over.products ?? [{ id: "p-xtd", account_id: A, product_key: "combo xtd", display_name: "Combo XTD", active: true, revision: 2 }],
    audio_guide_items: over.items ?? items([5, 5, 5]),
    ...over.extra,
  }, { rpc: { ...audioGuideRpc((n) => mem.table(n), clock), ...audioSelectionRpc((n) => mem.table(n), clock) } });
  h.db = mem.client;
  return mem;
}

const dispatch = (id = "wamid.IN1", text = "provincia") => dispatchInboundToFlows({ accountId: A, userId: "u-1", contactId: "ct-1", conversationId: "cv-1", message: { kind: "text", text, meta_message_id: id }, isFirstInboundMessage: false });
/** Runs a dispatch with fake timers, advancing time until it settles. */
async function run(id?: string, text?: string, seconds = 60) {
  const pending = dispatch(id, text);
  await vi.advanceTimersByTimeAsync(seconds * 1000);
  return pending;
}
const entered = (mem: ReturnType<typeof createMemoryDb>) => mem.table("flow_run_events").filter((e) => e.event_type === "node_entered").map((e) => e.node_key);
const errors = (mem: ReturnType<typeof createMemoryDb>) => mem.table("flow_run_events").filter((e) => e.event_type === "error");
const lastRun = (mem: ReturnType<typeof createMemoryDb>) => mem.table("flow_runs").at(-1)!;
const wire = () => h.sendMediaMessage.mock.calls.map((c) => c[0] as { kind: string; voice?: boolean; link: string; caption?: unknown; filename?: unknown; to: string });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", ORIGIN);
  vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", A);
  h.transport = "meta";
  let n = 0;
  h.sendMediaMessage.mockReset().mockImplementation(async () => ({ messageId: `wamid.OUT${++n}` }));
  h.sendTextMessage.mockReset().mockResolvedValue({ messageId: "wamid.TEXT" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("send_product_audios in the runner: the right audios, as voice notes, in order, with the pause before each", () => {
  it.each([1, 3, 6])("%i audio(s): voice notes with voice=true, no caption or filename, each after 5 s, persisted, request completed, run completed", async (n) => {
    const mem = setup({ items: items(Array(n).fill(5)) });
    const started = Date.now();
    const calls: number[] = [];
    h.sendMediaMessage.mockImplementation(async () => { calls.push(Date.now() - started); return { messageId: `wamid.OUT${calls.length}` }; });
    const result = await run();
    expect(result).toMatchObject({ consumed: true, outcome: "completed" });
    expect(wire().map((w) => w.link)).toEqual(Array.from({ length: n }, (_, i) => url(String(i + 1))));
    expect(wire().every((w) => w.kind === "audio" && w.voice === true && w.caption === undefined && w.filename === undefined && w.to === "15551234567")).toBe(true);
    expect(calls.map((c) => Math.round(c / 1000))).toEqual(Array.from({ length: n }, (_, i) => 5 * (i + 1)));
    expect(mem.table("messages").map((m) => [m.content_type, m.sender_type, m.message_id])).toEqual(Array.from({ length: n }, (_, i) => ["audio", "bot", `wamid.OUT${i + 1}`]));
    const request = mem.table("audio_guide_requests")[0];
    expect(request).toMatchObject({ status: "completed", trigger_message_id: "wamid.IN1", product_key: "combo xtd", flow_run_id: lastRun(mem).id });
    expect(mem.table("audio_guide_sends").map((s) => [s.status, s.whatsapp_message_id])).toEqual(Array.from({ length: n }, (_, i) => ["sent", `wamid.OUT${i + 1}`]));
    expect(lastRun(mem)).toMatchObject({ status: "completed" });
    expect(entered(mem)).toEqual(["start", "vp", "ok"]);
    expect(mem.table("flow_run_events").find((e) => e.event_type === "message_sent")).toMatchObject({ node_key: "vp", payload: { node_type: "send_product_audios", route: "next", sent: n } });
    expect(errors(mem)).toHaveLength(0);
  });

  it("picks the audio of the contact's product, not another's, whatever the case, accents or spacing of the Producto value", async () => {
    for (const value of ["combo xtd", "COMBO XTD", " Cómbo   XTD "]) {
      h.sendMediaMessage.mockClear();
      const mem = setup({
        value,
        products: [{ id: "p-xtd", account_id: A, product_key: "combo xtd", active: true, revision: 1 }, { id: "p-other", account_id: A, product_key: "taladro", active: true, revision: 1 }],
        items: [...items([5], "p-xtd"), { id: "o1", account_id: A, product_id: "p-other", position: 1, voice_sha256: sha("9"), status: "active", pre_delay_seconds: 5 }],
      });
      await run();
      expect(wire().map((w) => w.link)).toEqual([url("1")]);
      expect(mem.table("audio_guide_requests")[0].product_key).toBe("combo xtd");
    }
  });

  it("only ACTIVE audios, in the catalog order, with each audio's own pause", async () => {
    const calls: number[] = []; const started = Date.now();
    h.sendMediaMessage.mockImplementation(async () => { calls.push(Date.now() - started); return { messageId: `wamid.OUT${calls.length}` }; });
    setup({ items: [
      { id: "i1", account_id: A, product_id: "p-xtd", position: 1, voice_sha256: sha("1"), status: "active", pre_delay_seconds: 5 },
      { id: "i2", account_id: A, product_id: "p-xtd", position: 2, voice_sha256: sha("2"), status: "disabled", pre_delay_seconds: 5 },
      { id: "i3", account_id: A, product_id: "p-xtd", position: 3, voice_sha256: sha("3"), status: "active", pre_delay_seconds: 12 },
    ] });
    await run();
    expect(wire().map((w) => w.link)).toEqual([url("1"), url("3")]);
    expect(calls.map((c) => Math.round(c / 1000))).toEqual([5, 17]);
  });
});

describe("send_product_audios: safe routes when there is nothing to send", () => {
  it.each([
    ["no Producto value", { value: null }, "unk", "no_value"],
    ["a blank value", { value: "   " }, "unk", "no_value"],
    ["an unknown product", { value: "Producto inexistente" }, "unk", "unknown_product"],
    ["an inactive product", { products: [{ id: "p-xtd", account_id: A, product_key: "combo xtd", active: false, revision: 1 }] }, "unk", "product_inactive"],
    ["a product without audios", { items: [] }, "noa", "no_audios"],
    ["a product whose audios are all disabled", { items: items([5, 5]).map((i) => ({ ...i, status: "disabled" })) }, "noa", "no_audios"],
  ])("%s: follows the %s route, sends nothing, records why", async (_name, over, route, reason) => {
    const mem = setup(over as never);
    const result = await run();
    expect(result).toMatchObject({ consumed: true, outcome: "completed" });
    expect(entered(mem)).toEqual(["start", "vp", route]);
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
    expect(mem.table("audio_guide_requests")).toHaveLength(1);
    expect(mem.table("audio_guide_requests")[0]).toMatchObject({ status: "skipped", reason });
    expect(mem.table("audio_guide_sends")).toHaveLength(0);
    expect(lastRun(mem)).toMatchObject({ status: "completed" });
  });
});

describe("send_product_audios: the gate", () => {
  it("contact WITHOUT the tag: nothing is sent and the flow follows 'gate closed'", async () => {
    const mem = setup({ tagged: false });
    await run();
    expect(entered(mem)).toEqual(["start", "vp", "gate"]);
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
    expect(mem.table("audio_guide_requests")[0]).toMatchObject({ status: "skipped", reason: "gate_closed" });
  });
  it("contact WITH the tag: the sequence is sent", async () => {
    setup({ tagged: true });
    await run();
    expect(h.sendMediaMessage).toHaveBeenCalledTimes(3);
  });
  it.each([
    ["no gate configured", { ...NODE_CFG, gate_tag_id: "" }, "node_config_invalid"],
    ["a malformed gate", { ...NODE_CFG, gate_tag_id: "not-a-uuid" }, "node_config_invalid"],
    ["a route missing", { ...NODE_CFG, unknown_node_key: "" }, "node_config_invalid"],
    ["another account's tag as the gate", { ...NODE_CFG, gate_tag_id: TAG_B }, "gate_tag_not_in_account"],
  ])("fails SAFE with %s: the run fails, nothing is sent", async (_name, cfg, reason) => {
    const mem = setup({ nodes: graph(cfg) });
    await run();
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
    expect(lastRun(mem)).toMatchObject({ status: "failed", end_reason: reason });
    expect(errors(mem)[0]).toMatchObject({ payload: { reason } });
    expect(mem.table("audio_guide_requests")).toHaveLength(0);
  });
  it("is closed while voice notes are not enabled for the account", async () => {
    vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", B);
    const mem = setup();
    await run();
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
    expect(lastRun(mem)).toMatchObject({ status: "failed", end_reason: "voice_notes_not_enabled" });
  });
});

describe("send_product_audios: the Producto field is never guessed", () => {
  it.each([
    ["no field named Producto", [], "product_field_missing"],
    ["two fields named Producto", [{ id: FIELD, account_id: A, field_name: "Producto" }, { id: "44444444-4444-4444-8444-444444444444", account_id: A, field_name: "  PRODUCTO " }], "product_field_ambiguous"],
    ["only another account's field", [{ id: FIELD, account_id: B, field_name: "Producto" }], "product_field_missing"],
  ])("%s: the run fails and nothing is sent", async (_name, fields, reason) => {
    const mem = setup({ fields: fields as Row[] });
    await run();
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
    expect(lastRun(mem)).toMatchObject({ status: "failed", end_reason: reason });
  });
  it("an explicit field id resolves the ambiguity", async () => {
    const other = "44444444-4444-4444-8444-444444444444";
    setup({ nodes: graph({ ...NODE_CFG, product_field_id: FIELD }), fields: [{ id: FIELD, account_id: A, field_name: "Producto" }, { id: other, account_id: A, field_name: "producto" }] });
    await run();
    expect(h.sendMediaMessage).toHaveBeenCalledTimes(3);
  });
});

describe("send_product_audios: duplicates and concurrency", () => {
  it("the same inbound message delivered again after the run finished sends nothing more", async () => {
    const mem = setup();
    await run("wamid.IN1");
    expect(h.sendMediaMessage).toHaveBeenCalledTimes(3);
    const again = await run("wamid.IN1");
    expect(again).toMatchObject({ consumed: true });
    expect(h.sendMediaMessage).toHaveBeenCalledTimes(3);
    expect(mem.table("audio_guide_requests")).toHaveLength(1);
    expect(mem.table("audio_guide_sends")).toHaveLength(3);
    expect(mem.table("flow_run_events").find((e) => e.event_type === "message_sent" && (e.payload as { duplicate?: boolean }).duplicate)).toBeTruthy();
  });
  it("a different inbound message later gets its own sequence", async () => {
    const mem = setup();
    await run("wamid.IN1"); await run("wamid.IN2");
    expect(h.sendMediaMessage).toHaveBeenCalledTimes(6);
    expect(mem.table("audio_guide_requests").map((r) => r.trigger_message_id)).toEqual(["wamid.IN1", "wamid.IN2"]);
  });
  it("two contacts at the same time each get their own sequence, interleaved but each in order", async () => {
    const mem = setup({ extra: {} });
    mem.table("contacts").push({ id: "ct-2", account_id: A, name: "Luis", phone: "+15557654321", blocked: false });
    mem.table("conversations").push({ id: "cv-2", account_id: A, user_id: "u-1" });
    mem.table("contact_tags").push({ contact_id: "ct-2", tag_id: TAG });
    mem.table("contact_custom_values").push({ contact_id: "ct-2", custom_field_id: FIELD, value: "combo xtd" });
    const one = dispatch("wamid.C1");
    const two = dispatchInboundToFlows({ accountId: A, userId: "u-1", contactId: "ct-2", conversationId: "cv-2", message: { kind: "text", text: "provincia", meta_message_id: "wamid.C2" }, isFirstInboundMessage: false });
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all([one, two]);
    const bySend = mem.table("audio_guide_sends");
    expect(bySend).toHaveLength(6);
    expect(bySend.every((s) => s.status === "sent")).toBe(true);
    expect(mem.table("audio_guide_requests").map((r) => r.status)).toEqual(["completed", "completed"]);
    for (const to of ["15551234567", "15557654321"]) expect(wire().filter((w) => w.to === to).map((w) => w.link)).toEqual([url("1"), url("2"), url("3")]);
  });
});

describe("send_product_audios: failures never look like success", () => {
  it("Meta rejects audio 2: the run FAILS (audio_sequence_incomplete), audio 3 is never sent, the request is partial", async () => {
    let n = 0;
    h.sendMediaMessage.mockImplementation(async () => { n++; if (n === 2) throw new MetaApiError({ message: "Media upload error", code: 131053, httpStatus: 400 }); return { messageId: `wamid.OUT${n}` }; });
    const mem = setup();
    await run();
    expect(h.sendMediaMessage).toHaveBeenCalledTimes(2);
    expect(mem.table("messages")).toHaveLength(1);
    expect(mem.table("audio_guide_sends").map((s) => s.status)).toEqual(["sent", "failed", "skipped"]);
    expect(mem.table("audio_guide_requests")[0].status).toBe("partial");
    expect(lastRun(mem)).toMatchObject({ status: "failed", end_reason: "audio_sequence_incomplete" });
    expect(errors(mem)[0]).toMatchObject({ payload: { reason: "audio_sequence_incomplete", sent: 1, request_status: "partial", why: "meta_131053" } });
    expect(entered(mem)).not.toContain("ok");
  });

  it("Meta accepted audio 1 but the Inbox write failed: no retry, UNCERTAIN, the sequence stops", async () => {
    const mem = setup({ extra: {} });
    // make the Inbox insert of the first voice note fail after Meta accepted it
    const real = (mem.client as unknown as { from: (t: string) => unknown }).from.bind(mem.client);
    (mem.client as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      const q = real(t) as { insert: (...a: unknown[]) => unknown };
      if (t !== "messages") return q;
      return { ...q, insert: () => Promise.resolve({ error: { message: "constraint violation" } }) };
    };
    await run();
    expect(h.sendMediaMessage).toHaveBeenCalledTimes(1);
    expect(mem.table("audio_guide_sends").map((s) => s.status)).toEqual(["uncertain", "skipped", "skipped"]);
    expect(mem.table("audio_guide_sends")[0].error_code).toBe("accepted_not_recorded");
    expect(lastRun(mem)).toMatchObject({ status: "failed", end_reason: "audio_sequence_incomplete" });
  });

  it("the database cannot record the outcome after Meta accepted: the run fails, the next audio is NOT sent, and a later resumer marks it uncertain without resending", async () => {
    const mem = setup();
    const model = audioGuideRpc((n) => mem.table(n), { now: () => Date.now(), advance: () => {} });
    let failing = true;
    const handlers = mem.client as unknown as { rpc: (fn: string, args: Row) => Promise<unknown> };
    const realRpc = handlers.rpc.bind(handlers);
    handlers.rpc = (fn, args) => (fn === "audio_guide_finish_send" && failing ? Promise.resolve({ data: null, error: { message: "db down" } }) : realRpc(fn, args));
    void model;
    await run();
    expect(h.sendMediaMessage).toHaveBeenCalledTimes(1);
    expect(mem.table("audio_guide_sends").map((s) => s.status)).toEqual(["sending", "pending", "pending"]);
    expect(lastRun(mem)).toMatchObject({ status: "failed", end_reason: "audio_sequence_incomplete" });
    failing = false;
    await vi.advanceTimersByTimeAsync(200_000);
    const summary = await resumeAudioRequests({ db: mem.client as unknown as SequencerDb, isEnabled: () => true, depsFor: () => ({ sendVoiceNote: sendVoiceNoteViaEngine }) });
    expect(summary.examined).toBe(1);
    expect(h.sendMediaMessage).toHaveBeenCalledTimes(1);
    expect(mem.table("audio_guide_sends").map((s) => s.status)).toEqual(["uncertain", "skipped", "skipped"]);
  });
});

describe("send_product_audios: people and contacts", () => {
  it("a blocked contact: nothing is sent and the run ends as the block route does", async () => {
    const mem = setup({ contact: { blocked: true } });
    await run();
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
    expect(lastRun(mem)).toMatchObject({ status: "paused_by_agent", end_reason: "contact_blocked" });
    expect(mem.table("audio_guide_requests")[0]).toMatchObject({ status: "failed", reason: "contact_blocked" });
  });

  it("a human agent steps in during the sequence: the rest is skipped and the run keeps the status the agent's action gave it", async () => {
    const mem = setup();
    let n = 0;
    h.sendMediaMessage.mockImplementation(async () => {
      n++;
      if (n === 1) { lastRun(mem).status = "paused_by_agent"; mem.table("messages").push({ id: "agent-1", conversation_id: "cv-1", sender_type: "agent", created_at: new Date().toISOString() }); }
      return { messageId: `wamid.OUT${n}` };
    });
    await run();
    expect(h.sendMediaMessage).toHaveBeenCalledTimes(1);
    expect(mem.table("audio_guide_sends").map((s) => [s.status, s.error_code])).toEqual([["sent", null], ["skipped", "run_not_active"], ["skipped", "run_not_active"]]);
    expect(lastRun(mem).status).toBe("paused_by_agent");
    expect(mem.table("audio_guide_requests")[0].status).toBe("partial");
  });

  it("a contact who already has a commercial flow running: the message goes to THAT run and the audio flow does not start", async () => {
    const mem = setup({ extra: {
      flows: [FLOW, { id: "flow-commercial", account_id: A, user_id: "u-1", status: "active", trigger_type: "keyword", trigger_config: { keywords: ["hola"] }, entry_node_id: "q", created_at: "2025-01-01T00:00:00Z" }],
      flow_runs: [{ id: "run-commercial", flow_id: "flow-commercial", account_id: A, user_id: "u-1", contact_id: "ct-1", conversation_id: "cv-1", status: "active", current_node_key: "ask", vars: {}, reprompt_count: 0, started_at: "2026-10-18T11:59:00Z" }],
      flow_nodes: [...graph(), { flow_id: "flow-commercial", node_key: "ask", node_type: "collect_input", config: { prompt_text: "¿Ciudad?", var_key: "ciudad", next_node_key: "fin" } }, { flow_id: "flow-commercial", node_key: "fin", node_type: "end", config: {} }],
    } });
    await run("wamid.IN9", "provincia");
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
    expect(mem.table("audio_guide_requests")).toHaveLength(0);
    expect(mem.table("flow_runs").find((r) => r.id === "run-commercial")).toMatchObject({ vars: { ciudad: "provincia" } }); // captured by the active run, exactly as before
    expect(mem.table("flow_runs").filter((r) => r.flow_id === "flow-1")).toHaveLength(0);
  });
});

describe("send_product_audios: accounts are isolated", () => {
  it("a product, audios and Producto value that exist only in another account are not used", async () => {
    const mem = setup({
      products: [{ id: "p-b", account_id: B, product_key: "combo xtd", active: true, revision: 1 }],
      items: items([5, 5], "p-b", B),
    });
    await run();
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
    expect(entered(mem)).toEqual(["start", "vp", "unk"]);
    expect(mem.table("audio_guide_requests")[0]).toMatchObject({ account_id: A, status: "skipped", reason: "unknown_product" });
  });
  it("a manual start (no inbound message) keys the request on the run", async () => {
    const mem = setup();
    mem.table("audio_guide_requests");
    const run1 = { id: "run-manual", account_id: A, user_id: "u-1", contact_id: "ct-1", conversation_id: "cv-1", flow_id: "flow-1", status: "active" } as never;
    mem.table("flow_runs").push(run1 as Row);
    const { executeSendProductAudios } = await import("./product-audios");
    const pending = executeSendProductAudios({ db: mem.client as never, run: run1, nodeKey: "vp", config: NODE_CFG });
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await pending).kind).toBe("next");
    expect(mem.table("audio_guide_requests")[0].trigger_message_id).toBe("run:run-manual");
  });
});

// ============================================================
// Optional tag and manual product (the node's two explicit choices). A node saved BEFORE them has neither field and must behave exactly
// as it always did; new choices are written explicitly.
// ============================================================
describe("send_product_audios: optional tag and manual product, in the runner", () => {
  const PX = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // catalog product ids are uuids
  const PB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const PNONE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const XTD: Row = { id: PX, account_id: A, product_key: "combo xtd", display_name: "Combo XTD", active: true, revision: 1 };
  const P_B: Row = { id: PB, account_id: B, product_key: "combo xtd", display_name: "Combo de B", active: true, revision: 1 };
  const sentLinks = () => wire().map((w) => w.link);
  const noTagCfg = (over: Row = {}): Row => ({ gate_mode: "none", gate_tag_id: "", product_source: "auto", product_field_id: "", product_id: "", next_node_key: "ok", unknown_node_key: "unk", no_audios_node_key: "noa", gate_closed_node_key: "", ...over });

  describe("a node saved before the options existed", () => {
    it("still requires its tag: an untagged contact is stopped at 'gate closed' and nothing is sent", async () => {
      const mem = setup({ tagged: false }); // graph() uses the legacy config: no gate_mode, no product_source
      await run();
      expect(sentLinks()).toEqual([]);
      expect(entered(mem)).toEqual(["start", "vp", "gate"]);
    });
    it("a tagged contact gets the audios of the product in its Producto field, exactly as before", async () => {
      const mem = setup();
      await run();
      expect(sentLinks()).toEqual([url("1"), url("2"), url("3")]);
      expect(entered(mem)).toEqual(["start", "vp", "ok"]);
    });
    it("an explicit 'tag required' behaves the same as the legacy node", async () => {
      const mem = setup({ tagged: false, nodes: graph({ ...NODE_CFG, gate_mode: "required", product_source: "auto" }) });
      await run();
      expect(sentLinks()).toEqual([]);
      expect(entered(mem)).toEqual(["start", "vp", "gate"]);
    });
  });

  describe("no extra tag", () => {
    it("sends to a contact that has no tag at all, reading the product from the contact", async () => {
      const mem = setup({ tagged: false, nodes: graph(noTagCfg()) });
      await run();
      expect(sentLinks()).toEqual([url("1"), url("2"), url("3")]);
      expect(entered(mem)).toEqual(["start", "vp", "ok"]);
      expect(mem.table("audio_guide_requests")[0]).toMatchObject({ status: "completed", product_key: "combo xtd" });
      expect(mem.table("flow_run_events").find((e) => e.event_type === "message_sent")).toMatchObject({ payload: { route: "next" } });
    });
    it("does not need the tag to exist or the contact to carry any", async () => {
      const mem = setup({ tagged: false, extra: { tags: [] }, nodes: graph(noTagCfg()) });
      await run();
      expect(entered(mem)).toEqual(["start", "vp", "ok"]);
    });
    it("every other safeguard still applies: unknown product, no audios and a blocked contact", async () => {
      let mem = setup({ value: "Producto que no existe", nodes: graph(noTagCfg()) });
      await run();
      expect(entered(mem)).toEqual(["start", "vp", "unk"]);
      mem = setup({ items: [], nodes: graph(noTagCfg()) });
      await run("wamid.IN2");
      expect(entered(mem)).toEqual(["start", "vp", "noa"]);
      h.sendMediaMessage.mockClear();
      mem = setup({ contact: { blocked: true }, nodes: graph(noTagCfg()) });
      await run("wamid.IN3");
      expect(sentLinks()).toEqual([]);
    });
    it("the gate is not consulted for a node without a tag even if a leftover 'gate closed' step is set", async () => {
      const mem = setup({ tagged: false, nodes: graph(noTagCfg({ gate_closed_node_key: "gate" })) });
      await run();
      expect(entered(mem)).toEqual(["start", "vp", "ok"]);
    });
    it("a contradictory node (no tag but a tag still set) fails closed instead of ignoring the tag", async () => {
      const mem = setup({ nodes: graph(noTagCfg({ gate_tag_id: TAG })) });
      await run();
      expect(sentLinks()).toEqual([]);
      expect(errors(mem).map((e) => (e.payload as { reason?: string }).reason)).toContain("node_config_invalid");
    });
  });

  describe("product chosen by hand", () => {
    const manual = (over: Row = {}) => noTagCfg({ product_source: "manual", product_id: PX, ...over });
    const own = { products: [XTD], items: items([5, 5, 5], PX) };

    it("sends the chosen product's audios whatever the contact stores: another product, nothing at all, or no Producto field", async () => {
      for (const [i, value] of (["Taladro Pro", null, "???"] as const).entries()) {
        h.sendMediaMessage.mockClear();
        const mem = setup({ value, ...own, nodes: graph(manual()), ...(i === 1 ? { fields: [] } : {}) });
        await run(`wamid.M${i}`);
        expect(sentLinks(), String(value)).toEqual([url("1"), url("2"), url("3")]);
        expect(entered(mem)).toEqual(["start", "vp", "ok"]);
        expect(mem.table("audio_guide_requests")[0]).toMatchObject({ product_key: "combo xtd", status: "completed" });
      }
    });
    it("a required tag still applies together with a manual product", async () => {
      const mem = setup({ tagged: false, ...own, nodes: graph(manual({ gate_mode: "required", gate_tag_id: TAG, gate_closed_node_key: "gate" })) });
      await run();
      expect(sentLinks()).toEqual([]);
      expect(entered(mem)).toEqual(["start", "vp", "gate"]);
    });
    it("a product that does not exist, belongs to ANOTHER account, or is disabled goes to 'unknown' and sends nothing", async () => {
      const cases: Array<[string, Row]> = [
        ["missing", { product_id: PNONE }],
        ["another account's", { product_id: PB }],
      ];
      for (const [name, over] of cases) {
        h.sendMediaMessage.mockClear();
        const mem = setup({ products: [XTD, P_B], items: [...items([5, 5], PX), ...items([5], PB, B)], nodes: graph(manual(over)) });
        await run(`wamid.U-${name}`);
        expect(sentLinks(), name).toEqual([]);
        expect(entered(mem), name).toEqual(["start", "vp", "unk"]);
      }
      const inactive = setup({ products: [{ ...XTD, active: false }], items: items([5, 5, 5], PX), nodes: graph(manual()) });
      await run("wamid.U-off");
      expect(entered(inactive)).toEqual(["start", "vp", "unk"]);
      expect(sentLinks()).toEqual([]);
    });
    it("a product without active audios goes to 'no audios'", async () => {
      const mem = setup({ products: [XTD], items: [], nodes: graph(manual()) });
      await run();
      expect(entered(mem)).toEqual(["start", "vp", "noa"]);
      expect(sentLinks()).toEqual([]);
    });
    it("a manual node without a product, or mixed with a contact field, fails closed", async () => {
      for (const over of [{ product_id: "" }, { product_field_id: FIELD }]) {
        h.sendMediaMessage.mockClear();
        const mem = setup({ ...own, nodes: graph(manual(over)) });
        await run(`wamid.C${JSON.stringify(over).length}`);
        expect(sentLinks()).toEqual([]);
        expect(errors(mem).map((e) => (e.payload as { reason?: string }).reason)).toContain("node_config_invalid");
      }
    });
    it("keeps the duplicate guard: the same inbound message never sends twice", async () => {
      const mem = setup({ ...own, nodes: graph(manual()) });
      await run("wamid.SAME");
      const first = sentLinks().length;
      await run("wamid.SAME");
      expect(sentLinks()).toHaveLength(first);
      expect(mem.table("audio_guide_requests")).toHaveLength(1);
    });
  });

  describe("automatic product (the default) is unchanged", () => {
    it("matches the contact's value ignoring case, accents and spaces, and uses the named field when one is chosen", async () => {
      const mem = setup({ value: " Cómbo   XTD ", nodes: graph(noTagCfg({ product_field_id: FIELD })) });
      await run();
      expect(sentLinks()).toEqual([url("1"), url("2"), url("3")]);
      expect(entered(mem)).toEqual(["start", "vp", "ok"]);
    });
    it("with no Producto field in the account it still fails closed with a clear reason", async () => {
      const mem = setup({ fields: [], nodes: graph(noTagCfg()) });
      await run();
      expect(sentLinks()).toEqual([]);
      expect(errors(mem).map((e) => (e.payload as { reason?: string }).reason)).toContain("product_field_missing");
    });
  });
});

describe("send_product_audios: a selection this version does not understand fails closed", () => {
  const cfg = (over: Row = {}): Row => ({ gate_mode: "none", gate_tag_id: "", product_source: "auto", product_field_id: "", product_id: "", next_node_key: "ok", unknown_node_key: "unk", no_audios_node_key: "noa", gate_closed_node_key: "", ...over });
  const sentLinks = () => wire().map((w) => w.link);

  it("an unknown mode sends NOTHING (it must never fall back to sending every audio) and takes no route", async () => {
    const mem = setup({ nodes: graph(cfg({ audio_selection: "group", purpose_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", identifier_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })) });
    await run();
    expect(sentLinks()).toEqual([]);
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
    expect(entered(mem)).toEqual(["start", "vp"]);
    expect(errors(mem).map((e) => (e.payload as { reason?: string }).reason)).toContain("node_config_invalid");
    expect(mem.table("audio_guide_requests")).toHaveLength(0);
    expect(mem.table("audio_guide_sends")).toHaveLength(0);
  });

  it("a purpose or identifier alone, 'single' without them, or an unknown mode, fail closed too", async () => {
    for (const [i, over] of ([{ purpose_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, { audio_selection: "single" }, { audio_selection: "single", purpose_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, { audio_selection: "group" }, { audio_selection: 7 }] as Row[]).entries()) {
      h.sendMediaMessage.mockClear();
      const mem = setup({ nodes: graph(cfg(over)) });
      await run(`wamid.F${i}`);
      expect(sentLinks(), JSON.stringify(over)).toEqual([]);
      expect(errors(mem).map((e) => (e.payload as { reason?: string }).reason)).toContain("node_config_invalid");
    }
  });

  it("the original 'all' behaviour is untouched: absent or 'all' send the full sequence", async () => {
    for (const [i, over] of ([{}, { audio_selection: "all" }] as Row[]).entries()) {
      h.sendMediaMessage.mockClear();
      const mem = setup({ tagged: false, nodes: graph(cfg(over)) });
      await run(`wamid.OK${i}`);
      expect(sentLinks()).toEqual([url("1"), url("2"), url("3")]);
      expect(entered(mem)).toEqual(["start", "vp", "ok"]);
    }
  });
});

// ============================================================
// F2-C: ONE specific audio ("single"): the audio of the product classified with the node's purpose and identifier (migration 076).
// ============================================================
describe("send_product_audios: ONE specific audio (single)", () => {
  const PU1 = "c1111111-1111-4111-8111-111111111111", PU2 = "c2222222-2222-4222-8222-222222222222", PU_B = "c3333333-3333-4333-8333-333333333333";
  const ID1 = "d1111111-1111-4111-8111-111111111111", ID2 = "d2222222-2222-4222-8222-222222222222", ID_B = "d3333333-3333-4333-8333-333333333333";
  const PX = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const sentLinks = () => wire().map((w) => w.link);
  const names = (over: { purposes?: Row[]; identifiers?: Row[] } = {}): Record<string, Row[]> => ({
    audio_guide_purposes: over.purposes ?? [
      { id: PU1, account_id: A, name: "Pago", name_key: "pago", active: true }, { id: PU2, account_id: A, name: "Provincia", name_key: "provincia", active: true },
      { id: PU_B, account_id: B, name: "Pago", name_key: "pago", active: true },
    ],
    audio_guide_identifiers: over.identifiers ?? [
      { id: ID1, account_id: A, name: "Principal", name_key: "principal", active: true }, { id: ID2, account_id: A, name: "Alternativo", name_key: "alternativo", active: true },
      { id: ID_B, account_id: B, name: "Principal", name_key: "principal", active: true },
    ],
  });
  /** audio 1 = Pago/Principal (5 s), audio 2 = Pago/Alternativo (7 s), audio 3 = Provincia/Principal (9 s) */
  const classified = (over: Array<Partial<Row>> = [], product = "p-xtd"): Row[] => items([5, 7, 9], product).map((r, n) => ({
    ...r, purpose_id: [PU1, PU1, PU2][n], identifier_id: [ID1, ID2, ID1][n], ...(over[n] ?? {}),
  }));
  const single = (purpose: string | null, identifier: string | null, over: Row = {}): Row => ({
    gate_mode: "none", gate_tag_id: "", product_source: "auto", product_field_id: "", product_id: "", audio_selection: "single", purpose_id: purpose, identifier_id: identifier,
    next_node_key: "ok", unknown_node_key: "unk", no_audios_node_key: "noa", gate_closed_node_key: "gate", ...over,
  });
  const world = (nodeCfg: Row, over: Parameters<typeof setup>[0] = {}) => setup({ nodes: graph(nodeCfg), items: classified(), extra: names(), ...over });
  const requestsOf = (mem: ReturnType<typeof createMemoryDb>) => mem.table("audio_guide_requests");

  it("sends exactly the audio with that purpose and identifier - nothing else - and follows 'next'", async () => {
    const mem = world(single(PU1, ID2));
    await run();
    expect(sentLinks()).toEqual([url("2")]);
    expect(entered(mem)).toEqual(["start", "vp", "ok"]);
    expect(lastRun(mem)).toMatchObject({ status: "completed" });
    expect(mem.table("audio_guide_sends")).toHaveLength(1);
    expect(mem.table("audio_guide_sends")[0]).toMatchObject({ item_id: "p-xtd-i2", position: 1, status: "sent", pre_delay_seconds: 7 });
  });
  it("each pair finds its own audio (three nodes, three audios), whatever the order of the product's audios", async () => {
    for (const [pu, id, want] of [[PU1, ID1, "1"], [PU1, ID2, "2"], [PU2, ID1, "3"]] as const) {
      h.sendMediaMessage.mockClear();
      world(single(pu, id));
      await run(`wamid.P${want}`);
      expect(sentLinks(), `${pu}/${id}`).toEqual([url(want)]);
    }
  });
  it("respects the audio's own pause before it (7 s here): nothing is sent before it elapsed", async () => {
    world(single(PU1, ID2));
    const pending = dispatch();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.sendMediaMessage).toHaveBeenCalledTimes(1);
    await pending;
  });
  it("records what was asked: mode, purpose and identifier ids and the names seen, and the node", async () => {
    const mem = world(single(PU1, ID2));
    await run("wamid.IN1");
    expect(requestsOf(mem)).toHaveLength(1);
    expect(requestsOf(mem)[0]).toMatchObject({ trigger_message_id: "wamid.IN1#vp", selection_mode: "single", purpose_id: PU1, identifier_id: ID2, purpose_name: "Pago", identifier_name: "Alternativo", node_key: "vp", status: "completed", product_id: "p-xtd" });
    expect(mem.table("flow_run_events").find((e) => e.event_type === "message_sent")?.payload).toMatchObject({ selection: "single", sent: 1, route: "next" });
  });
  it("works with the product chosen by hand, and with an automatic product, the same way", async () => {
    const XTD: Row = { id: PX, account_id: A, product_key: "combo xtd", display_name: "Combo XTD", active: true, revision: 1 };
    const manual = world(single(PU2, ID1, { product_source: "manual", product_id: PX }), { products: [XTD], items: classified([], PX), value: null });
    await run("wamid.M1");
    expect(sentLinks()).toEqual([url("3")]);
    expect(entered(manual)).toEqual(["start", "vp", "ok"]);
    h.sendMediaMessage.mockClear();
    world(single(PU2, ID1, { product_source: "auto" }));
    await run("wamid.A1");
    expect(sentLinks()).toEqual([url("3")]);
  });
  it("the 'all' node keeps sending the whole product, classified or not (the classification changes nothing for it)", async () => {
    const mem = world({ ...NODE_CFG, gate_tag_id: TAG });
    await run();
    expect(sentLinks()).toEqual([url("1"), url("2"), url("3")]);
    expect(requestsOf(mem)[0].trigger_message_id).toBe("wamid.IN1"); // the plain message id, exactly as before
    expect(requestsOf(mem)[0].selection_mode ?? null).toBeNull();
  });

  describe("no matching audio: the 'no audios' route, nothing sent, never widened to the other audios", () => {
    const expectNoAudios = async (mem: ReturnType<typeof createMemoryDb>, why: string) => {
      expect(sentLinks()).toEqual([]);
      expect(h.sendMediaMessage).not.toHaveBeenCalled();
      expect(entered(mem)).toEqual(["start", "vp", "noa"]);
      expect(mem.table("audio_guide_sends")).toHaveLength(0);
      expect(requestsOf(mem)).toHaveLength(1);
      expect(requestsOf(mem)[0]).toMatchObject({ status: "skipped", reason: why, selection_mode: "single", node_key: "vp" });
    };
    it("no audio of the product carries that pair", async () => {
      const mem = world(single(PU2, ID2)); // Provincia/Alternativo exists as names but no audio has it
      await run();
      await expectNoAudios(mem, "audio_not_found");
    });
    it("the audio is switched off (a disabled audio is not sent, and the other audios are not used instead)", async () => {
      const mem = world(single(PU1, ID2), { items: classified([{}, { status: "disabled" }, {}]) });
      await run();
      await expectNoAudios(mem, "audio_disabled");
    });
    it("the purpose or the identifier is inactive (the audio keeps its classification but cannot be asked for)", async () => {
      let mem = world(single(PU1, ID1), { extra: names({ purposes: [{ id: PU1, account_id: A, name: "Pago", name_key: "pago", active: false }] }) });
      await run("wamid.X1");
      await expectNoAudios(mem, "purpose_unavailable");
      h.sendMediaMessage.mockClear();
      mem = world(single(PU1, ID1), { extra: names({ identifiers: [{ id: ID1, account_id: A, name: "Principal", name_key: "principal", active: false }] }) });
      await run("wamid.X2");
      await expectNoAudios(mem, "identifier_unavailable");
    });
    it("the purpose or identifier was deleted or never existed", async () => {
      const mem = world(single("c9999999-9999-4999-8999-999999999999", ID1));
      await run();
      await expectNoAudios(mem, "purpose_unavailable");
    });
    it("a purpose / identifier of ANOTHER account is unavailable, even though it has the same name here and there", async () => {
      const mem = world(single(PU_B, ID_B));
      await run();
      await expectNoAudios(mem, "purpose_unavailable");
      expect(requestsOf(mem)[0]).toMatchObject({ purpose_id: null, identifier_id: null }); // ids that are not this account's are not recorded
    });
    it("a product with no active audio at all", async () => {
      const mem = world(single(PU1, ID1), { items: classified([{ status: "disabled" }, { status: "disabled" }, { status: "disabled" }]) });
      await run();
      await expectNoAudios(mem, "no_audios");
    });
    it("an audio of another account's product with the same pair is never used", async () => {
      const mem = world(single(PU1, ID1), { items: [...classified().filter((r) => r.pre_delay_seconds !== 5 && r.pre_delay_seconds !== 7 && r.pre_delay_seconds !== 9), ...classified([], "p-b").map((r) => ({ ...r, account_id: B }))] });
      await run();
      await expectNoAudios(mem, "no_audios");
    });
  });

  describe("the other routes still work with a selected audio", () => {
    it("unknown product -> the 'unknown' route, recorded with the selection and the node", async () => {
      const mem = world(single(PU1, ID1), { value: "Producto que no existe" });
      await run();
      expect(sentLinks()).toEqual([]);
      expect(entered(mem)).toEqual(["start", "vp", "unk"]);
      expect(requestsOf(mem)[0]).toMatchObject({ status: "skipped", reason: "unknown_product", selection_mode: "single", purpose_id: PU1, identifier_id: ID1, node_key: "vp" });
    });
    it("a contact without a Producto value -> 'unknown'", async () => {
      const mem = world(single(PU1, ID1), { value: null });
      await run();
      expect(entered(mem)).toEqual(["start", "vp", "unk"]);
    });
    it("an inactive product -> 'unknown'", async () => {
      const mem = world(single(PU1, ID1), { products: [{ id: "p-xtd", account_id: A, product_key: "combo xtd", display_name: "Combo XTD", active: false, revision: 2 }] });
      await run();
      expect(sentLinks()).toEqual([]);
      expect(entered(mem)).toEqual(["start", "vp", "unk"]);
    });
    it("the optional tag: a contact without it takes 'gate closed', and with it gets the one audio", async () => {
      const gated = single(PU1, ID1, { gate_mode: "required", gate_tag_id: TAG });
      let mem = world(gated, { tagged: false });
      await run("wamid.G1");
      expect(sentLinks()).toEqual([]);
      expect(entered(mem)).toEqual(["start", "vp", "gate"]);
      expect(requestsOf(mem)[0]).toMatchObject({ reason: "gate_closed", selection_mode: "single", trigger_message_id: "wamid.G1#vp" });
      h.sendMediaMessage.mockClear();
      mem = world(gated, { tagged: true });
      await run("wamid.G2");
      expect(sentLinks()).toEqual([url("1")]);
    });
  });

  describe("idempotency: one send per inbound message AND node", () => {
    it("the same inbound message delivered again after it finished sends nothing more and follows 'next'", async () => {
      const mem = world(single(PU1, ID2));
      await run("wamid.IN1");
      expect(h.sendMediaMessage).toHaveBeenCalledTimes(1);
      const again = await run("wamid.IN1");
      expect(again).toMatchObject({ consumed: true });
      expect(h.sendMediaMessage).toHaveBeenCalledTimes(1);
      expect(requestsOf(mem)).toHaveLength(1);
      expect(mem.table("flow_run_events").find((e) => e.event_type === "message_sent" && (e.payload as { duplicate?: boolean }).duplicate)).toBeTruthy();
    });
    it("a different inbound message later gets its own audio", async () => {
      const mem = world(single(PU1, ID2));
      await run("wamid.IN1"); await run("wamid.IN2");
      expect(h.sendMediaMessage).toHaveBeenCalledTimes(2);
      expect(requestsOf(mem).map((r) => r.trigger_message_id)).toEqual(["wamid.IN1#vp", "wamid.IN2#vp"]);
    });
    it("two specific-audio nodes of the same Flow for the same message do not collide: each sends its own audio, once", async () => {
      const second = single(PU2, ID1, { next_node_key: "ok" });
      const nodes: Row[] = [
        { flow_id: "flow-1", node_key: "start", node_type: "start", config: { next_node_key: "vp" } },
        { flow_id: "flow-1", node_key: "vp", node_type: "send_product_audios", config: single(PU1, ID2, { next_node_key: "vp2" }) },
        { flow_id: "flow-1", node_key: "vp2", node_type: "send_product_audios", config: second },
        ...["ok", "unk", "noa", "gate"].map((k) => ({ flow_id: "flow-1", node_key: k, node_type: "end", config: {} })),
      ];
      const mem = world(single(PU1, ID2), { nodes });
      await run("wamid.IN1");
      expect(sentLinks()).toEqual([url("2"), url("3")]);
      expect(entered(mem)).toEqual(["start", "vp", "vp2", "ok"]);
      expect(requestsOf(mem).map((r) => r.trigger_message_id)).toEqual(["wamid.IN1#vp", "wamid.IN1#vp2"]);
      await run("wamid.IN1");
      expect(h.sendMediaMessage).toHaveBeenCalledTimes(2); // redelivery: neither node sends again
    });
    it("a node that sends 'all' and a node that sends one audio for the same message use different keys", async () => {
      const nodes: Row[] = [
        { flow_id: "flow-1", node_key: "start", node_type: "start", config: { next_node_key: "vp" } },
        { flow_id: "flow-1", node_key: "vp", node_type: "send_product_audios", config: single(PU1, ID1, { next_node_key: "vpall" }) },
        { flow_id: "flow-1", node_key: "vpall", node_type: "send_product_audios", config: { gate_mode: "none", gate_tag_id: "", next_node_key: "ok", unknown_node_key: "unk", no_audios_node_key: "noa" } },
        ...["ok", "unk", "noa", "gate"].map((k) => ({ flow_id: "flow-1", node_key: k, node_type: "end", config: {} })),
      ];
      const mem = world(single(PU1, ID1), { nodes });
      await run("wamid.IN1");
      expect(requestsOf(mem).map((r) => r.trigger_message_id)).toEqual(["wamid.IN1#vp", "wamid.IN1"]);
      expect(sentLinks()).toEqual([url("1"), url("1"), url("2"), url("3")]);
    });
    it("a manual start (no inbound message) keys the request on the run and the node", async () => {
      const mem = world(single(PU1, ID1));
      await run("", "provincia");
      expect(requestsOf(mem)[0].trigger_message_id).toMatch(/^run:.+#vp$/);
    });
  });

  describe("failures never look like success, and nothing extra is sent", () => {
    it("Meta rejects the one audio: the run FAILS, the request is failed, the 'next' route is not taken, nothing else is sent", async () => {
      h.sendMediaMessage.mockImplementation(async () => { throw new MetaApiError({ message: "Media upload error", code: 131053, httpStatus: 400 }); });
      const mem = world(single(PU1, ID2));
      await run();
      expect(h.sendMediaMessage).toHaveBeenCalledTimes(1);
      expect(mem.table("audio_guide_sends").map((s) => s.status)).toEqual(["failed"]);
      expect(requestsOf(mem)[0].status).toBe("failed");
      expect(lastRun(mem)).toMatchObject({ status: "failed", end_reason: "audio_sequence_incomplete" });
      expect(entered(mem)).not.toContain("ok");
      await vi.advanceTimersByTimeAsync(300_000);
      await resumeAudioRequests({ db: mem.client as unknown as SequencerDb, isEnabled: () => true, depsFor: () => ({ sendVoiceNote: sendVoiceNoteViaEngine }) });
      expect(h.sendMediaMessage).toHaveBeenCalledTimes(1); // the resumer never retries a failed audio
    });
    it("the database cannot open the request: the run fails with request_open_failed and nothing is sent", async () => {
      const mem = world(single(PU1, ID1));
      const handlers = mem.client as unknown as { rpc: (fn: string, args: Row) => Promise<unknown> };
      const real = handlers.rpc.bind(handlers);
      handlers.rpc = (fn, args) => (fn === "audio_guide_open_selected_request" ? Promise.resolve({ data: null, error: { message: "db down" } }) : real(fn, args));
      await run();
      expect(sentLinks()).toEqual([]);
      expect(errors(mem).map((e) => (e.payload as { reason?: string }).reason)).toContain("request_open_failed");
      expect(entered(mem)).not.toContain("ok");
    });
    it("an answer this version does not recognise is a failure, never a success and never 'send all'", async () => {
      const mem = world(single(PU1, ID1));
      const handlers = mem.client as unknown as { rpc: (fn: string, args: Row) => Promise<unknown> };
      const real = handlers.rpc.bind(handlers);
      handlers.rpc = (fn, args) => (fn === "audio_guide_open_selected_request" ? Promise.resolve({ data: { ok: false, reason: "something_new" }, error: null }) : real(fn, args));
      await run();
      expect(sentLinks()).toEqual([]);
      expect(errors(mem).map((e) => (e.payload as { reason?: string }).reason)).toContain("request_open_failed");
    });
    it("the catalog changing between the lookup and the request is retried once, then fails: it is not turned into another audio", async () => {
      const mem = world(single(PU1, ID1));
      const handlers = mem.client as unknown as { rpc: (fn: string, args: Row) => Promise<unknown> };
      const real = handlers.rpc.bind(handlers);
      handlers.rpc = (fn, args) => (fn === "audio_guide_open_selected_request" ? Promise.resolve({ data: { ok: false, reason: "catalog_changed" }, error: null }) : real(fn, args));
      await run();
      expect(sentLinks()).toEqual([]);
      expect(errors(mem).map((e) => (e.payload as { reason?: string }).reason)).toContain("catalog_changed");
    });
    it("a blocked contact: nothing is sent", async () => {
      const mem = world(single(PU1, ID1), { contact: { blocked: true } });
      await run();
      expect(sentLinks()).toEqual([]);
      void mem;
    });
  });

  describe("pauses, budget and the resumer: the same runner, a one-audio request", () => {
    it("when the inline budget is spent the audio stays pending and the resumer sends exactly that one audio, once", async () => {
      const { executeSendProductAudios } = await import("./product-audios");
      const mem = world(single(PU1, ID2));
      const run1 = { id: "run-x", account_id: A, flow_id: "flow-1", user_id: "u-1", contact_id: "ct-1", conversation_id: "cv-1", status: "active", vars: {}, current_node_key: "vp" } as never;
      mem.table("flow_runs").push(run1 as unknown as Row);
      mem.table("flow_run_events").push({ flow_run_id: "run-x", event_type: "started", payload: { meta_message_id: "wamid.BUD" } });
      const first = await executeSendProductAudios({ db: mem.client as never, run: run1, nodeKey: "vp", config: single(PU1, ID2), deps: { budgetMs: 1 } });
      expect(first).toMatchObject({ kind: "failed", reason: "audio_sequence_incomplete" });
      expect(h.sendMediaMessage).not.toHaveBeenCalled();
      expect(mem.table("audio_guide_sends").map((s) => s.status)).toEqual(["pending"]);
      expect(requestsOf(mem)[0]).toMatchObject({ trigger_message_id: "wamid.BUD#vp", selection_mode: "single" });
      await vi.advanceTimersByTimeAsync(10_000);
      const summary = await resumeAudioRequests({ db: mem.client as unknown as SequencerDb, isEnabled: () => true, depsFor: () => ({ sendVoiceNote: sendVoiceNoteViaEngine }) });
      expect(summary.examined).toBe(1);
      expect(sentLinks()).toEqual([url("2")]);
      await vi.advanceTimersByTimeAsync(10_000);
      await resumeAudioRequests({ db: mem.client as unknown as SequencerDb, isEnabled: () => true, depsFor: () => ({ sendVoiceNote: sendVoiceNoteViaEngine }) });
      expect(h.sendMediaMessage).toHaveBeenCalledTimes(1);
      expect(mem.table("audio_guide_sends").map((s) => s.status)).toEqual(["sent"]);
    });
  });

  describe("accounts with the same names stay apart", () => {
    it("account B's identical product, purposes and identifiers never answer account A's node, and A's node never reads B's audio", async () => {
      const bItems = classified([], "p-b").map((r) => ({ ...r, account_id: B, purpose_id: PU_B, identifier_id: ID_B }));
      const bProduct: Row = { id: "p-b", account_id: B, product_key: "combo xtd", display_name: "Combo XTD", active: true, revision: 2 };
      const mem = world(single(PU1, ID1), { products: [{ id: "p-xtd", account_id: A, product_key: "combo xtd", display_name: "Combo XTD", active: true, revision: 2 }, bProduct], items: [...classified(), ...bItems] });
      await run();
      expect(sentLinks()).toEqual([url("1")]);
      expect(requestsOf(mem)[0]).toMatchObject({ account_id: A, product_id: "p-xtd", purpose_id: PU1, identifier_id: ID1 });
    });
  });
});
