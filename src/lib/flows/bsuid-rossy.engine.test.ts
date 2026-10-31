import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================
// BSUID phase 4B — SYNTHETIC end-to-end run of a Flow shaped exactly like Rossy's 70 product flows ("AMOLADORA TOTAL": start, two
// set_contact_field, text, 3 s delays, one image, texts, end), driven through the REAL runner and the REAL senders for a contact known only
// by a WhatsApp user id. Meta is stubbed at the send functions (it records the destination); nothing leaves the process and no real customer
// is involved. The authorization functions of migration 078 are mirrored by scripted rpc (their SQL is exercised against PostgreSQL by qa/bsuid).
// ============================================================

const h = vi.hoisted(() => ({ db: null as unknown, sendMediaMessage: vi.fn(), sendTextMessage: vi.fn() }));
vi.mock("./admin-client", () => ({ supabaseAdmin: () => h.db }));
vi.mock("@/lib/whatsapp/send-message", () => ({ resolveOutboundTransport: () => "meta" }));
vi.mock("@/lib/whatsapp/encryption", () => ({ decrypt: (v: string) => v }));
vi.mock("@/lib/whatsapp/meta-api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendMediaMessage: (...a: unknown[]) => h.sendMediaMessage(...a),
  sendTextMessage: (...a: unknown[]) => h.sendTextMessage(...a),
}));

import { dispatchInboundToFlows } from "./engine";
import { createMemoryDb, type Row } from "./test-support/memory-db";
import { resetBsuidScopeCache } from "@/lib/whatsapp/bsuid-flow-auth";

const ACC = "c35b393f-aaaa-4bbb-8ccc-00000000c35b";
const FLOW = "b303ca23-0000-4000-8000-00000000b303";
const OTHER_FLOW = "99999999-0000-4000-8000-000000000099";
const F1 = "d08e0270-1ab4-4e52-bb1b-03b24e2d227c";
const F2 = "f037f018-87d9-4995-bbc7-5409b536f739";
const BSUID = "PE.ROSSYQA0000000001";
const PN = "1349097678278530";
const WABA = "1090000000000001";
const PILOT = "WHATSAPP_BSUID_PILOT";

const flowRow: Row = { id: FLOW, account_id: ACC, user_id: "u-1", status: "active", trigger_type: "keyword", trigger_config: { keywords: ["amoladora total"] }, entry_node_id: "start", created_at: "2026-01-01T00:00:00Z", fallback_policy: { on_exhaust: "handoff", max_reprompts: 2, on_timeout_hours: 24, on_unknown_reply: "reprompt" } };
const N = (node_key: string, node_type: string, config: Row): Row => ({ flow_id: FLOW, node_key, node_type, config });
const nodes: Row[] = [
  N("start", "start", { next_node_key: "set1" }),
  N("set1", "set_contact_field", { field: `custom:${F1}`, value: "139.9", next_node_key: "set2" }),
  N("set2", "set_contact_field", { field: `custom:${F2}`, value: "Amoladora Total", next_node_key: "m1" }),
  N("m1", "send_message", { text: "Hola estimado {{vars.contact_name}} 🤗", next_node_key: "d1" }),
  N("d1", "delay", { seconds: 3, next_node_key: "m2" }),
  N("m2", "send_message", { text: "🔥 AMOLADORA TOTAL 710W", next_node_key: "d2" }),
  N("d2", "delay", { seconds: 3, next_node_key: "img" }),
  N("img", "send_media", { caption: "", filename: "Amoladora Total.jpeg", media_url: "https://cdn.example.test/amoladora.jpeg", media_type: "image", next_node_key: "d3" }),
  N("d3", "delay", { seconds: 3, next_node_key: "m3" }),
  N("m3", "send_message", { text: "🔥Promoción única🔥 Ahora : S/ 139.90", next_node_key: "d4" }),
  N("d4", "delay", { seconds: 3, next_node_key: "m4" }),
  N("m4", "send_message", { text: "¿PARA DÓNDE DESEA HACER SU PEDIDO?🤗", next_node_key: "end" }),
  N("end", "end", {}),
];

let mem: ReturnType<typeof createMemoryDb>;
function setup(o: { phone?: string; auth?: Row | null; master?: boolean; scope?: boolean } = {}) {
  const t = (n: string) => mem.table(n);
  mem = createMemoryDb({
    flows: [flowRow], flow_nodes: nodes,
    contacts: [{ id: "ct-1", account_id: ACC, name: "Ana Pérez", phone: o.phone ?? "", phone_optional: !o.phone, blocked: false }],
    contact_identities: [{ id: "i1", account_id: ACC, contact_id: "ct-1", kind: "bsuid", value: BSUID, superseded_at: null, send_authorized_remaining: 0 }],
    conversations: [{ id: "cv-1", account_id: ACC, user_id: "u-1", contact_id: "ct-1" }],
    whatsapp_config: [{ account_id: ACC, phone_number_id: PN, waba_id: WABA, access_token: "token" }],
    custom_fields: [{ id: F1, account_id: ACC, field_name: "Precio" }, { id: F2, account_id: ACC, field_name: "Producto" }],
    contact_custom_values: [], messages: [], flow_run_events: [], contact_identity_audit: [],
    bsuid_flow_settings: o.master === false ? [] : [{ account_id: ACC, flows_enabled: true }],
    bsuid_flow_authorizations: o.auth === null ? [] : [{ id: "a1", account_id: ACC, flow_id: FLOW, contact_id: null, enabled: true, allow_text: true, allow_media: true, allow_buttons: false, allow_list: false, allow_audio: false, expires_at: null, ...(o.auth ?? {}) }],
    bsuid_pilot_scopes: o.scope === false ? [] : [{ account_id: ACC, phone_number_id: PN, waba_id: WABA, enabled: true }],
  }, { rpc: {
    audit_bsuid_event: (a) => { t("contact_identity_audit").push({ account_id: a.p_account_id, contact_id: a.p_contact_id, event: a.p_event, origin: a.p_origin, detail: a.p_detail }); return { data: null, error: null }; },
    bsuid_flow_scope: (a) => {
      if (!t("bsuid_flow_settings").some((s) => s.account_id === a.p_account_id && s.flows_enabled)) return { data: [], error: null };
      return { data: [...new Set(t("bsuid_flow_authorizations").filter((x) => x.account_id === a.p_account_id && x.enabled && (!x.contact_id || x.contact_id === a.p_contact_id) && t("flows").some((f) => f.id === x.flow_id && f.status === "active")).map((x) => x.flow_id))], error: null };
    },
    bsuid_flow_send_check: (a) => {
      const flag: Record<string, string> = { text: "allow_text", media: "allow_media", buttons: "allow_buttons", list: "allow_list", audio: "allow_audio" };
      const run = t("flow_runs").find((r) => r.id === a.p_run_id && r.account_id === a.p_account_id && r.contact_id === a.p_contact_id && r.status === "active");
      if (!run) return { data: "run_invalid", error: null };
      if (!t("bsuid_flow_settings").some((s) => s.account_id === a.p_account_id && s.flows_enabled)) return { data: "flows_disabled", error: null };
      const auth = t("bsuid_flow_authorizations").find((x) => x.account_id === a.p_account_id && x.flow_id === run.flow_id && x.enabled && (!x.contact_id || x.contact_id === a.p_contact_id));
      if (!auth) return { data: "flow_not_authorized", error: null };
      if (!auth[flag[String(a.p_modality)]]) return { data: "modality_not_allowed", error: null };
      // migration 079: per-contact ceiling over the bot messages already stored for this contact's conversations
      const cap = Number((t("bsuid_flow_settings").find((x) => x.account_id === a.p_account_id) ?? {}).max_contact_sends_per_hour ?? 60);
      const convs = new Set(t("conversations").filter((c) => c.contact_id === a.p_contact_id).map((c) => c.id));
      if (t("messages").filter((m) => m.sender_type === "bot" && convs.has(m.conversation_id)).length >= cap) return { data: "rate_limited_contact", error: null };
      return { data: "ok", error: null };
    },
  } });
  h.db = mem.client;
  process.env[PILOT] = "";                       // numbers come from the DB scope only (Rossy's case: no environment change)
  resetBsuidScopeCache();
  return mem;
}

async function say(text = "amoladora total", id = "wamid.IN1", restrict?: string[]) {
  const pending = dispatchInboundToFlows({ accountId: ACC, userId: "u-1", contactId: "ct-1", conversationId: "cv-1", message: { kind: "text", text, meta_message_id: id }, isFirstInboundMessage: false, ...(restrict ? { restrictToFlowIds: restrict } : {}) });
  await vi.advanceTimersByTimeAsync(60_000);
  return pending;
}
const dests = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.map((c) => (c[0] as { to: unknown }).to);

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.example.test");
  h.sendMediaMessage.mockReset().mockResolvedValue({ messageId: "wamid.MEDIA" });
  h.sendTextMessage.mockReset().mockImplementation(async () => ({ messageId: `wamid.TXT${h.sendTextMessage.mock.calls.length}` }));
  vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); delete process.env[PILOT]; });

describe("a hidden-number customer runs a Rossy-shaped product flow (synthetic)", () => {
  it("the whole flow runs: 4 texts + 1 image, all by BSUID, in order, fields written, run completed, no manual credit used", async () => {
    setup();
    const r = await say("amoladora total", "wamid.IN1", ["b303ca23-0000-4000-8000-00000000b303"]);
    expect(r.consumed).toBe(true);
    expect(dests(h.sendTextMessage)).toEqual([{ bsuid: BSUID }, { bsuid: BSUID }, { bsuid: BSUID }, { bsuid: BSUID }]);
    expect(dests(h.sendMediaMessage)).toEqual([{ bsuid: BSUID }]);
    const run = mem.table("flow_runs")[0];
    expect(run.status).toBe("completed");
    expect(mem.table("contact_custom_values").map((v) => v.value).sort()).toEqual(["139.9", "Amoladora Total"]);
    expect(mem.table("contact_identities")[0].send_authorized_remaining).toBe(0);
    expect(mem.table("contact_identity_audit").filter((a) => a.event === "send_consumed")).toHaveLength(0)
  });
  it("order and pacing: texts and the image keep the flow's order with its 3 s delays between sends", async () => {
    setup(); await say();
    const order = mem.table("flow_run_events").filter((e) => e.event_type === "message_sent").map((e) => e.node_key);
    expect(order).toEqual(["m1", "m2", "img", "m3", "m4"]);
  });
  it("{{vars.contact_name}} is filled with the customer's name; the profile name is what a hidden-number customer has", async () => {
    setup(); await say();
    expect((h.sendTextMessage.mock.calls[0][0] as { text: string }).text).toBe("Hola estimado Ana Pérez 🤗");
  });
  it("the same flow for a customer WITH a phone is unchanged: destination is the phone, no authorization is consulted", async () => {
    setup({ phone: "+51900000001", auth: null, master: false });
    await say();
    expect(dests(h.sendTextMessage).every((d) => d === "51900000001")).toBe(true)
    expect(dests(h.sendMediaMessage)).toEqual(["51900000001"]);
    expect(mem.table("flow_runs")[0].status).toBe("completed");
  });
  it("closed by default: with no authorization the flow is not even offered (restricted list empty) and nothing is sent", async () => {
    setup({ auth: null });
    const r = await say("amoladora total", "wamid.IN1", []);
    expect(r.consumed).toBe(false)
    expect(h.sendTextMessage).not.toHaveBeenCalled(); expect(mem.table("flow_runs")).toHaveLength(0);
  });
  it("another flow that also matches is NOT served: only the authorized flow can start", async () => {
    setup(); mem.table("flows").unshift({ ...flowRow, id: OTHER_FLOW, created_at: "2025-01-01T00:00:00Z" });
    mem.table("flow_nodes").push(...nodes.map((n) => ({ ...n, flow_id: OTHER_FLOW })));
    await say("amoladora total", "wamid.IN1", [FLOW]);
    expect(mem.table("flow_runs")[0].flow_id).toBe(FLOW);
  });
  it("media NOT authorized: the texts before the image go out, the image is refused and the run ends failed with nothing after it", async () => {
    setup({ auth: { allow_media: false } });
    await say();
    expect(h.sendTextMessage).toHaveBeenCalledTimes(2); expect(h.sendMediaMessage).not.toHaveBeenCalled();
    const run = mem.table("flow_runs")[0]; expect(run.status).toBe("failed"); expect(run.end_reason).toBe("send_media_failed");
    expect(mem.table("contact_identity_audit").some((a) => a.event === "send_blocked" && JSON.stringify(a.detail).includes("modality_not_allowed"))).toBe(true);
  });
  it("kill switch during the run (master switch turned off while the flow sleeps): the next message is refused and no further send happens", async () => {
    setup();
    const pending = dispatchInboundToFlows({ accountId: ACC, userId: "u-1", contactId: "ct-1", conversationId: "cv-1", message: { kind: "text", text: "amoladora total", meta_message_id: "wamid.IN1" }, isFirstInboundMessage: false, restrictToFlowIds: [FLOW] });
    await vi.advanceTimersByTimeAsync(4_000);                       // greeting sent, inside the first delay
    const before = h.sendTextMessage.mock.calls.length;
    mem.table("bsuid_flow_settings")[0].flows_enabled = false;      // KILL
    await vi.advanceTimersByTimeAsync(60_000); await pending;
    expect(before).toBeGreaterThanOrEqual(1);
    expect(h.sendTextMessage.mock.calls.length).toBeLessThanOrEqual(before + 1);   // at most the send already in flight
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
    expect(mem.table("flow_runs")[0].status).toBe("failed");
  });
  it("a Meta error on the image fails the run once: one attempt, no automatic retry, no duplicate text", async () => {
    setup(); h.sendMediaMessage.mockRejectedValue(new Error("(#100) invalid parameter"));
    await say();
    expect(h.sendMediaMessage).toHaveBeenCalledTimes(1);
    expect(h.sendTextMessage).toHaveBeenCalledTimes(2);
    expect(mem.table("flow_runs")[0].status).toBe("failed");
  });
  it("volume ceiling reached mid-run: the sends already made stay, the next one is refused, the run ends failed and nothing else goes out", async () => {
    setup(); mem.table("bsuid_flow_settings")[0].max_contact_sends_per_hour = 3;
    await say();
    expect(h.sendTextMessage.mock.calls.length + h.sendMediaMessage.mock.calls.length).toBe(3);
    expect(mem.table("flow_runs")[0].status).toBe("failed");
    expect(mem.table("contact_identity_audit").some((a) => a.event === "send_blocked" && JSON.stringify(a.detail).includes("rate_limited_contact"))).toBe(true);
  });
  it("a document node of an authorized flow also goes by BSUID (Rossy has none today; the path is the same as the image)", async () => {
    setup(); mem.table("flow_nodes").splice(0, mem.table("flow_nodes").length, ...nodes.filter((n) => n.node_key !== "img").map((n) => n.node_key === "d2" ? { ...n, config: { seconds: 3, next_node_key: "doc" } } : n), N("doc", "send_media", { caption: "Ficha", filename: "ficha.pdf", media_url: "https://cdn.example.test/ficha.pdf", media_type: "document", next_node_key: "d3" }));
    await say();
    expect(dests(h.sendMediaMessage)).toEqual([{ bsuid: BSUID }]);
    expect((h.sendMediaMessage.mock.calls[0][0] as { kind?: string }).kind).toBe("document");
    expect(mem.table("flow_runs")[0].status).toBe("completed");
  });
  it("a switched-off number (scope disabled) refuses every send even with a valid authorization", async () => {
    setup({ scope: false }); await say("amoladora total", "wamid.IN1", [FLOW]);
    expect(h.sendTextMessage).not.toHaveBeenCalled(); expect(h.sendMediaMessage).not.toHaveBeenCalled();
  });
  it("the run's own sends never touch other contacts: exactly one contact receives anything", async () => {
    setup(); mem.table("contacts").push({ id: "ct-2", account_id: ACC, name: "Otro", phone: "+51900000009", blocked: false });
    await say();
    expect(new Set(h.sendTextMessage.mock.calls.map((c) => JSON.stringify((c[0] as { to: unknown }).to)))).toEqual(new Set([JSON.stringify({ bsuid: BSUID })]));
  });
});
