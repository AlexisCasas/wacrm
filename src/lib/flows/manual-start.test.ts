import { describe, it, expect, beforeEach, vi } from "vitest";

// P0 — DISPARO MANUAL DE FLOW DESDE INBOX. This file covers ONLY
// `startFlowManually`, the shared-core reuse contract with the
// inbound dispatcher, and tenancy/conflict handling. `engine.test.ts`
// keeps the pure-helper coverage; this file needs a full
// service-role-client mock, so it's kept separate.
//
// Minimal fixture flows: every flow's entry node is an `end` node.
// `advanceFromNodeKey` logs `node_entered` -> `completed` and calls
// `endRun` immediately, so no `meta-send` mocking is needed for any
// of these scenarios — we only care about run creation + audit, not
// message delivery.

const h = vi.hoisted(() => ({
  state: {
    flows: [] as Record<string, unknown>[],
    flowNodes: [] as Record<string, unknown>[],
    conversations: [] as Record<string, unknown>[],
    contacts: [] as Record<string, unknown>[],
    flowRuns: [] as Record<string, unknown>[],
    flowRunEvents: [] as Record<string, unknown>[],
    execCountCalls: [] as string[],
    nextRunId: 1,
    forceInsertConflict: false,
  },
}));

vi.mock("./admin-client", () => {
  const { state } = h;

  function matches<T extends Record<string, unknown>>(
    rows: T[],
    filters: [string, unknown][],
  ): T[] {
    return rows.filter((r) => filters.every(([k, v]) => r[k] === v));
  }

  function resolve(ops: {
    table: string;
    type: string;
    payload?: unknown;
    filters: [string, unknown][];
  }) {
    const { table, type, payload, filters } = ops;

    // 'select' always returns the full matched array here — the
    // builder's terminal method (.maybeSingle()/.single() vs a bare
    // .then()) decides whether to collapse it to one row or hand back
    // the array. findEntryFlow's inbound scan needs the whole active
    // set; startFlowManually's lookups need a single row.
    if (table === "flows") {
      return { data: matches(state.flows, filters), error: null };
    }
    if (table === "flow_nodes") {
      return { data: matches(state.flowNodes, filters), error: null };
    }
    if (table === "conversations") {
      return { data: matches(state.conversations, filters), error: null };
    }
    if (table === "contacts") {
      return { data: matches(state.contacts, filters), error: null };
    }
    if (table === "flow_runs") {
      if (type === "insert") {
        if (state.forceInsertConflict) {
          state.forceInsertConflict = false;
          return {
            data: null,
            error: { message: "duplicate key value violates unique constraint 23505" },
          };
        }
        const row = {
          id: `run-${state.nextRunId++}`,
          started_at: new Date().toISOString(),
          last_advanced_at: new Date().toISOString(),
          ended_at: null,
          end_reason: null,
          reprompt_count: 0,
          last_prompt_message_id: null,
          ...(payload as Record<string, unknown>),
        };
        state.flowRuns.push(row);
        return { data: row, error: null };
      }
      if (type === "update") {
        for (const row of matches(state.flowRuns, filters)) {
          Object.assign(row, payload);
        }
        return { data: null, error: null };
      }
      return { data: matches(state.flowRuns, filters), error: null };
    }
    if (table === "flow_run_events") {
      if (type === "insert") {
        state.flowRunEvents.push(payload as Record<string, unknown>);
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    return { data: null, error: null };
  }

  function collapseToSingle(result: { data: unknown; error: unknown }) {
    if (Array.isArray(result.data)) {
      return { ...result, data: result.data[0] ?? null };
    }
    return result;
  }

  function builder(table: string) {
    const ops: {
      table: string;
      type: string;
      payload?: unknown;
      filters: [string, unknown][];
    } = { table, type: "select", filters: [] };
    let limitN: number | undefined;

    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((ops.type = "insert"), (ops.payload = p), b),
      update: (p: unknown) => ((ops.type = "update"), (ops.payload = p), b),
      eq: (k: string, v: unknown) => (ops.filters.push([k, v]), b),
      order: () => b,
      limit: (n: number) => ((limitN = n), b),
      maybeSingle: () => Promise.resolve(collapseToSingle(resolve(ops))),
      single: () => Promise.resolve(collapseToSingle(resolve(ops))),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
        const result = resolve(ops) as { data: unknown; error: unknown };
        if (limitN !== undefined && Array.isArray(result.data)) {
          result.data = result.data.slice(0, limitN);
        }
        return Promise.resolve(result).then(onF, onR);
      },
    };
    return b;
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => builder(t),
      rpc: (_name: string, args: { p_flow_id: string }) => {
        state.execCountCalls.push(args.p_flow_id);
        return Promise.resolve({ error: null });
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

import { startFlowManually, dispatchInboundToFlows } from "./engine";

const ACCOUNT = "acct-1";
const OTHER_ACCOUNT = "acct-2";
const FLOW_AUTHOR = "user-author";
const AGENT_USER = "user-agent";
const CONTACT = "contact-1";
const CONVERSATION = "conv-1";

function seedFlow(overrides: Partial<Record<string, unknown>> = {}) {
  const flow = {
    id: "flow-1",
    account_id: ACCOUNT,
    user_id: FLOW_AUTHOR,
    name: "Combo XTD Taladro + Amoladora",
    description: null,
    status: "active",
    trigger_type: "keyword",
    trigger_config: { keywords: ["combo"] },
    entry_node_id: "end1",
    fallback_policy: { type: "end" },
    execution_count: 0,
    last_executed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
  h.state.flows.push(flow);
  h.state.flowNodes.push({
    flow_id: flow.id,
    node_key: "end1",
    node_type: "end",
    config: {},
  });
  return flow;
}

function seedConversationAndContact() {
  h.state.contacts.push({ id: CONTACT, account_id: ACCOUNT, name: "Juan Pérez" });
  h.state.conversations.push({
    id: CONVERSATION,
    account_id: ACCOUNT,
    contact_id: CONTACT,
  });
}

beforeEach(() => {
  h.state.flows = [];
  h.state.flowNodes = [];
  h.state.conversations = [];
  h.state.contacts = [];
  h.state.flowRuns = [];
  h.state.flowRunEvents = [];
  h.state.execCountCalls = [];
  h.state.nextRunId = 1;
  h.state.forceInsertConflict = false;
});

describe("startFlowManually", () => {
  it("A. active keyword flow -> creates run and executes it", async () => {
    seedFlow({ trigger_type: "keyword" });
    seedConversationAndContact();

    const result = await startFlowManually({
      accountId: ACCOUNT,
      initiatedByUserId: AGENT_USER,
      flowId: "flow-1",
      conversationId: CONVERSATION,
    });

    expect(result.outcome).toBe("started");
    expect(h.state.flowRuns).toHaveLength(1);
    expect(h.state.flowRuns[0].status).toBe("completed"); // end node terminates immediately
  });

  it("B. active manual-trigger flow -> also works", async () => {
    seedFlow({ trigger_type: "manual" });
    seedConversationAndContact();

    const result = await startFlowManually({
      accountId: ACCOUNT,
      initiatedByUserId: AGENT_USER,
      flowId: "flow-1",
      conversationId: CONVERSATION,
    });

    expect(result.outcome).toBe("started");
  });

  it("C. active first_inbound_message flow -> also works manually", async () => {
    seedFlow({ trigger_type: "first_inbound_message" });
    seedConversationAndContact();

    const result = await startFlowManually({
      accountId: ACCOUNT,
      initiatedByUserId: AGENT_USER,
      flowId: "flow-1",
      conversationId: CONVERSATION,
    });

    expect(result.outcome).toBe("started");
  });

  it("D. draft flow -> rejected, no run created", async () => {
    seedFlow({ status: "draft" });
    seedConversationAndContact();

    const result = await startFlowManually({
      accountId: ACCOUNT,
      initiatedByUserId: AGENT_USER,
      flowId: "flow-1",
      conversationId: CONVERSATION,
    });

    expect(result.outcome).toBe("flow_not_active");
    expect(h.state.flowRuns).toHaveLength(0);
  });

  it("E. archived flow -> rejected, no run created", async () => {
    seedFlow({ status: "archived" });
    seedConversationAndContact();

    const result = await startFlowManually({
      accountId: ACCOUNT,
      initiatedByUserId: AGENT_USER,
      flowId: "flow-1",
      conversationId: CONVERSATION,
    });

    expect(result.outcome).toBe("flow_not_active");
    expect(h.state.flowRuns).toHaveLength(0);
  });

  it("active flow with entry_node_id=null -> rejected, never inserts an active run with a null current_node_key", async () => {
    seedFlow({ status: "active", entry_node_id: null });
    seedConversationAndContact();

    const result = await startFlowManually({
      accountId: ACCOUNT,
      initiatedByUserId: AGENT_USER,
      flowId: "flow-1",
      conversationId: CONVERSATION,
    });

    expect(result.outcome).toBe("flow_not_active");
    expect(h.state.flowRuns).toHaveLength(0);
    expect(h.state.flowRunEvents).toHaveLength(0);
    expect(h.state.execCountCalls).toHaveLength(0);
  });

  it("F. flow belonging to another account -> rejected as not found", async () => {
    seedFlow({ account_id: OTHER_ACCOUNT });
    seedConversationAndContact();

    const result = await startFlowManually({
      accountId: ACCOUNT,
      initiatedByUserId: AGENT_USER,
      flowId: "flow-1",
      conversationId: CONVERSATION,
    });

    expect(result.outcome).toBe("flow_not_found");
    expect(h.state.flowRuns).toHaveLength(0);
  });

  it("G. conversation belonging to another account -> rejected as not found", async () => {
    seedFlow();
    h.state.contacts.push({ id: CONTACT, account_id: ACCOUNT, name: "Juan Pérez" });
    h.state.conversations.push({
      id: CONVERSATION,
      account_id: OTHER_ACCOUNT,
      contact_id: CONTACT,
    });

    const result = await startFlowManually({
      accountId: ACCOUNT,
      initiatedByUserId: AGENT_USER,
      flowId: "flow-1",
      conversationId: CONVERSATION,
    });

    expect(result.outcome).toBe("conversation_not_found");
    expect(h.state.flowRuns).toHaveLength(0);
  });

  it("P0 blocking — a blocked contact is rejected, no run created", async () => {
    seedFlow();
    h.state.contacts.push({ id: CONTACT, account_id: ACCOUNT, name: "Juan Pérez", blocked: true });
    h.state.conversations.push({
      id: CONVERSATION,
      account_id: ACCOUNT,
      contact_id: CONTACT,
    });

    const result = await startFlowManually({
      accountId: ACCOUNT,
      initiatedByUserId: AGENT_USER,
      flowId: "flow-1",
      conversationId: CONVERSATION,
    });

    expect(result.outcome).toBe("contact_blocked");
    expect(h.state.flowRuns).toHaveLength(0);
    expect(h.state.flowRunEvents).toHaveLength(0);
  });

  it("H. contact is correctly derived from the conversation + account", async () => {
    seedFlow();
    seedConversationAndContact();

    await startFlowManually({
      accountId: ACCOUNT,
      initiatedByUserId: AGENT_USER,
      flowId: "flow-1",
      conversationId: CONVERSATION,
    });

    expect(h.state.flowRuns[0].contact_id).toBe(CONTACT);
  });

  it("I. vars.contact_name is seeded from the contact row", async () => {
    seedFlow();
    seedConversationAndContact();

    await startFlowManually({
      accountId: ACCOUNT,
      initiatedByUserId: AGENT_USER,
      flowId: "flow-1",
      conversationId: CONVERSATION,
    });

    expect(h.state.flowRuns[0].vars).toEqual({ contact_name: "Juan Pérez" });
  });

  it("J. 'started' event carries trigger_source/initiated_by_user_id and NO meta_message_id", async () => {
    seedFlow();
    seedConversationAndContact();

    await startFlowManually({
      accountId: ACCOUNT,
      initiatedByUserId: AGENT_USER,
      flowId: "flow-1",
      conversationId: CONVERSATION,
    });

    const startedEvent = h.state.flowRunEvents.find((e) => e.event_type === "started");
    expect(startedEvent).toBeDefined();
    expect(startedEvent!.payload).toMatchObject({
      flow_id: "flow-1",
      trigger_type: "keyword",
      trigger_source: "manual",
      initiated_by_user_id: AGENT_USER,
    });
    expect(startedEvent!.payload).not.toHaveProperty("meta_message_id");
  });

  it("also preserves flow_runs.user_id as the flow's author, not the initiator", async () => {
    seedFlow();
    seedConversationAndContact();

    await startFlowManually({
      accountId: ACCOUNT,
      initiatedByUserId: AGENT_USER,
      flowId: "flow-1",
      conversationId: CONVERSATION,
    });

    expect(h.state.flowRuns[0].user_id).toBe(FLOW_AUTHOR);
  });

  it("K. execution_count RPC increments exactly once", async () => {
    seedFlow();
    seedConversationAndContact();

    await startFlowManually({
      accountId: ACCOUNT,
      initiatedByUserId: AGENT_USER,
      flowId: "flow-1",
      conversationId: CONVERSATION,
    });

    expect(h.state.execCountCalls).toEqual(["flow-1"]);
  });

  it("L. an existing active run for the contact blocks a second start", async () => {
    seedFlow({ id: "flow-1", name: "AMOLADORA TOTAL" });
    seedConversationAndContact();
    h.state.flowRuns.push({
      id: "run-existing",
      flow_id: "flow-1",
      account_id: ACCOUNT,
      user_id: FLOW_AUTHOR,
      contact_id: CONTACT,
      conversation_id: CONVERSATION,
      status: "active",
      current_node_key: "end1",
      vars: {},
      started_at: new Date().toISOString(),
    });

    const result = await startFlowManually({
      accountId: ACCOUNT,
      initiatedByUserId: AGENT_USER,
      flowId: "flow-1",
      conversationId: CONVERSATION,
    });

    expect(result.outcome).toBe("active_flow_exists");
    if (result.outcome === "active_flow_exists") {
      expect(result.active_flow_run_id).toBe("run-existing");
      expect(result.active_flow_id).toBe("flow-1");
      expect(result.active_flow_name).toBe("AMOLADORA TOTAL");
    }
    // still exactly one run — no second one created
    expect(h.state.flowRuns).toHaveLength(1);
  });

  it("M. a 23505 race on insert is reported as a controlled conflict, not a crash", async () => {
    seedFlow();
    seedConversationAndContact();
    h.state.forceInsertConflict = true;
    // Simulate the racing run landing concurrently, so the recovery
    // lookup after the 23505 can find it.
    h.state.flowRuns.push({
      id: "run-race-winner",
      flow_id: "flow-1",
      account_id: ACCOUNT,
      user_id: FLOW_AUTHOR,
      contact_id: CONTACT,
      conversation_id: CONVERSATION,
      status: "active",
      current_node_key: "end1",
      vars: {},
      started_at: new Date().toISOString(),
    });

    const result = await startFlowManually({
      accountId: ACCOUNT,
      initiatedByUserId: AGENT_USER,
      flowId: "flow-1",
      conversationId: CONVERSATION,
    });

    expect(result.outcome).toBe("active_flow_exists");
    if (result.outcome === "active_flow_exists") {
      expect(result.active_flow_run_id).toBe("run-race-winner");
    }
  });

  it("contact not belonging to the account -> rejected (defensive)", async () => {
    seedFlow();
    h.state.contacts.push({ id: CONTACT, account_id: OTHER_ACCOUNT, name: "X" });
    h.state.conversations.push({
      id: CONVERSATION,
      account_id: ACCOUNT,
      contact_id: CONTACT,
    });

    const result = await startFlowManually({
      accountId: ACCOUNT,
      initiatedByUserId: AGENT_USER,
      flowId: "flow-1",
      conversationId: CONVERSATION,
    });

    expect(result.outcome).toBe("contact_not_found");
    expect(h.state.flowRuns).toHaveLength(0);
  });
});

describe("inbound dispatch compatibility — unaffected by the manual-start refactor", () => {
  it("keyword inbound still starts a run with the ORIGINAL 'started' payload shape (meta_message_id, no trigger_source)", async () => {
    seedFlow({ trigger_type: "keyword", trigger_config: { keywords: ["combo"] } });
    seedConversationAndContact();

    const result = await dispatchInboundToFlows({
      accountId: ACCOUNT,
      userId: AGENT_USER,
      contactId: CONTACT,
      conversationId: CONVERSATION,
      message: { kind: "text", text: "quiero el combo", meta_message_id: "wamid.123" },
      isFirstInboundMessage: false,
    });

    expect(result.consumed).toBe(true);
    expect(h.state.flowRuns).toHaveLength(1);
    const startedEvent = h.state.flowRunEvents.find((e) => e.event_type === "started");
    expect(startedEvent!.payload).toMatchObject({
      flow_id: "flow-1",
      trigger_type: "keyword",
      meta_message_id: "wamid.123",
    });
    expect(startedEvent!.payload).not.toHaveProperty("trigger_source");
    expect(startedEvent!.payload).not.toHaveProperty("initiated_by_user_id");
  });

  it("manual-trigger flows still do NOT auto-start from an inbound message", async () => {
    seedFlow({ trigger_type: "manual" });
    seedConversationAndContact();

    const result = await dispatchInboundToFlows({
      accountId: ACCOUNT,
      userId: AGENT_USER,
      contactId: CONTACT,
      conversationId: CONVERSATION,
      message: { kind: "text", text: "quiero ese combo", meta_message_id: "wamid.456" },
      isFirstInboundMessage: false,
    });

    expect(result.consumed).toBe(false);
    expect(h.state.flowRuns).toHaveLength(0);
  });
});
