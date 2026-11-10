import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================
// Recovery selection (D1). Production shape on 2026-11-10: 69 runs legitimately waiting for a button tap plus ONE run stranded on its
// first node. The old query (25 oldest quiet runs) always returned 25 waiting runs, so the stranded one (rank 67 of 70) was never seen.
// Simulated Meta, in-memory database, no real sends. Nothing here may touch a real run.
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

import { RECOVERY_MAX_AGE_SECONDS, recoverStrandedRuns, recoveryModeFromEnv } from "./engine";
import { createMemoryDb, type Row } from "./test-support/memory-db";

const A = "046ff8c2-1111-4222-8333-444455556666";
const B = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const NOW = Date.parse("2026-11-10T15:00:00Z");
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

const nodes = (flow: string): Row[] => [
  { flow_id: flow, node_key: "start", node_type: "start", config: { next_node_key: "m1" } },
  { flow_id: flow, node_key: "m1", node_type: "send_message", config: { text: "Hola", next_node_key: "menu" } },
  { flow_id: flow, node_key: "menu", node_type: "send_buttons", config: { text: "¿Qué necesitas?", buttons: [{ reply_id: "b1", title: "Precio", next_node_key: "fin" }] } },
  { flow_id: flow, node_key: "fin", node_type: "end", config: {} },
];
const run = (id: string, over: Row = {}): Row => ({
  id, flow_id: "flow-1", account_id: A, user_id: "u-1", contact_id: `ct-${id}`, conversation_id: `cv-${id}`, status: "active", vars: {},
  reprompt_count: 0, started_at: ago(900), last_advanced_at: ago(600), current_node_key: "menu", wait_until: null, ...over,
});
const waiting = (n: number, ageSeconds = 600): Row[] => Array.from({ length: n }, (_, i) => run(`w${i}`, { last_advanced_at: ago(ageSeconds + i) }));

function setup(runs: Row[], extra: Record<string, Row[]> = {}) {
  const all = [...runs];
  const mem = createMemoryDb({
    flows: [{ id: "flow-1", account_id: A, user_id: "u-1", status: "active", trigger_type: "keyword", trigger_config: { keywords: ["hola"] }, entry_node_id: "start" }, { id: "flow-2", account_id: B, user_id: "u-2", status: "active", trigger_type: "keyword", trigger_config: { keywords: ["x"] }, entry_node_id: "start" }],
    flow_nodes: [...nodes("flow-1"), ...nodes("flow-2")],
    contacts: all.map((r) => ({ id: r.contact_id, account_id: r.account_id, name: "Ana", phone: "+15551234567", blocked: false })),
    conversations: all.map((r) => ({ id: r.conversation_id, account_id: r.account_id, user_id: r.user_id })),
    whatsapp_config: [{ account_id: A, phone_number_id: "pn-1", access_token: "token-a" }, { account_id: B, phone_number_id: "pn-2", access_token: "token-b" }],
    flow_runs: all, ...extra,
  });
  h.db = mem.client;
  return mem;
}
const snapshot = (mem: ReturnType<typeof setup>) => JSON.stringify({ r: mem.table("flow_runs"), e: mem.table("flow_run_events"), m: mem.table("messages") });
const sends = () => h.sendTextMessage.mock.calls.length + h.sendInteractiveButtons.mock.calls.length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(NOW));
  h.sendTextMessage.mockReset().mockResolvedValue({ messageId: "wamid.TXT" });
  h.sendInteractiveButtons.mockReset().mockResolvedValue({ messageId: "wamid.BTN" });
  vi.spyOn(console, "error").mockImplementation(() => {});
  delete process.env.FLOW_RECOVERY_ACTIVE;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); delete process.env.FLOW_RECOVERY_ACTIVE; });

describe("recovery selection without starvation (69 legitimate waits + 1 stranded run)", () => {
  it("dry-run finds the stranded run behind 69 waiting ones and changes nothing", async () => {
    const mem = setup([...waiting(69), run("stuck", { current_node_key: "start", last_advanced_at: ago(602) })]);
    const before = snapshot(mem);
    const summary = await recoverStrandedRuns({ accountIds: [A], limit: 25 });
    expect(summary).toMatchObject({ mode: "dry-run", candidates: 70, waiting: 69, eligible: 1, would_resume: 1, resumed: 0, too_old: 0, truncated: false });
    expect(snapshot(mem)).toBe(before);
    expect(sends()).toBe(0);
  });

  it("the same pass in the old way would have seen only waiting runs (guard against reintroducing the 25-oldest query)", async () => {
    const mem = setup([...waiting(69), run("stuck", { current_node_key: "start", last_advanced_at: ago(602) })]);
    const oldest25 = mem.table("flow_runs").sort((x, y) => String(x.last_advanced_at).localeCompare(String(y.last_advanced_at))).slice(0, 25);
    expect(oldest25.every((r) => r.current_node_key === "menu")).toBe(true);
    expect(oldest25.some((r) => r.id === "stuck")).toBe(false);
    const summary = await recoverStrandedRuns({ accountIds: [A], limit: 25 });
    expect(summary.would_resume).toBe(1);
  });

  it("default mode is dry-run; only FLOW_RECOVERY_ACTIVE=true activates", () => {
    expect(recoveryModeFromEnv()).toBe("dry-run");
    process.env.FLOW_RECOVERY_ACTIVE = "yes"; expect(recoveryModeFromEnv()).toBe("dry-run");
    process.env.FLOW_RECOVERY_ACTIVE = "true"; expect(recoveryModeFromEnv()).toBe("active");
  });
});

describe("max age (30 min): older runs are excluded from automatic recovery and reported, never modified", () => {
  it("cannot expand D1 30-minute maximum via caller overrides", async () => {
    const mem = setup([run("too-old-override", { current_node_key: "start", last_advanced_at: ago(3 * 3600) })]);
    const before = snapshot(mem);
    const summary = await recoverStrandedRuns({ accountIds: [A], mode: "active", minAgeSeconds: 60, maxAgeSeconds: 4 * 3600 });
    expect(summary).toMatchObject({ mode: "active", too_old: 1, resumed: 0, would_resume: 0 });
    expect(snapshot(mem)).toBe(before);
    expect(sends()).toBe(0);
  });

  it("a 3-hour-old stranded run (the 4bb8a367 shape) is listed for review, with its evidence, and left exactly as it is, in both modes", async () => {
    expect(RECOVERY_MAX_AGE_SECONDS).toBe(1800);
    const mem = setup([...waiting(69, 3 * 3600), run("stuck", { current_node_key: "start", last_advanced_at: ago(3 * 3600) })], { flow_run_events: [{ id: "ev-1", flow_run_id: "stuck", event_type: "node_entered", node_key: "send_buttons", payload: {}, created_at: ago(3 * 3600 - 1) }] });
    const before = snapshot(mem);
    for (const mode of ["dry-run", "active"] as const) {
      const summary = await recoverStrandedRuns({ accountIds: [A], mode });
      expect(summary).toMatchObject({ mode, candidates: 70, waiting: 69, eligible: 0, too_old: 1, resumed: 0, would_resume: 0 });
      expect(summary.review).toEqual([expect.objectContaining({ run_id: "stuck", reason: "too_old", node_key: "start", evidence: "recoverable" })]);
      expect(summary.review![0].age_s).toBeGreaterThanOrEqual(3 * 3600 - 1);
      expect(snapshot(mem)).toBe(before);
      expect(sends()).toBe(0);
    }
    expect(mem.table("flow_runs").find((r) => r.id === "stuck")).toMatchObject({ status: "active" });
  });

  it("age alone is not enough: a young run with an unconfirmed send is not recoverable (reported as not_safe in dry-run)", async () => {
    const mem = setup([run("amb", { current_node_key: "m1", last_advanced_at: ago(600) })], { flow_run_events: [{ id: "ev-1", flow_run_id: "amb", event_type: "node_entered", node_key: "m1", payload: { reason: "send_intent" }, created_at: ago(599) }] });
    const before = snapshot(mem);
    const summary = await recoverStrandedRuns({ accountIds: [A] });
    expect(summary).toMatchObject({ eligible: 1, would_resume: 0, ambiguous: 1 });
    expect(summary.review).toEqual([expect.objectContaining({ run_id: "amb", reason: "not_safe", evidence: "ambiguous" })]);
    expect(snapshot(mem)).toBe(before);
  });

  it("a bot message after the cursor that no message_sent event accounts for blocks recovery", async () => {
    const mem = setup([run("out", { current_node_key: "start", last_advanced_at: ago(600) })], { messages: [{ id: "m-1", conversation_id: "cv-out", sender_type: "bot", created_at: ago(590) }] });
    const before = snapshot(mem);
    const dry = await recoverStrandedRuns({ accountIds: [A] });
    expect(dry).toMatchObject({ would_resume: 0, unsafe: 1 });
    expect(dry.review).toEqual([expect.objectContaining({ run_id: "out", reason: "not_safe", evidence: "outbound_since_cursor" })]);
    expect(snapshot(mem)).toBe(before);
    const active = await recoverStrandedRuns({ accountIds: [A], mode: "active" });
    expect(active.unsafe).toBe(1);
    expect(sends()).toBe(0);
    expect(mem.table("flow_runs").find((r) => r.id === "out")).toMatchObject({ status: "failed", end_reason: "recovery_not_safe" });
  });
});

describe("active mode (only with explicit activation)", () => {
  it("resumes the stranded run exactly once, leaves the 69 waits alone, and a second pass does nothing", async () => {
    const mem = setup([...waiting(69), run("stuck", { current_node_key: "start", last_advanced_at: ago(602) })]);
    const first = await recoverStrandedRuns({ accountIds: [A], mode: "active" });
    expect(first).toMatchObject({ mode: "active", waiting: 69, eligible: 1, resumed: 1 });
    expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(h.sendInteractiveButtons).toHaveBeenCalledTimes(1);
    expect(mem.table("flow_runs").filter((r) => String(r.id).startsWith("w")).every((r) => r.status === "active" && r.current_node_key === "menu")).toBe(true);
    const second = await recoverStrandedRuns({ accountIds: [A], mode: "active" });
    expect(second.resumed).toBe(0);
    expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it("is isolated by account: a stranded run of another account is neither selected nor touched", async () => {
    const mem = setup([run("a1", { current_node_key: "start", last_advanced_at: ago(700) }), run("b1", { account_id: B, flow_id: "flow-2", user_id: "u-2", current_node_key: "start", last_advanced_at: ago(700) })]);
    const summary = await recoverStrandedRuns({ accountIds: [A], mode: "active" });
    expect(summary.resumed).toBe(1);
    expect(mem.table("flow_runs").find((r) => r.id === "b1")).toMatchObject({ status: "active", current_node_key: "start" });
    expect(h.sendTextMessage.mock.calls.every((c) => (c[0] as { phoneNumberId?: string }).phoneNumberId === "pn-1")).toBe(true);
  });

  it("no accounts enabled: nothing is read", async () => {
    setup([run("x", { current_node_key: "start" })]);
    expect(await recoverStrandedRuns({ accountIds: [] })).toMatchObject({ candidates: 0, examined: 0 });
  });
});
