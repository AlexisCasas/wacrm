import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================
// Unified variables — SYNTHETIC end-to-end run of a flow that writes custom fields and then uses them in its texts, driven through the REAL runner and the REAL senders for a contact known only
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
  N("set1", "set_contact_field", { field: `custom:${F1}`, value: "S/ 110", next_node_key: "set2" }),
  N("set2", "set_contact_field", { field: `custom:${F2}`, value: "Prensa de banco SAFARI", next_node_key: "m1" }),
  N("m1", "send_message", { text: "Hola {{first_name}}, el producto {{producto}} cuesta {{precio}}. Tu ciudad: {{ciudad | por confirmar}}. Estable: {{custom:" + F2 + "}}. Antiguo: {{vars.contact_name}}. Num: {{1}} Sin definir: {{cuf_14160052}}", next_node_key: "d1" }),
  N("d1", "delay", { seconds: 3, next_node_key: "m2" }),
  N("m2", "send_message", { text: "{{first_name}} | {{last_name}} | {{full_name}} | [{{phone}}] | [{{email}}] | [{{company}}]", next_node_key: "end" }),
  N("end", "end", {}),
];

let mem: ReturnType<typeof createMemoryDb>;
function setup(o: { phone?: string; auth?: Row | null; master?: boolean; scope?: boolean } = {}) {
  const t = (n: string) => mem.table(n);
  mem = createMemoryDb({
    flows: [flowRow], flow_nodes: nodes,
    contacts: [{ id: "ct-1", account_id: ACC, name: "Ana María Pérez Quispe", email: "ana@example.test", company: "Ferretería Ana", phone: o.phone ?? "", phone_optional: !o.phone, blocked: false }],
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


const texts = () => h.sendTextMessage.mock.calls.map((c) => (c[0] as { text: string }).text);

describe("unified variables in a running flow (hidden-number contact)", () => {
  it("resolves standard fields, custom fields (by slug and by stable id), flow vars, fallbacks; leaves {{1}} and the legacy cuf_ reference as written", async () => {
    setup(); await say("amoladora total", "wamid.IN1", [FLOW]);
    expect(texts()[0]).toBe("Hola Ana, el producto Prensa de banco SAFARI cuesta S/ 110. Tu ciudad: por confirmar. Estable: Prensa de banco SAFARI. Antiguo: Ana María Pérez Quispe. Num: {{1}} Sin definir: {{cuf_14160052}}");
  });
  it("names are split; a hidden-number contact has an EMPTY phone placeholder (the BSUID is never shown); email and company resolve", async () => {
    setup(); await say("amoladora total", "wamid.IN1", [FLOW]);
    expect(texts()[1]).toBe("Ana | María Pérez Quispe | Ana María Pérez Quispe | [] | [ana@example.test] | [Ferretería Ana]");
    expect(texts().join("|")).not.toContain(BSUID);
  });
  it("a phone-bearing contact shows its real phone and is still sent by phone", async () => {
    setup({ phone: "51999111222" }); await say("amoladora total", "wamid.IN1");
    expect(texts()[1]).toContain("[51999111222]");
    expect(dests(h.sendTextMessage)[0]).toBe("51999111222");
  });
  it("a custom field changed while the run waits is what the next message shows (resolved at send time)", async () => {
    setup();
    const pending = dispatchInboundToFlows({ accountId: ACC, userId: "u-1", contactId: "ct-1", conversationId: "cv-1", message: { kind: "text", text: "amoladora total", meta_message_id: "wamid.IN1" }, isFirstInboundMessage: false, restrictToFlowIds: [FLOW] });
    await vi.advanceTimersByTimeAsync(500);
    mem.table("contacts")[0].name = "Rosa Nueva";
    await vi.advanceTimersByTimeAsync(60_000); await pending;
    expect(texts()[1].startsWith("Rosa | Nueva")).toBe(true);
  });
  it("never reads another account's contact or fields: a contact id that belongs to another account renders as missing", async () => {
    setup();
    mem.table("contacts").push({ id: "ct-x", account_id: "other-account", name: "Intruso Ajeno", email: "x@other.test" });
    mem.table("custom_fields").push({ id: "ffffffff-0000-4000-8000-00000000ffff", account_id: "other-account", field_name: "Ciudad" });
    mem.table("contact_custom_values").push({ contact_id: "ct-x", custom_field_id: "ffffffff-0000-4000-8000-00000000ffff", value: "Secreta" });
    const { renderTemplate } = await import("@/lib/variables");
    const r = await renderTemplate(mem.client as never, "{{first_name}} {{email}} {{ciudad|-}}", { accountId: ACC, contactId: "ct-x" });
    expect(r.text).toBe("-");
  });
  it("ACCEPTANCE: name + product + price configured in the message become the contact's stored values (field written by an earlier node)", async () => {
    setup(); await say("amoladora total", "wamid.IN1", [FLOW]);
    expect(texts()[0]).toContain("Hola Ana, el producto Prensa de banco SAFARI cuesta S/ 110.");
  });
  it("a contact with NO name: no double spaces, no raw token; the flow still runs and every message is sent", async () => {
    setup(); mem.table("contacts")[0].name = "";
    await say("amoladora total", "wamid.IN1", [FLOW]);
    expect(texts()).toHaveLength(2);
    expect(texts()[1]).toBe("| | | [] | [ana@example.test] | [Ferretería Ana]".replace(/^\| \| \| /, "| | | "));
    for (const t of texts()) { expect(t).not.toMatch(/ {2}/); }
    expect(texts()[0].startsWith("Hola, el producto")).toBe(true);
  });
  it("a renamed custom field keeps working by its stable id; the old friendly name stops matching and renders nothing", async () => {
    setup(); mem.table("custom_fields").find((f) => f.id === F2)!.field_name = "Equipo";
    await say("amoladora total", "wamid.IN1", [FLOW]);
    expect(texts()[0]).toContain("Estable: Prensa de banco SAFARI");
    expect(texts()[0]).toContain("el producto cuesta S/ 110"); // {{producto}} no longer exists -> not guessed, renders nothing (no raw braces)
    expect(texts()[0]).not.toContain("{{producto}}");
  });
  it("a legacy reference mapped by data ({{cuf_14160052}} -> field_options.aliases) resolves; a field name is never needed in code", async () => {
    setup(); mem.table("custom_fields").find((f) => f.id === F1)!.field_options = { aliases: ["cuf_14160052"] };
    await say("amoladora total", "wamid.IN1", [FLOW]);
    expect(texts()[0]).toContain("Sin definir: S/ 110");
  });
});
