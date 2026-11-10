import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================
// D2: every send made by the Flows engine writes a durable `send_intent` event BEFORE Meta is contacted, plain flows included. If the
// intent cannot be written nothing is sent. A send that was interrupted (before or after Meta answered) is never repeated: the event log
// shows an intent without its confirmation, which recovery classifies as ambiguous. Simulated Meta, in-memory database, no real sends.
// ============================================================

const h = vi.hoisted(() => ({ db: null as unknown, sendTextMessage: vi.fn(), sendInteractiveButtons: vi.fn() }));
vi.mock("./admin-client", () => ({ supabaseAdmin: () => h.db }));
vi.mock("@/lib/whatsapp/send-message", () => ({ resolveOutboundTransport: () => "meta" }));
vi.mock("@/lib/whatsapp/encryption", () => ({ decrypt: (v: string) => v }));
vi.mock("@/lib/whatsapp/meta-api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendTextMessage: (...a: unknown[]) => h.sendTextMessage(...a),
  sendInteractiveButtons: (...a: unknown[]) => h.sendInteractiveButtons(...a),
}));

import { classifyStrandedRun, dispatchInboundToFlows } from "./engine";
import { createMemoryDb, type MemoryDbOptions, type Row } from "./test-support/memory-db";

const A = "046ff8c2-1111-4222-8333-444455556666";
const B = "99999999-aaaa-4bbb-8ccc-dddddddddddd";

const flow = (id: string, account: string, user: string, keyword: string): Row => ({ id, account_id: account, user_id: user, status: "active", trigger_type: "keyword", trigger_config: { keywords: [keyword] }, entry_node_id: "start", created_at: "2026-01-01T00:00:00Z" });
const graph = (flowId: string): Row[] => [
  { flow_id: flowId, node_key: "start", node_type: "start", config: { next_node_key: "m1" } },
  { flow_id: flowId, node_key: "m1", node_type: "send_message", config: { text: "Hola", next_node_key: "menu" } },
  { flow_id: flowId, node_key: "menu", node_type: "send_buttons", config: { text: "¿Qué necesitas?", buttons: [{ reply_id: "b1", title: "Precio", next_node_key: "fin" }, { reply_id: "b2", title: "Soporte", next_node_key: "fin" }] } },
  { flow_id: flowId, node_key: "fin", node_type: "end", config: {} },
];

function setup(options: MemoryDbOptions = {}, runs: Row[] = []) {
  const mem = createMemoryDb({
    flows: [flow("flow-1", A, "u-1", "hola"), flow("flow-2", B, "u-2", "buenas")],
    flow_nodes: [...graph("flow-1"), ...graph("flow-2")],
    contacts: [
      { id: "ct-1", account_id: A, name: "Ana", phone: "+15551234567", blocked: false },
      { id: "ct-2", account_id: B, name: "Beto", phone: "+15557654321", blocked: false },
    ],
    conversations: [{ id: "cv-1", account_id: A, user_id: "u-1" }, { id: "cv-2", account_id: B, user_id: "u-2" }],
    whatsapp_config: [{ account_id: A, phone_number_id: "pn-1", access_token: "token-a" }, { account_id: B, phone_number_id: "pn-2", access_token: "token-b" }],
    flow_runs: runs,
  }, options);
  h.db = mem.client;
  return mem;
}

type Mem = ReturnType<typeof setup>;
const events = (mem: Mem) => mem.table("flow_run_events");
const isIntent = (e: Row) => e.event_type === "node_entered" && (e.payload as Row | undefined)?.reason === "send_intent";
const intents = (mem: Mem) => events(mem).filter(isIntent);
const sent = (mem: Mem) => events(mem).filter((e) => e.event_type === "message_sent");
const errors = (mem: Mem) => events(mem).filter((e) => e.event_type === "error").map((e) => (e.payload as Row).reason);
const failIntent: MemoryDbOptions = { failInsert: (table, row) => (table === "flow_run_events" && (row.payload as Row | undefined)?.reason === "send_intent" ? { message: "event log unavailable" } : undefined) };

/** Runs a dispatch under fake timers; a rejection is returned as a value so it is never an unhandled rejection. */
async function say(text: string, who: "A" | "B" = "A", id = "wamid.IN1"): Promise<unknown> {
  const target = who === "A" ? { accountId: A, userId: "u-1", contactId: "ct-1", conversationId: "cv-1" } : { accountId: B, userId: "u-2", contactId: "ct-2", conversationId: "cv-2" };
  const pending = dispatchInboundToFlows({ ...target, message: { kind: "text", text, meta_message_id: id }, isFirstInboundMessage: false }).then((r) => r, (e: unknown) => ({ rejected: e }));
  await vi.advanceTimersByTimeAsync(60_000);
  return pending;
}

const networkError = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
const waitingRun = (): Row => ({ id: "run-1", flow_id: "flow-1", account_id: A, user_id: "u-1", contact_id: "ct-1", conversation_id: "cv-1", status: "active", vars: {}, reprompt_count: 0, started_at: "2026-11-10T11:59:00Z", last_advanced_at: "2026-11-10T11:59:00Z", current_node_key: "menu" });

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-10T12:00:00Z"));
  h.sendTextMessage.mockReset().mockResolvedValue({ messageId: "wamid.TXT" });
  h.sendInteractiveButtons.mockReset().mockResolvedValue({ messageId: "wamid.BTN" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("durable send_intent for every Flows engine send (D2)", () => {
  it("a plain flow (no durable wait, no subflow) records one intent before each send, same messages as before", async () => {
    const mem = setup();
    await say("hola");
    expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(h.sendInteractiveButtons).toHaveBeenCalledTimes(1);
    const all = events(mem);
    expect(intents(mem).map((e) => e.node_key)).toEqual(["m1", "menu"]);
    for (const confirmation of sent(mem)) {
      const intentIndex = all.findIndex((e) => isIntent(e) && e.node_key === confirmation.node_key);
      expect(intentIndex).toBeGreaterThanOrEqual(0);
      expect(intentIndex).toBeLessThan(all.indexOf(confirmation));
    }
    const attempts = intents(mem).map((e) => (e.payload as Row).attempt);
    expect(new Set(attempts).size).toBe(2);
    expect(attempts.every((a) => typeof a === "string" && (a as string).length > 0)).toBe(true);
  });

  it("when the intent cannot be written nothing is sent and the run fails closed (no retry)", async () => {
    const mem = setup(failIntent);
    await say("hola");
    expect(h.sendTextMessage).not.toHaveBeenCalled();
    expect(h.sendInteractiveButtons).not.toHaveBeenCalled();
    expect(sent(mem)).toHaveLength(0);
    expect(errors(mem)).toContain("send_intent_not_recorded");
    expect(mem.table("flow_runs").at(-1)).toMatchObject({ status: "failed", end_reason: "send_intent_not_recorded" });
    expect(mem.table("messages")).toHaveLength(0);
  });

  it("interrupted while contacting Meta: one attempt only, intent without confirmation, classified ambiguous (never resent)", async () => {
    const mem = setup();
    h.sendTextMessage.mockRejectedValue(networkError());
    await say("hola");
    expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(h.sendInteractiveButtons).not.toHaveBeenCalled();
    expect(intents(mem).map((e) => e.node_key)).toEqual(["m1"]);
    expect(sent(mem)).toHaveLength(0);
    expect(errors(mem)).toContain("send_text_failed");
    expect(mem.table("flow_runs").at(-1)).toMatchObject({ status: "failed", end_reason: "send_text_failed" });
    const evidence = events(mem).map((e) => ({ event_type: String(e.event_type), node_key: (e.node_key as string | null) ?? null, payload: (e.payload as Record<string, unknown>) ?? {}, created_at: String(e.created_at) }));
    expect(classifyStrandedRun(evidence)).toEqual({ kind: "ambiguous", nodeKey: "m1" });
  });

  it("interrupted AFTER Meta accepted (the message row cannot be stored): not sent a second time, intent stays unconfirmed", async () => {
    const mem = setup({ failInsert: (table) => (table === "messages" ? { message: "db down" } : undefined) });
    await say("hola");
    expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(intents(mem).map((e) => e.node_key)).toEqual(["m1"]);
    expect(sent(mem)).toHaveLength(0);
    expect(errors(mem)).toContain("send_text_failed");
    expect(h.sendInteractiveButtons).not.toHaveBeenCalled();
  });

  it("a failed buttons send leaves evidence (intent + error) instead of a silent stuck run, and is attempted once", async () => {
    const mem = setup();
    h.sendInteractiveButtons.mockRejectedValue(networkError());
    await say("hola");
    expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(h.sendInteractiveButtons).toHaveBeenCalledTimes(1);
    expect(intents(mem).map((e) => e.node_key)).toEqual(["m1", "menu"]);
    expect(sent(mem).map((e) => e.node_key)).toEqual(["m1"]);
    expect(errors(mem)).toContain("send_interactive_failed");
  });

  it("a reprompt is also preceded by its intent; without the intent the prompt is not re-sent", async () => {
    const mem = setup({}, [waitingRun()]);
    await say("no entiendo");
    expect(h.sendInteractiveButtons).toHaveBeenCalledTimes(1);
    const reprompts = intents(mem).filter((e) => (e.payload as Row).reprompt === true);
    expect(reprompts.map((e) => e.node_key)).toEqual(["menu"]);
    expect(events(mem).indexOf(reprompts[0])).toBeLessThan(events(mem).indexOf(sent(mem)[0]));

    const blocked = setup(failIntent, [waitingRun()]);
    h.sendInteractiveButtons.mockClear();
    await say("no entiendo", "A", "wamid.IN2");
    expect(h.sendInteractiveButtons).not.toHaveBeenCalled();
    expect(blocked.table("flow_runs").find((r) => r.id === "run-1")).toMatchObject({ status: "failed", end_reason: "send_intent_not_recorded" });
  });

  it("intents stay inside their own account's run (no cross-account evidence, no cross-account send)", async () => {
    const mem = setup();
    await say("buenas", "B");
    const runsB = mem.table("flow_runs").filter((r) => r.account_id === B);
    expect(runsB).toHaveLength(1);
    expect(mem.table("flow_runs").filter((r) => r.account_id === A)).toHaveLength(0);
    expect(intents(mem).every((e) => e.flow_run_id === runsB[0].id && (e.payload as Row).flow_id === "flow-2")).toBe(true);
    expect(intents(mem)).toHaveLength(2);
    expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(h.sendTextMessage.mock.calls[0][0]).toMatchObject({ phoneNumberId: "pn-2" });
  });
});
