import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================
// CHARACTERISATION of today's behaviour (no R1): what happens to a message that matches the audio keyword depending on the state of the
// contact's commercial flow. These tests document the CURRENT behaviour the R1 design (qa/audio-guide/R1-DISENO.md) is compared against.
// They assert what the engine does now; none of it is changed by AP-05A.
// ============================================================

const h = vi.hoisted(() => ({ db: null as unknown, sendMediaMessage: vi.fn(), sendTextMessage: vi.fn(), sendInteractiveButtons: vi.fn() }));
vi.mock("./admin-client", () => ({ supabaseAdmin: () => h.db }));
vi.mock("@/lib/whatsapp/send-message", () => ({ resolveOutboundTransport: () => "meta" }));
vi.mock("@/lib/whatsapp/encryption", () => ({ decrypt: (v: string) => v }));
vi.mock("@/lib/whatsapp/meta-api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendMediaMessage: (...a: unknown[]) => h.sendMediaMessage(...a),
  sendTextMessage: (...a: unknown[]) => h.sendTextMessage(...a),
  sendInteractiveButtons: (...a: unknown[]) => h.sendInteractiveButtons(...a),
}));

import { dispatchInboundToFlows } from "./engine";
import { createMemoryDb, type Row } from "./test-support/memory-db";
import { audioGuideRpc } from "./test-support/audio-guide-model";

const A = "046ff8c2-1111-4222-8333-444455556666";
const TAG = "11111111-1111-4111-8111-111111111111";
const FIELD = "33333333-3333-4333-8333-333333333333";
const ORIGIN = "https://supabase.example.test";

const audioFlow: Row = { id: "flow-audio", account_id: A, user_id: "u-1", status: "active", trigger_type: "keyword", trigger_config: { keywords: ["provincia"] }, entry_node_id: "start", created_at: "2026-01-01T00:00:00Z" };
const commercial: Row = { id: "flow-com", account_id: A, user_id: "u-1", status: "active", trigger_type: "keyword", trigger_config: { keywords: ["hola"] }, entry_node_id: "menu", created_at: "2025-01-01T00:00:00Z" };
const nodes: Row[] = [
  { flow_id: "flow-audio", node_key: "start", node_type: "start", config: { next_node_key: "vp" } },
  { flow_id: "flow-audio", node_key: "vp", node_type: "send_product_audios", config: { gate_tag_id: TAG, product_field_id: "", next_node_key: "ok", unknown_node_key: "ok", no_audios_node_key: "ok", gate_closed_node_key: "ok" } },
  { flow_id: "flow-audio", node_key: "ok", node_type: "end", config: {} },
  { flow_id: "flow-com", node_key: "menu", node_type: "send_buttons", config: { text: "¿Qué necesitas?", buttons: [{ reply_id: "b1", title: "Precio", next_node_key: "fin" }, { reply_id: "b2", title: "Soporte", next_node_key: "fin" }] } },
  { flow_id: "flow-com", node_key: "ask", node_type: "collect_input", config: { prompt_text: "¿Ciudad?", var_key: "ciudad", next_node_key: "fin" } },
  { flow_id: "flow-com", node_key: "fin", node_type: "end", config: {} },
];

function setup(activeRun?: Row) {
  const clock = { now: () => Date.now(), advance: () => {} };
  const mem: ReturnType<typeof createMemoryDb> = createMemoryDb({
    flows: [audioFlow, commercial], flow_nodes: nodes,
    contacts: [{ id: "ct-1", account_id: A, name: "Ana", phone: "+15551234567", blocked: false }],
    conversations: [{ id: "cv-1", account_id: A, user_id: "u-1" }],
    whatsapp_config: [{ account_id: A, phone_number_id: "pn-1", access_token: "token" }],
    tags: [{ id: TAG, account_id: A }], contact_tags: [{ contact_id: "ct-1", tag_id: TAG }],
    custom_fields: [{ id: FIELD, account_id: A, field_name: "Producto" }], contact_custom_values: [{ contact_id: "ct-1", custom_field_id: FIELD, value: "uno" }],
    audio_guide_products: [{ id: "p1", account_id: A, product_key: "uno", active: true, revision: 1 }],
    audio_guide_items: [{ id: "i1", account_id: A, product_id: "p1", position: 1, voice_sha256: "a".repeat(64), status: "active", pre_delay_seconds: 5 }],
    flow_runs: activeRun ? [activeRun] : [],
  }, { rpc: audioGuideRpc((n) => mem.table(n), clock) });
  h.db = mem.client;
  return mem;
}
const run = (over: Row): Row => ({ id: "run-com", flow_id: "flow-com", account_id: A, user_id: "u-1", contact_id: "ct-1", conversation_id: "cv-1", status: "active", vars: {}, reprompt_count: 0, started_at: "2026-10-18T11:59:00Z", ...over });
async function say(text = "provincia", id = "wamid.IN1") {
  const pending = dispatchInboundToFlows({ accountId: A, userId: "u-1", contactId: "ct-1", conversationId: "cv-1", message: { kind: "text", text, meta_message_id: id }, isFirstInboundMessage: false });
  await vi.advanceTimersByTimeAsync(60_000);
  return pending;
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", ORIGIN); vi.stubEnv("FLOW_VOICE_NOTE_ACCOUNT_IDS", A);
  h.sendMediaMessage.mockReset().mockResolvedValue({ messageId: "wamid.OUT" });
  h.sendTextMessage.mockReset().mockResolvedValue({ messageId: "wamid.TXT" });
  h.sendInteractiveButtons.mockReset().mockResolvedValue({ messageId: "wamid.BTN" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("today, without R1: what the keyword does depending on the contact's commercial flow", () => {
  it("no active flow: the audio flow starts and sends the audio", async () => {
    const mem = setup();
    await say();
    expect(h.sendMediaMessage).toHaveBeenCalledTimes(1);
    expect(mem.table("flow_runs").filter((r) => r.flow_id === "flow-audio")).toHaveLength(1);
  });

  it("waiting on a BUTTONS question: the audio flow does not start, the message is CONSUMED as an unmatched reply and the commercial run's state changes (reprompt)", async () => {
    const mem = setup(run({ current_node_key: "menu", reprompt_count: 0 }));
    const result = await say();
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
    expect(result.consumed).toBe(true);
    expect(mem.table("flow_runs").find((r) => r.id === "run-com")?.reprompt_count).toBe(1); // the commercial state was modified by a message that was a request for audio
    expect(h.sendInteractiveButtons).toHaveBeenCalledTimes(1); // the menu was sent again: the customer gets the menu, not the audio
  });

  it("waiting on a free-text question (collect_input): the audio request is captured as the ANSWER (a wrong city) and the commercial flow advances", async () => {
    const mem = setup(run({ current_node_key: "ask" }));
    await say();
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
    expect(mem.table("flow_runs").find((r) => r.id === "run-com")).toMatchObject({ vars: { ciudad: "provincia" } });
  });

  it("a person is attending (the run was paused by the agent): there is no active run, so the keyword flow STARTS even though a human is in the conversation", async () => {
    const mem = setup(run({ status: "paused_by_agent", end_reason: "agent_replied", current_node_key: "menu" }));
    await say();
    expect(h.sendMediaMessage).toHaveBeenCalledTimes(1);
    expect(mem.table("flow_runs").filter((r) => r.flow_id === "flow-audio")).toHaveLength(1);
  });
});
