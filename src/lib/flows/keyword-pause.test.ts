import { beforeEach, describe, expect, it, vi } from "vitest";

// Per-contact pause of KEYWORD automation (contact_automation_settings): what it blocks (keyword entry, keyword replacement of a waiting run) and what it
// must not (manual start, replies to an active run, other contacts, non-keyword entries, run state). A contact keeps ONE active run (idx_one_active_run_per_contact). The only thing under test here is who may free that slot: a run parked on a
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
    settings: [] as Row[],
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
    : table === "contact_automation_settings" ? state.settings
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

import { dispatchInboundToFlows, startFlowManually } from "./engine";
import type { ParsedInbound } from "./types";

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
  Object.assign(h.state, { flows: [], flowNodes: [], conversations: [], contacts: [], flowRuns: [], flowRunEvents: [], settings: [], nextRunId: 1, failNextRunInsert: false, raceRunBeforeInsert: null, beforeInterrupt: null });
  h.state.contacts.push({ id: CONTACT, account_id: ACCOUNT, name: "Keyler", phone: "51939665944", blocked: false });
  h.state.conversations.push({ id: CONVERSATION, account_id: ACCOUNT, contact_id: CONTACT });
  recipient.resolveContactTarget.mockReset();
  recipient.resolveContactTarget.mockResolvedValue({ kind: "phone", phone: "51939665944" });
});


const pause = (contact = CONTACT, paused = true) => h.state.settings.push({ contact_id: contact, account_id: ACCOUNT, keyword_automations_paused: paused });

describe("keyword automations paused per contact", () => {
  it("1. not paused: the keyword starts its flow", async () => {
    seedFlow("flow-b", { trigger_config: { keywords: ["amoladora"] } });
    expect(await dispatch(text("info sobre amoladora"))).toMatchObject({ consumed: true, outcome: "started" });
    expect(activeOf(CONTACT)).toHaveLength(1);
  });

  it("2. paused: the keyword starts nothing and the message is not consumed", async () => {
    seedFlow("flow-b", { trigger_config: { keywords: ["amoladora"] } });
    pause();
    expect(await dispatch(text("info sobre amoladora"))).toEqual({ consumed: false, outcome: "no_match" });
    expect(h.state.flowRuns).toHaveLength(0);
  });

  it("3. resumed (paused=false): the keyword starts the flow again", async () => {
    seedFlow("flow-b", { trigger_config: { keywords: ["amoladora"] } });
    pause(CONTACT, false);
    expect(await dispatch(text("amoladora"))).toMatchObject({ consumed: true, outcome: "started" });
  });

  it("4. paused: a manual start still works", async () => {
    seedFlow("flow-b"); pause();
    expect((await startManual("flow-b")).outcome).toBe("started");
    expect(activeOf(CONTACT)).toHaveLength(1);
  });

  it("5. waiting Flow A + keyword of Flow B: replaced when active, left alone when paused", async () => {
    seedFlow("flow-a"); seedFlow("flow-b", { trigger_config: { keywords: ["taladro"] } });
    seedRun("run-a", "flow-a");
    expect(await dispatch(text("taladro inalambrico"))).toMatchObject({ consumed: true });
    expect(run("run-a")).toMatchObject({ status: "paused_by_agent", end_reason: "replaced_by_keyword_flow" });

    h.state.flowRuns = [];
    seedRun("run-a2", "flow-a");
    pause();
    const result = await dispatch(text("taladro inalambrico"));
    expect(result.outcome).toBe("waiting");
    expect(run("run-a2")).toMatchObject({ status: "active", end_reason: null, wait_until: FAR_FUTURE, wait_node_key: "wait" });
    expect(h.state.flowRuns).toHaveLength(1);
  });

  it("8. paused: a button tap on a running flow still advances it", async () => {
    seedFlow("flow-a"); seedRunning("run-a", "flow-a"); pause();
    const result = await dispatch({ kind: "interactive_reply", reply_id: "a", reply_title: "A", meta_message_id: "wamid-tap" });
    expect(result.consumed).toBe(true);
    expect(run("run-a").status).not.toBe("paused_by_agent");
  });

  it("10. isolation: Angelo paused, Keyler active", async () => {
    seedFlow("flow-b", { trigger_config: { keywords: ["amoladora"] } });
    pause(OTHER_CONTACT);
    expect(await dispatch(text("amoladora"))).toMatchObject({ consumed: true, outcome: "started" });
    const paused = await dispatchInboundToFlows({ accountId: ACCOUNT, userId: "u", contactId: OTHER_CONTACT, conversationId: "conv-2", message: text("amoladora"), isFirstInboundMessage: false });
    expect(paused).toEqual({ consumed: false, outcome: "no_match" });
    expect(activeOf(OTHER_CONTACT)).toHaveLength(0);
  });

  it("a pause row of another account does not pause this one", async () => {
    seedFlow("flow-b", { trigger_config: { keywords: ["amoladora"] } });
    h.state.settings.push({ contact_id: CONTACT, account_id: "acct-other", keyword_automations_paused: true });
    expect(await dispatch(text("amoladora"))).toMatchObject({ outcome: "started" });
  });

  it("paused: a first-inbound-message flow (not keyword driven) still starts", async () => {
    seedFlow("flow-welcome", { trigger_type: "first_inbound_message", trigger_config: {} });
    pause();
    const first = await dispatchInboundToFlows({ accountId: ACCOUNT, userId: "u", contactId: CONTACT, conversationId: CONVERSATION, message: text("hola"), isFirstInboundMessage: true });
    expect(first).toMatchObject({ consumed: true, outcome: "started" });
  });

  it("paused: a keyword flow does not start even when a first-inbound flow is also configured but this is not the first message", async () => {
    seedFlow("flow-welcome", { trigger_type: "first_inbound_message", trigger_config: {} });
    seedFlow("flow-b", { trigger_config: { keywords: ["amoladora"] } });
    pause();
    expect(await dispatch(text("amoladora"))).toEqual({ consumed: false, outcome: "no_match" });
  });
});
