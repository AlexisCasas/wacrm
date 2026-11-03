import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A contact keeps ONE active run (idx_one_active_run_per_contact). The only thing under test here is who may free that slot: a run parked on a
// durable delay can be replaced by a DIFFERENT flow chosen by hand or selected by a keyword; any other run keeps the protection. The in-memory
// database below enforces the unique index and answers claim_due_flow_waits with the same predicate as migration 069, so "exactly one active run"
// and "the old run cannot be claimed again" are asserted on state, not on call counts.

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  state: {
    flows: [] as Row[],
    flowNodes: [] as Row[],
    conversations: [] as Row[],
    contacts: [] as Row[],
    flowRuns: [] as Row[],
    flowRunEvents: [] as Row[],
    nextRunId: 1,
    failNextRunInsert: false,
    /** Runs inserted by "another worker" right before the next flow_runs INSERT (a concurrent start that wins the slot). */
    raceRunBeforeInsert: null as Row | null,
    /** Hook run once right before the next conditional UPDATE of an active run (a worker claiming the wait first). */
    beforeInterrupt: null as (() => void) | null,
  },
}));
const recipient = vi.hoisted(() => {
  class BsuidSendBlockedError extends Error { constructor(readonly code: string) { super(code) } }
  class ContactRecipientUnavailableError extends Error { constructor() { super("contact not found for this account") } }
  return { BsuidSendBlockedError, ContactRecipientUnavailableError, resolveContactTarget: vi.fn() };
});
vi.mock("@/lib/whatsapp/recipient", () => recipient);

vi.mock("./admin-client", () => {
  const { state } = h;
  const tableRows = (table: string): Row[] =>
    table === "flows" ? state.flows
    : table === "flow_nodes" ? state.flowNodes
    : table === "conversations" ? state.conversations
    : table === "contacts" ? state.contacts
    : table === "flow_runs" ? state.flowRuns
    : table === "flow_run_events" ? state.flowRunEvents
    : [];
  const activeFor = (account: unknown, contact: unknown, except?: Row) =>
    state.flowRuns.some((r) => r !== except && r.status === "active" && r.account_id === account && r.contact_id === contact);

  function builder(table: string) {
    const preds: Array<(r: Row) => boolean> = [];
    let type = "select";
    let payload: Row = {};
    let wantsRows = false;
    let limitN: number | undefined;

    function run(): { data: unknown; error: unknown; count?: number } {
      const rows = tableRows(table);
      if (type === "insert") {
        if (table === "flow_runs") {
          if (state.failNextRunInsert) { state.failNextRunInsert = false; return { data: null, error: { message: "connection reset" } }; }
          if (state.raceRunBeforeInsert) { state.flowRuns.push(state.raceRunBeforeInsert); state.raceRunBeforeInsert = null; }
          if (payload.status === "active" && activeFor(payload.account_id, payload.contact_id)) {
            return { data: null, error: { message: "duplicate key value violates unique constraint 23505" } };
          }
          const row: Row = { id: `run-${state.nextRunId++}`, started_at: new Date().toISOString(), ended_at: null, end_reason: null, reprompt_count: 0, last_prompt_message_id: null, wait_until: null, wait_node_key: null, wait_claim_token: null, current_flow_id: null, ...payload };
          state.flowRuns.push(row);
          return { data: row, error: null };
        }
        rows.push(payload);
        return { data: null, error: null };
      }
      const matched = rows.filter((r) => preds.every((p) => p(r)));
      if (type === "update") {
        if (table === "flow_runs" && payload.status === "paused_by_agent" && state.beforeInterrupt) { const hook = state.beforeInterrupt; state.beforeInterrupt = null; hook(); }
        const live = rows.filter((r) => preds.every((p) => p(r)));
        for (const r of live) {
          if (table === "flow_runs" && payload.status === "active" && activeFor(r.account_id, r.contact_id, r)) {
            return { data: null, error: { message: "duplicate key value violates unique constraint 23505" } };
          }
          Object.assign(r, payload);
        }
        return { data: wantsRows ? live.map((r) => ({ id: r.id })) : null, error: null };
      }
      return { data: limitN !== undefined ? matched.slice(0, limitN) : matched, error: null, count: matched.length };
    }

    const b: Record<string, unknown> = {
      select: () => ((wantsRows = true), b),
      insert: (p: Row) => ((type = "insert"), (payload = p), b),
      update: (p: Row) => ((type = "update"), (payload = p), b),
      eq: (k: string, v: unknown) => (preds.push((r) => r[k] === v), b),
      in: (k: string, v: unknown[]) => (preds.push((r) => v.includes(r[k])), b),
      is: (k: string, v: null) => (preds.push((r) => (r[k] ?? null) === v), b),
      not: (k: string, op: string, v: null) => (preds.push((r) => (op === "is" && v === null ? r[k] != null : true)), b),
      filter: (col: string, _op: string, v: unknown) => (preds.push((r) => (col === "payload->>meta_message_id" ? (r.payload as Row | undefined)?.meta_message_id === v : true)), b),
      order: () => b,
      limit: (n: number) => ((limitN = n), b),
      maybeSingle: () => { const out = run(); return Promise.resolve({ ...out, data: Array.isArray(out.data) ? (out.data[0] ?? null) : out.data }); },
      single: () => { const out = run(); return Promise.resolve({ ...out, data: Array.isArray(out.data) ? (out.data[0] ?? null) : out.data }); },
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(run()).then(onF, onR),
    };
    return b;
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => builder(t),
      rpc: (name: string, args: Row) => {
        if (name === "claim_due_flow_waits") {
          // Same predicate as supabase/migrations/069_flow_durable_waits.sql.
          const due = state.flowRuns.filter((r) => r.status === "active" && r.wait_until != null && new Date(r.wait_until as string).getTime() <= Date.now() && (args.p_account_ids as string[]).includes(r.account_id as string) && r.wait_claim_token == null);
          return Promise.resolve({ data: due.map((r) => ({ run_id: r.id })), error: null });
        }
        return Promise.resolve({ data: name === "verify_flow_run_stack" ? { ok: true } : null, error: null });
      },
    }),
  };
});

vi.mock("./meta-send", () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
  engineSendInteractiveButtons: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
  engineSendInteractiveList: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
}));

import { dispatchInboundToFlows, isReplaceableWaitingRun, startFlowManually } from "./engine";
import type { FlowRunRow, ParsedInbound } from "./types";

const ACCOUNT = "acct-1";
const CONTACT = "contact-1";
const OTHER_CONTACT = "contact-2";
const CONVERSATION = "conv-1";
const FAR_FUTURE = "2099-01-01T00:00:00.000Z";

function seedFlow(id: string, overrides: Row = {}) {
  h.state.flows.push({
    id, account_id: ACCOUNT, user_id: "author", name: id, description: null, status: "active", trigger_type: "keyword",
    trigger_config: { keywords: [`kw-${id}`] }, entry_node_id: "ask", fallback_policy: { type: "end" },
    created_at: `2026-01-0${h.state.flows.length + 1}T00:00:00Z`, ...overrides,
  });
  // The entry node suspends on a prompt, so a run of this flow stays `active` after it starts.
  h.state.flowNodes.push({ flow_id: id, node_key: "ask", node_type: "send_buttons", config: { text: "Elige", buttons: [{ reply_id: "a", title: "A", next_node_key: "end" }], fallback_node_key: "end" } });
  h.state.flowNodes.push({ flow_id: id, node_key: "end", node_type: "end", config: {} });
}

/** A run of `flowId` parked on a durable delay (the shape schedule_flow_wait writes). */
function seedRun(id: string, flowId: string, overrides: Row = {}): Row {
  const run: Row = {
    id, flow_id: flowId, account_id: ACCOUNT, user_id: "author", contact_id: CONTACT, conversation_id: CONVERSATION, status: "active",
    current_node_key: "wait", wait_node_key: "wait", wait_until: FAR_FUTURE, wait_claim_token: null, wait_claimed_at: null, current_flow_id: null,
    vars: {}, reprompt_count: 0, started_at: "2026-02-01T00:00:00Z", last_advanced_at: "2026-02-01T00:00:00Z", ended_at: null, end_reason: null, last_prompt_message_id: null,
    ...overrides,
  };
  h.state.flowRuns.push(run);
  return run;
}
const seedRunning = (id: string, flowId: string, overrides: Row = {}) =>
  seedRun(id, flowId, { current_node_key: "ask", wait_node_key: null, wait_until: null, ...overrides });

let messageSeq = 0;
const text = (body: string): ParsedInbound => ({ kind: "text", text: body, meta_message_id: `wamid-${body}-${++messageSeq}` });
const dispatch = (message: ParsedInbound, restrictToFlowIds?: string[]) =>
  dispatchInboundToFlows({ accountId: ACCOUNT, userId: "u", contactId: CONTACT, conversationId: CONVERSATION, message, isFirstInboundMessage: false, restrictToFlowIds });
const startManual = (flowId: string) => startFlowManually({ accountId: ACCOUNT, initiatedByUserId: "agent", flowId, conversationId: CONVERSATION });
const run = (id: string) => h.state.flowRuns.find((r) => r.id === id)!;
const activeOf = (contact: string) => h.state.flowRuns.filter((r) => r.contact_id === contact && r.status === "active");

beforeEach(() => {
  Object.assign(h.state, { flows: [], flowNodes: [], conversations: [], contacts: [], flowRuns: [], flowRunEvents: [], nextRunId: 1, failNextRunInsert: false, raceRunBeforeInsert: null, beforeInterrupt: null });
  h.state.contacts.push({ id: CONTACT, account_id: ACCOUNT, name: "Keyler", phone: "51939665944", blocked: false });
  h.state.conversations.push({ id: CONVERSATION, account_id: ACCOUNT, contact_id: CONTACT });
  recipient.resolveContactTarget.mockReset();
  recipient.resolveContactTarget.mockResolvedValue({ kind: "phone", phone: "51939665944" });
});

describe("isReplaceableWaitingRun", () => {
  const waiting = () => seedRun("r", "flow-a") as unknown as FlowRunRow;
  it("accepts only an active run parked on a durable delay of its own flow", () => {
    expect(isReplaceableWaitingRun(waiting())).toBe(true);
  });
  it.each([
    ["not parked", { wait_until: null, wait_node_key: null, current_node_key: "ask" }],
    ["wait claimed by a worker", { wait_claim_token: "tok", wait_claimed_at: "2026-02-01T00:00:00Z" }],
    ["inside a called flow", { current_flow_id: "flow-sub" }],
    ["parked on another node than the one it is at", { current_node_key: "other" }],
    ["not active", { status: "paused_by_agent" }],
  ])("rejects a run that is %s", (_label, patch) => {
    expect(isReplaceableWaitingRun({ ...waiting(), ...patch } as unknown as FlowRunRow)).toBe(false);
  });
});

describe("manual start", () => {
  it("1. without an active run Flow B starts as before", async () => {
    seedFlow("flow-b");
    const result = await startManual("flow-b");
    expect(result.outcome).toBe("started");
    expect(activeOf(CONTACT)).toHaveLength(1);
    expect((result as { replaced_flow_run_id?: string }).replaced_flow_run_id).toBeUndefined();
  });

  it("2. a running (not parked) Flow A still blocks Flow B", async () => {
    seedFlow("flow-a"); seedFlow("flow-b"); seedRunning("run-a", "flow-a");
    const result = await startManual("flow-b");
    expect(result).toMatchObject({ outcome: "active_flow_exists", active_flow_run_id: "run-a", active_flow_id: "flow-a" });
    expect(run("run-a").status).toBe("active");
    expect(h.state.flowRuns).toHaveLength(1);
  });

  it("3. a parked Flow A is replaced by a valid Flow B: A paused with an audit reason, B active, one active run", async () => {
    seedFlow("flow-a"); seedFlow("flow-b"); seedRun("run-a", "flow-a");
    const result = await startManual("flow-b");
    expect(result).toMatchObject({ outcome: "started", flow_id: "flow-b", replaced_flow_run_id: "run-a" });
    expect(run("run-a")).toMatchObject({ status: "paused_by_agent", end_reason: "replaced_by_manual_flow", wait_node_key: "wait", wait_until: FAR_FUTURE });
    expect(run("run-a").ended_at).toBeTruthy();
    expect(activeOf(CONTACT)).toHaveLength(1);
    expect(activeOf(CONTACT)[0]).toMatchObject({ flow_id: "flow-b" });
    const started = h.state.flowRunEvents.find((e) => e.event_type === "started");
    expect(started?.payload).toMatchObject({ trigger_source: "manual", replaced_run_id: "run-a", replaced_flow_id: "flow-a", replaced_reason: "replaced_by_manual_flow" });
  });

  it("4a. an inactive Flow B does not close Flow A", async () => {
    seedFlow("flow-a"); seedFlow("flow-b", { status: "draft" }); seedRun("run-a", "flow-a");
    expect((await startManual("flow-b")).outcome).toBe("flow_not_active");
    expect(run("run-a")).toMatchObject({ status: "active", end_reason: null });
  });

  it("4b. a Flow B whose entry node is missing does not close Flow A", async () => {
    seedFlow("flow-a"); seedFlow("flow-b"); seedRun("run-a", "flow-a");
    h.state.flowNodes = h.state.flowNodes.filter((n) => !(n.flow_id === "flow-b" && n.node_key === "ask"));
    expect((await startManual("flow-b")).outcome).toBe("flow_not_active");
    expect(run("run-a")).toMatchObject({ status: "active", end_reason: null });
  });

  it("4c. a Flow B refused by the recipient / BSUID preflight does not close Flow A", async () => {
    seedFlow("flow-a"); seedFlow("flow-b"); seedRun("run-a", "flow-a");
    recipient.resolveContactTarget.mockRejectedValueOnce(new recipient.BsuidSendBlockedError("bsuid_flow_not_authorized"));
    expect(await startManual("flow-b")).toEqual({ outcome: "bsuid_flow_not_authorized" });
    expect(run("run-a")).toMatchObject({ status: "active", end_reason: null });
    expect(h.state.flowRuns).toHaveLength(1);
  });

  it("5. the same Flow requested while parked keeps the current conflict", async () => {
    seedFlow("flow-a"); seedRun("run-a", "flow-a");
    expect(await startManual("flow-a")).toMatchObject({ outcome: "active_flow_exists", active_flow_run_id: "run-a" });
    expect(run("run-a")).toMatchObject({ status: "active", end_reason: null });
  });

  it("a wait claimed by a worker (being resumed) or parked inside a called flow still blocks", async () => {
    seedFlow("flow-a"); seedFlow("flow-b");
    seedRun("run-a", "flow-a", { wait_claim_token: "tok", wait_claimed_at: "2026-02-01T00:00:00Z" });
    expect((await startManual("flow-b")).outcome).toBe("active_flow_exists");
    run("run-a").status = "completed";
    seedRun("run-sub", "flow-a", { current_flow_id: "flow-sub" });
    expect((await startManual("flow-b")).outcome).toBe("active_flow_exists");
  });

  it("when Flow B cannot be created the parked Flow A is put back (the contact never ends with none)", async () => {
    seedFlow("flow-a"); seedFlow("flow-b"); seedRun("run-a", "flow-a");
    h.state.failNextRunInsert = true;
    expect((await startManual("flow-b")).outcome).toBe("error");
    expect(run("run-a")).toMatchObject({ status: "active", end_reason: null, ended_at: null, wait_until: FAR_FUTURE });
    expect(activeOf(CONTACT)).toHaveLength(1);
  });

  it("when another start wins the slot in between, there is still exactly one active run and Flow A stays closed", async () => {
    seedFlow("flow-a"); seedFlow("flow-b"); seedRun("run-a", "flow-a");
    h.state.raceRunBeforeInsert = { id: "run-x", flow_id: "flow-b", account_id: ACCOUNT, contact_id: CONTACT, status: "active", user_id: "author", vars: {} };
    expect((await startManual("flow-b")).outcome).toBe("active_flow_exists");
    expect(activeOf(CONTACT)).toHaveLength(1);
    expect(activeOf(CONTACT)[0].id).toBe("run-x");
    expect(run("run-a").status).toBe("paused_by_agent");
  });

  it("when the wait was claimed between the read and the swap nothing changes", async () => {
    seedFlow("flow-a"); seedFlow("flow-b"); seedRun("run-a", "flow-a");
    h.state.beforeInterrupt = () => { run("run-a").wait_claim_token = "tok"; };
    expect((await startManual("flow-b")).outcome).toBe("active_flow_exists");
    expect(run("run-a")).toMatchObject({ status: "active", end_reason: null });
    expect(h.state.flowRuns).toHaveLength(1);
  });

  it("preserves the phone path: the preflight runs for the new flow with the contact's phone", async () => {
    seedFlow("flow-a"); seedFlow("flow-b"); seedRun("run-a", "flow-a");
    await startManual("flow-b");
    expect(recipient.resolveContactTarget).toHaveBeenCalledWith(expect.anything(), ACCOUNT, expect.objectContaining({ phone: "51939665944" }), { origin: "flow_preflight", flowId: "flow-b" });
  });
});

describe("automatic keyword start", () => {
  it("6. a normal message while parked stays a reply to Flow A", async () => {
    seedFlow("flow-a"); seedFlow("flow-b"); seedRun("run-a", "flow-a");
    const out = await dispatch(text("sí"));
    expect(out).toMatchObject({ consumed: false, flow_run_id: "run-a", outcome: "waiting" });
    expect(run("run-a")).toMatchObject({ status: "active", end_reason: null });
    expect(h.state.flowRunEvents.some((e) => e.event_type === "reply_received" && e.flow_run_id === "run-a")).toBe(true);
    expect(h.state.flowRuns).toHaveLength(1);
  });

  it("7. a valid keyword of another Flow closes A and starts B; exactly one active run remains", async () => {
    seedFlow("flow-a"); seedFlow("flow-b"); seedRun("run-a", "flow-a");
    const out = await dispatch(text("quiero kw-flow-b por favor"));
    expect(out).toMatchObject({ consumed: true, outcome: "started" });
    expect(run("run-a")).toMatchObject({ status: "paused_by_agent", end_reason: "replaced_by_keyword_flow" });
    expect(activeOf(CONTACT)).toHaveLength(1);
    expect(activeOf(CONTACT)[0]).toMatchObject({ flow_id: "flow-b" });
    const started = h.state.flowRunEvents.find((e) => e.event_type === "started");
    expect(started?.payload).toMatchObject({ replaced_run_id: "run-a", replaced_flow_id: "flow-a", replaced_reason: "replaced_by_keyword_flow", meta_message_id: expect.stringMatching(/^wamid-quiero kw-flow-b por favor-/) });
    expect(h.state.flowRunEvents.some((e) => e.event_type === "reply_received")).toBe(false);
  });

  it("8. a running (not parked) Flow A is never interrupted by a keyword", async () => {
    seedFlow("flow-a"); seedFlow("flow-b"); seedRunning("run-a", "flow-a");
    await dispatch(text("kw-flow-b"));
    expect(run("run-a")).toMatchObject({ status: "active", end_reason: null });
    expect(h.state.flowRuns.filter((r) => r.flow_id === "flow-b")).toHaveLength(0);
  });

  it("8b. a wait claimed by a worker, or parked in a called flow, is never interrupted by a keyword", async () => {
    seedFlow("flow-a"); seedFlow("flow-b");
    seedRun("run-a", "flow-a", { wait_claim_token: "tok", wait_claimed_at: "2026-02-01T00:00:00Z" });
    await dispatch(text("kw-flow-b"));
    expect(run("run-a").status).toBe("active");
    run("run-a").status = "completed";
    seedRun("run-sub", "flow-a", { current_flow_id: "flow-sub" });
    await dispatch(text("kw-flow-b"));
    expect(run("run-sub").status).toBe("active");
    expect(h.state.flowRuns.filter((r) => r.flow_id === "flow-b")).toHaveLength(0);
  });

  it("9. no keyword, an inactive flow, a manual-trigger flow, a first_inbound_message flow or a button tap never replace", async () => {
    seedFlow("flow-a"); seedFlow("flow-draft", { status: "draft", trigger_config: { keywords: ["precio"] } });
    seedFlow("flow-manual", { trigger_type: "manual", trigger_config: {} });
    seedFlow("flow-first", { trigger_type: "first_inbound_message", trigger_config: {} });
    seedFlow("flow-b"); seedRun("run-a", "flow-a");
    await dispatch(text("precio"));
    await dispatch(text("hola"));
    await dispatch({ kind: "interactive_reply", reply_id: "kw-flow-b", reply_title: "kw-flow-b", meta_message_id: "wamid-tap" });
    expect(run("run-a")).toMatchObject({ status: "active", end_reason: null });
    expect(h.state.flowRuns).toHaveLength(1);
  });

  it("the keyword of the Flow already parked is a plain reply, not a restart", async () => {
    seedFlow("flow-a"); seedRun("run-a", "flow-a");
    await dispatch(text("kw-flow-a"));
    expect(run("run-a")).toMatchObject({ status: "active", end_reason: null });
    expect(h.state.flowRuns).toHaveLength(1);
  });

  it("10. an ambiguous whole-word match picks nothing and does not close A", async () => {
    seedFlow("flow-a");
    seedFlow("flow-w1", { trigger_config: { keywords: ["jaen"], match_type: "word" } });
    seedFlow("flow-w2", { trigger_config: { keywords: ["jaen"], match_type: "word" } });
    seedRun("run-a", "flow-a");
    await dispatch(text("Jaén"));
    expect(run("run-a")).toMatchObject({ status: "active", end_reason: null });
    expect(h.state.flowRuns).toHaveLength(1);
  });

  it("a Flow B refused by the preflight (blocked contact, no recipient) does not close A", async () => {
    seedFlow("flow-a"); seedFlow("flow-b"); seedRun("run-a", "flow-a");
    recipient.resolveContactTarget.mockRejectedValueOnce(new recipient.ContactRecipientUnavailableError());
    await dispatch(text("kw-flow-b"));
    expect(run("run-a")).toMatchObject({ status: "active", end_reason: null });
    h.state.contacts[0].blocked = true;
    await dispatch(text("kw-flow-b"));
    expect(run("run-a")).toMatchObject({ status: "active", end_reason: null });
    expect(h.state.flowRuns).toHaveLength(1);
  });

  it("a Flow B that cannot be created puts A back and A keeps receiving the message as a reply", async () => {
    seedFlow("flow-a"); seedFlow("flow-b"); seedRun("run-a", "flow-a");
    h.state.failNextRunInsert = true;
    const out = await dispatch(text("kw-flow-b"));
    expect(out).toMatchObject({ consumed: false, outcome: "waiting" });
    expect(run("run-a")).toMatchObject({ status: "active", end_reason: null, ended_at: null });
    expect(activeOf(CONTACT)).toHaveLength(1);
  });

  it("11/13. other contacts are untouched and each contact keeps at most one active run", async () => {
    seedFlow("flow-a"); seedFlow("flow-b");
    seedRun("run-a", "flow-a");
    seedRun("run-other", "flow-a", { contact_id: OTHER_CONTACT, conversation_id: "conv-2" });
    const before = JSON.stringify(run("run-other"));
    await dispatch(text("kw-flow-b"));
    expect(JSON.stringify(run("run-other"))).toBe(before);
    expect(activeOf(CONTACT)).toHaveLength(1);
    expect(activeOf(OTHER_CONTACT)).toHaveLength(1);
  });

  it("12. the replaced run can no longer be claimed by claim_due_flow_waits", async () => {
    seedFlow("flow-a"); seedFlow("flow-b"); seedRun("run-a", "flow-a", { wait_until: "2020-01-01T00:00:00.000Z" });
    const { supabaseAdmin } = await import("./admin-client");
    const claimable = async () => ((await supabaseAdmin().rpc("claim_due_flow_waits", { p_account_ids: [ACCOUNT] })).data as unknown[]).length;
    expect(await claimable()).toBe(1);
    run("run-a").wait_claim_token = null;
    await dispatch(text("kw-flow-b"));
    expect(run("run-a").status).toBe("paused_by_agent");
    expect(await claimable()).toBe(0);
  });

  it("14. phone contact: the preflight is the existing one, for the selected flow", async () => {
    seedFlow("flow-a"); seedFlow("flow-b"); seedRun("run-a", "flow-a");
    await dispatch(text("kw-flow-b"));
    expect(recipient.resolveContactTarget).toHaveBeenCalledWith(expect.anything(), ACCOUNT, expect.objectContaining({ phone: "51939665944" }), { origin: "flow_preflight", flowId: "flow-b" });
  });

  it("15. BSUID contact: only authorized flows can replace, and an unauthorized active run is left alone", async () => {
    seedFlow("flow-a"); seedFlow("flow-b"); seedFlow("flow-c", { trigger_config: { keywords: ["kw-c"] } });
    seedRun("run-a", "flow-a");
    await dispatch(text("kw-c"), ["flow-a", "flow-b"]);
    expect(run("run-a")).toMatchObject({ status: "active", end_reason: null });
    recipient.resolveContactTarget.mockRejectedValueOnce(new recipient.BsuidSendBlockedError("bsuid_flow_not_authorized"));
    await dispatch(text("kw-flow-b"), ["flow-a", "flow-b"]);
    expect(run("run-a")).toMatchObject({ status: "active", end_reason: null });
    await dispatch(text("kw-flow-b"), ["flow-a", "flow-b"]);
    expect(run("run-a")).toMatchObject({ status: "paused_by_agent", end_reason: "replaced_by_keyword_flow" });
    expect(activeOf(CONTACT)).toHaveLength(1);
    run("run-a").status = "completed"; activeOf(CONTACT).forEach((r) => (r.status = "completed"));
    seedRun("run-unauth", "flow-c");
    await dispatch(text("kw-flow-b"), ["flow-a", "flow-b"]);
    expect(run("run-unauth")).toMatchObject({ status: "active", end_reason: null });
  });
});

describe("what keeps the old run from resuming", () => {
  it("durable-wait resumption only ever touches status = 'active' runs (migration 069)", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/069_flow_durable_waits.sql"), "utf8");
    const claim = sql.slice(sql.indexOf("FUNCTION public.claim_due_flow_waits"));
    expect(claim).toMatch(/WHERE r\.status = 'active' AND r\.wait_until IS NOT NULL AND r\.wait_until <= clock_timestamp\(\)/);
    const consume = sql.slice(sql.indexOf("FUNCTION public.consume_flow_wait"));
    expect(consume).toMatch(/WHERE r\.id = p_run_id AND r\.account_id = p_account_id AND r\.status = 'active'/);
  });
});
