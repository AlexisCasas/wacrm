import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================
// Integration-level coverage for the two new v1 node types, driven
// through the REAL `dispatchInboundToFlows` (not just the pure
// helpers) — same style as dispatch.test.ts (#490).
//
//   - delay: must actually pause (via a real, fake-timer-advanced
//     setTimeout), then re-check the run's status from the DB before
//     continuing — proving an agent take-over mid-delay stops the
//     Flow from sending anything further.
//   - set_contact_field: must enforce tenancy on BOTH the custom field
//     and the contact before writing, upsert on the right conflict
//     target, and interpolate {{vars.X}}.
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    flows: [] as unknown[],
    nodes: [] as unknown[],
    /** Read by the delay node's post-sleep re-check. Flip this mid-test
     *  to simulate an agent take-over landing while the delay sleeps. */
    flowRunStatus: "active" as string,
    flowRunStatusReadCount: 0,
    customFieldRow: { id: "cf-1" } as { id: string } | null,
    contactRow: { id: "ct-1" } as { id: string } | null,
    /** Seeds a freshly-started run's `vars` (the mock's insert always
     *  defaults to {} otherwise — tests that need {{vars.X}} set this
     *  before dispatching). */
    seedVars: {} as Record<string, unknown>,
    insertedRun: null as Record<string, unknown> | null,
    upsertCalls: [] as { table: string; row: Record<string, unknown>; options: unknown }[],
    flowRunUpdateCalls: [] as Record<string, unknown>[],
    eventInserts: [] as { event_type: string; node_key: string | null; payload: Record<string, unknown> }[],
  },
}));

vi.mock("./admin-client", () => {
  function builder(table: string) {
    let lastSelect: string | undefined;
    const b: Record<string, unknown> = {
      select: (cols?: string) => {
        lastSelect = cols;
        return b;
      },
      eq: () => b,
      order: () => b,
      limit: () => b,
      insert: (row: Record<string, unknown>) => {
        if (table === "flow_run_events") {
          h.state.eventInserts.push({
            event_type: row.event_type as string,
            node_key: (row.node_key as string) ?? null,
            payload: (row.payload as Record<string, unknown>) ?? {},
          });
        }
        if (table === "flow_runs") {
          h.state.insertedRun = {
            id: "run-1",
            reprompt_count: 0,
            ...row,
            // The real startNewRun() now always seeds `vars.contact_name`
            // itself (row.vars) — layer the test's extra seeded vars
            // (e.g. `price`, standing in for what a prior collect_input
            // would have captured) on top so both coexist, same as a
            // real merged vars object would.
            vars: { ...h.state.seedVars, ...(row.vars as Record<string, unknown> | undefined) },
          };
        }
        return b;
      },
      upsert: (row: Record<string, unknown>, options?: unknown) => {
        h.state.upsertCalls.push({ table, row, options });
        return Promise.resolve({ data: null, error: null });
      },
      update: (row: Record<string, unknown>) => {
        if (table === "flow_runs") h.state.flowRunUpdateCalls.push(row);
        return b;
      },
      maybeSingle: async () => {
        if (table === "flow_runs") {
          // The delay node's re-check asks specifically for `status`;
          // everything else (the post-insert re-select in
          // startNewRun) wants the full row.
          if (lastSelect === "status") {
            h.state.flowRunStatusReadCount += 1;
            return { data: { status: h.state.flowRunStatus }, error: null };
          }
          return { data: h.state.insertedRun, error: null };
        }
        if (table === "custom_fields") return { data: h.state.customFieldRow, error: null };
        if (table === "contacts") return { data: h.state.contactRow, error: null };
        if (table === "flows") return { data: h.state.flows[0] ?? null, error: null };
        return { data: null, error: null };
      },
      single: async () => ({ data: null, error: null }),
      then: (resolve: (r: { data: unknown[]; error: null; count: number }) => unknown) =>
        resolve({
          data: table === "flows" ? h.state.flows : table === "flow_nodes" ? h.state.nodes : [],
          error: null,
          count: 0,
        }),
    };
    return b;
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => builder(t),
      rpc: () => Promise.resolve({ error: null }),
    }),
  };
});

const engineSendText = vi.fn(async () => ({ whatsapp_message_id: "wamid.1" }));
vi.mock("./meta-send", () => ({
  engineSendText: (...a: unknown[]) => (engineSendText as unknown as (...x: unknown[]) => unknown)(...a),
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: "wamid.2" })),
  engineSendInteractiveButtons: vi.fn(async () => ({ whatsapp_message_id: "wamid.3" })),
  engineSendInteractiveList: vi.fn(async () => ({ whatsapp_message_id: "wamid.4" })),
}));

import { dispatchInboundToFlows } from "./engine";
import type { ParsedInbound } from "./types";

const KEYWORD_FLOW = {
  id: "flow-1",
  account_id: "acct-1",
  user_id: "u-1",
  status: "active",
  trigger_type: "keyword",
  trigger_config: { keywords: ["start delay"] },
  entry_node_id: "start",
  created_at: "2026-01-01T00:00:00Z",
};

const DELAY_NODES = [
  { id: "n1", flow_id: "flow-1", node_key: "start", node_type: "start", config: { next_node_key: "wait" } },
  { id: "n2", flow_id: "flow-1", node_key: "wait", node_type: "delay", config: { seconds: 5, next_node_key: "after" } },
  { id: "n3", flow_id: "flow-1", node_key: "after", node_type: "send_message", config: { text: "continuing", next_node_key: "done" } },
  { id: "n4", flow_id: "flow-1", node_key: "done", node_type: "end", config: {} },
];

const SCF_FLOW = { ...KEYWORD_FLOW, trigger_config: { keywords: ["set field"] } };
const SCF_NODES = [
  { id: "n1", flow_id: "flow-1", node_key: "start", node_type: "start", config: { next_node_key: "scf" } },
  {
    id: "n2",
    flow_id: "flow-1",
    node_key: "scf",
    node_type: "set_contact_field",
    config: { field: "custom:cf-1", value: "{{vars.price}}", next_node_key: "done" },
  },
  { id: "n3", flow_id: "flow-1", node_key: "done", node_type: "end", config: {} },
];

function dispatch(message: ParsedInbound) {
  return dispatchInboundToFlows({
    accountId: "acct-1",
    userId: "u-1",
    contactId: "ct-1",
    conversationId: "cv-1",
    message,
    isFirstInboundMessage: false,
  });
}

beforeEach(() => {
  h.state.flows = [];
  h.state.nodes = [];
  h.state.flowRunStatus = "active";
  h.state.flowRunStatusReadCount = 0;
  h.state.customFieldRow = { id: "cf-1" };
  h.state.contactRow = { id: "ct-1" };
  h.state.seedVars = {};
  h.state.insertedRun = null;
  h.state.upsertCalls = [];
  h.state.flowRunUpdateCalls = [];
  h.state.eventInserts = [];
  engineSendText.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("delay node", () => {
  it("auto-advances to next_node_key after the delay when the run is still active", async () => {
    vi.useFakeTimers();
    h.state.flows = [KEYWORD_FLOW];
    h.state.nodes = DELAY_NODES;
    h.state.flowRunStatus = "active";

    const resultPromise = dispatch({ kind: "text", text: "start delay", meta_message_id: "m1" });
    // Flush the 5s in-process sleep without actually waiting.
    await vi.advanceTimersByTimeAsync(5000);
    const result = await resultPromise;

    expect(result.consumed).toBe(true);
    expect(result.outcome).toBe("completed"); // reached the `end` node
    // It really continued past the delay and sent the next message —
    // not just "returned some result".
    expect(engineSendText).toHaveBeenCalledTimes(1);
    expect(engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "continuing" }),
    );
  });

  it("re-checks the run's status from the DB after sleeping (not the in-memory value read before)", async () => {
    vi.useFakeTimers();
    h.state.flows = [KEYWORD_FLOW];
    h.state.nodes = DELAY_NODES;
    h.state.flowRunStatus = "active";

    const resultPromise = dispatch({ kind: "text", text: "start delay", meta_message_id: "m1" });
    await vi.advanceTimersByTimeAsync(5000);
    await resultPromise;

    // At least one read of flow_runs happened AFTER the sleep to decide
    // whether to continue (the delay node's own re-check) — proves this
    // isn't trusting a value captured before the `await sleep(...)`.
    expect(h.state.flowRunStatusReadCount).toBeGreaterThan(0);
  });

  it("does NOT send the next node's message if an agent took over while the delay was sleeping", async () => {
    vi.useFakeTimers();
    h.state.flows = [KEYWORD_FLOW];
    h.state.nodes = DELAY_NODES;
    h.state.flowRunStatus = "active";

    const resultPromise = dispatch({ kind: "text", text: "start delay", meta_message_id: "m1" });
    // Simulate send-message.ts's pause-on-agent-send landing WHILE the
    // delay is asleep, before the timer fires.
    h.state.flowRunStatus = "paused_by_agent";
    await vi.advanceTimersByTimeAsync(5000);
    const result = await resultPromise;

    expect(result.consumed).toBe(true);
    // The runner stopped — the outcome bucket for "stopped, nothing to
    // report" is 'completed' (see advanceFromNodeKey's other abort
    // paths), but critically: no further send happened.
    expect(engineSendText).not.toHaveBeenCalled();
  });

  it("never re-activates the run or overwrites its status when aborting for an agent take-over", async () => {
    vi.useFakeTimers();
    h.state.flows = [KEYWORD_FLOW];
    h.state.nodes = DELAY_NODES;
    h.state.flowRunStatus = "active";

    const resultPromise = dispatch({ kind: "text", text: "start delay", meta_message_id: "m1" });
    h.state.flowRunStatus = "paused_by_agent";
    await vi.advanceTimersByTimeAsync(5000);
    await resultPromise;

    // No update ever tries to flip flow_runs.status back to anything —
    // the row is left exactly as the agent's own action set it.
    const statusRewrites = h.state.flowRunUpdateCalls.filter((u) => "status" in u);
    expect(statusRewrites).toHaveLength(0);
  });

  it("does not fire AI or a fallback while a delay is in flight (no work is dispatched mid-sleep)", async () => {
    vi.useFakeTimers();
    h.state.flows = [KEYWORD_FLOW];
    h.state.nodes = DELAY_NODES;
    h.state.flowRunStatus = "active";

    const resultPromise = dispatch({ kind: "text", text: "start delay", meta_message_id: "m1" });
    // Before the timer fires, nothing has been sent yet — the flow is
    // still "in" the delay, owning the conversation, not idle.
    expect(engineSendText).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    await resultPromise;
    expect(engineSendText).toHaveBeenCalledTimes(1);
  });
});

describe("set_contact_field node", () => {
  it("upserts the custom field value and advances", async () => {
    h.state.flows = [SCF_FLOW];
    h.state.nodes = SCF_NODES;
    h.state.seedVars = { price: "177" };

    const result = await dispatch({ kind: "text", text: "set field", meta_message_id: "m1" });

    expect(result.consumed).toBe(true);
    expect(result.outcome).toBe("completed");
    const write = h.state.upsertCalls.find((c) => c.table === "contact_custom_values");
    expect(write).toBeDefined();
    expect(write!.options).toMatchObject({ onConflict: "contact_id,custom_field_id" });
    expect(write!.row).toMatchObject({
      contact_id: "ct-1",
      custom_field_id: "cf-1",
      value: "177",
    });
  });

  it("interpolates {{vars.X}} against flow_runs.vars", async () => {
    h.state.flows = [SCF_FLOW];
    h.state.nodes = SCF_NODES;
    h.state.seedVars = { price: "177" };

    await dispatch({ kind: "text", text: "set field", meta_message_id: "m1" });

    const write = h.state.upsertCalls.find((c) => c.table === "contact_custom_values");
    expect(write!.row.value).toBe("177");
  });

  it("renders a missing var as an empty string, same as send_message", async () => {
    h.state.flows = [SCF_FLOW];
    h.state.nodes = SCF_NODES;
    h.state.seedVars = {}; // no `price` set

    await dispatch({ kind: "text", text: "set field", meta_message_id: "m1" });

    const write = h.state.upsertCalls.find((c) => c.table === "contact_custom_values");
    expect(write!.row.value).toBe("");
  });

  it("refuses to write when the custom field does not belong to this account", async () => {
    h.state.flows = [SCF_FLOW];
    h.state.nodes = SCF_NODES;
    h.state.customFieldRow = null; // account-scoped lookup found nothing

    const result = await dispatch({ kind: "text", text: "set field", meta_message_id: "m1" });

    // Non-fatal per spec: logged, flow still advances — never strands
    // the customer — but the write itself never happens.
    expect(result.consumed).toBe(true);
    expect(h.state.upsertCalls.filter((c) => c.table === "contact_custom_values")).toHaveLength(0);
    expect(
      h.state.eventInserts.some(
        (e) => e.event_type === "error" && e.payload.reason === "set_contact_field_failed",
      ),
    ).toBe(true);
  });

  it("refuses to write when the contact does not belong to this account", async () => {
    h.state.flows = [SCF_FLOW];
    h.state.nodes = SCF_NODES;
    h.state.contactRow = null;

    const result = await dispatch({ kind: "text", text: "set field", meta_message_id: "m1" });

    expect(result.consumed).toBe(true);
    expect(h.state.upsertCalls.filter((c) => c.table === "contact_custom_values")).toHaveLength(0);
  });

  it("rejects a field reference that isn't custom:<id> — never writes a built-in column via this node", async () => {
    h.state.flows = [SCF_FLOW];
    h.state.nodes = [
      SCF_NODES[0],
      { ...SCF_NODES[1], config: { field: "name", value: "Eve", next_node_key: "done" } },
      SCF_NODES[2],
    ];

    await dispatch({ kind: "text", text: "set field", meta_message_id: "m1" });

    expect(h.state.upsertCalls).toHaveLength(0);
    expect(
      h.state.eventInserts.some(
        (e) => e.event_type === "error" && e.payload.reason === "set_contact_field_failed",
      ),
    ).toBe(true);
  });

  it("still advances to next_node_key even when the write is refused (does not strand the customer)", async () => {
    h.state.flows = [SCF_FLOW];
    h.state.nodes = SCF_NODES;
    h.state.customFieldRow = null;

    const result = await dispatch({ kind: "text", text: "set field", meta_message_id: "m1" });

    // Reached the `end` node right after — proves the flow moved on.
    expect(result.outcome).toBe("completed");
  });
});
