import { beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================
// Whole-word (`match_type: "word"`) entry triggers through the real dispatcher.
//
// Drives the real `dispatchInboundToFlows` against a fake Supabase so
// the assertion is "a run was actually started", not "a helper returned
// true". The bug was that a button tap never reached the keyword
// matcher at all, so a helper-level test would have missed it.
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    /** Rows loadActiveRunForContact sees. Empty = no run in progress. */
    activeRuns: [] as unknown[],
    flows: [] as unknown[],
    nodes: [] as unknown[],
    inserted: [] as { table: string; row: Record<string, unknown> }[],
    /** Set by the flow_runs INSERT; what its .maybeSingle() returns. */
    insertedRun: null as Record<string, unknown> | null,
    rpcCalls: [] as string[],
  },
}));

vi.mock("./admin-client", () => {
  function rows(table: string): unknown[] {
    if (table === "flow_runs") return h.state.activeRuns;
    if (table === "flows") return h.state.flows;
    if (table === "flow_nodes") return h.state.nodes;
    return [];
  }

  function builder(table: string) {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      in: () => b,
      filter: () => b,
      order: () => b,
      limit: () => b,
      update: () => b,
      insert: (row: Record<string, unknown>) => {
        h.state.inserted.push({ table, row });
        if (table === "flow_runs") {
          h.state.insertedRun = {
            id: "run-1",
            vars: {},
            reprompt_count: 0,
            ...row,
          };
        }
        return b;
      },
      // Only reached on the INSERT ... SELECT for a new run, and on
      // loadFlow's flows lookup.
      maybeSingle: async () => ({
        data:
          table === "flow_runs" ? h.state.insertedRun : (rows(table)[0] ?? null),
        error: null,
      }),
      single: async () => ({ data: rows(table)[0] ?? null, error: null }),
      then: (
        resolve: (r: {
          data: unknown[];
          error: null;
          count: number;
        }) => unknown,
      ) => resolve({ data: rows(table), error: null, count: 0 }),
    };
    return b;
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => builder(t),
      rpc: (name: string) => {
        h.state.rpcCalls.push(name);
        return Promise.resolve({ error: null });
      },
    }),
  };
});

const engineSendText = vi.fn(async () => ({ whatsapp_message_id: "wamid.1" }));

vi.mock("./meta-send", () => ({
  engineSendText: (...a: unknown[]) =>
    (engineSendText as unknown as (...x: unknown[]) => unknown)(...a),
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: "wamid.2" })),
  engineSendInteractiveButtons: vi.fn(async () => ({
    whatsapp_message_id: "wamid.3",
  })),
  engineSendInteractiveList: vi.fn(async () => ({
    whatsapp_message_id: "wamid.4",
  })),
}));

import { dispatchInboundToFlows } from "./engine";
import type { ParsedInbound } from "./types";

const KEYWORD_FLOW = {
  id: "flow-1",
  account_id: "acct-1",
  user_id: "u-1",
  status: "active",
  trigger_type: "keyword",
  trigger_config: { keywords: ["order status"] },
  entry_node_id: "start",
  created_at: "2026-01-01T00:00:00Z",
};

const NODES = [
  {
    id: "n1",
    flow_id: "flow-1",
    node_key: "start",
    node_type: "start",
    config: { next_node_key: "greet" },
  },
  {
    id: "n2",
    flow_id: "flow-1",
    node_key: "greet",
    node_type: "send_message",
    config: { text: "Looking that up…", next_node_key: "done" },
  },
  {
    id: "n3",
    flow_id: "flow-1",
    node_key: "done",
    node_type: "end",
    config: {},
  },
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

/** flow_runs INSERTs made during a dispatch. */
function startedRuns() {
  return h.state.inserted.filter((i) => i.table === "flow_runs");
}

beforeEach(() => {
  // No run in progress — the whole point is the entry-trigger path.
  h.state.activeRuns = [];
  h.state.flows = [];
  h.state.nodes = NODES;
  h.state.inserted = [];
  h.state.insertedRun = null;
  h.state.rpcCalls = [];
  engineSendText.mockClear();
});
const WORD = (id: string, keywords: string[], extra: Record<string, unknown> = {}) => ({
  ...KEYWORD_FLOW,
  id,
  trigger_config: { keywords, match_type: "word", ...extra },
});
const text = (t: string): ParsedInbound => ({ kind: "text", text: t, meta_message_id: "m1" });
const startedFlowIds = () => startedRuns().map((r) => r.row.flow_id);

describe("dispatchInboundToFlows — word flows", () => {
  it("starts a regional flow when the customer answers with the place, ignoring case, accents and punctuation", async () => {
    h.state.flows = [WORD("w-jaen", ["Jaén"])];
    const r = await dispatch(text("JAEN."));
    expect(r.consumed).toBe(true);
    expect(startedFlowIds()).toEqual(["w-jaen"]);
    expect(engineSendText).toHaveBeenCalledTimes(1);
  });

  it("does not start 'Ica' inside 'eléctrica' (the substring bug this mode exists for)", async () => {
    h.state.flows = [WORD("w-ica", ["Ica"])];
    const r = await dispatch(text("Precio de la cocina eléctrica"));
    expect(r).toMatchObject({ consumed: false, outcome: "no_match" });
    expect(startedRuns()).toHaveLength(0);
    expect(engineSendText).not.toHaveBeenCalled();
  });

  it("a flow in the default (contains) mode still fires inside a word, as before", async () => {
    h.state.flows = [{ ...KEYWORD_FLOW, id: "legacy-ica", trigger_config: { keywords: ["ica"] } }];
    await dispatch(text("cocina eléctrica"));
    expect(startedFlowIds()).toEqual(["legacy-ica"]);
  });

  it("a commercial (contains) flow wins over a word flow for the same message, in either creation order", async () => {
    const ad = { ...KEYWORD_FLOW, id: "ad", trigger_config: { keywords: ["información sobre el taladro"] } };
    for (const flows of [[WORD("w-ica", ["Ica"]), ad], [ad, WORD("w-ica", ["Ica"])]]) {
      h.state.flows = flows;
      h.state.inserted = [];
      await dispatch(text("Quiero información sobre el taladro, soy de Ica"));
      expect(startedFlowIds()).toEqual(["ad"]);
    }
  });

  it("the most specific word flow starts, and only one", async () => {
    h.state.flows = [WORD("w-chim", ["Chimbote"]), WORD("w-nchim", ["Nuevo Chimbote"])];
    await dispatch(text("Nuevo Chimbote"));
    expect(startedFlowIds()).toEqual(["w-nchim"]);
  });

  it("an unresolved tie starts nothing and sends nothing; the message is left for a person", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.state.flows = [WORD("w-a", ["Cajamarca"]), WORD("w-b", ["Jaén"])];
    const r = await dispatch(text("Jaén Cajamarca"));
    expect(r).toMatchObject({ consumed: false, outcome: "no_match" });
    expect(startedRuns()).toHaveLength(0);
    expect(engineSendText).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ambiguous word match"), "w-a,w-b");
    warn.mockRestore();
  });

  it("word_priority resolves that same tie", async () => {
    h.state.flows = [WORD("w-a", ["Cajamarca"], { word_priority: 1 }), WORD("w-b", ["Jaén"], { word_priority: 2 })];
    await dispatch(text("Jaén Cajamarca"));
    expect(startedFlowIds()).toEqual(["w-b"]);
  });

  it("respects restrictToFlowIds: an unauthorized word flow behaves as if it did not exist", async () => {
    h.state.flows = [WORD("w-a", ["Lima"]), WORD("w-b", ["Lima Barranca"])];
    await dispatchInboundToFlows({ accountId: "acct-1", userId: "u-1", contactId: "ct-1", conversationId: "cv-1", message: text("Lima Barranca"), isFirstInboundMessage: false, restrictToFlowIds: ["w-a"] });
    expect(startedFlowIds()).toEqual(["w-a"]);
  });

  it("a button tap is offered to word flows too (title and reply id)", async () => {
    h.state.flows = [WORD("w-cusco", ["Cusco"])];
    const r = await dispatch({ kind: "interactive_reply", reply_id: "btn_1", reply_title: "Cusco", meta_message_id: "m2" });
    expect(r.consumed).toBe(true);
    expect(startedFlowIds()).toEqual(["w-cusco"]);
  });

  it("a manual-trigger flow never starts from a message, even with match_type word", async () => {
    h.state.flows = [{ ...WORD("w-m", ["Lima"]), trigger_type: "manual" }];
    const r = await dispatch(text("Lima"));
    expect(r).toMatchObject({ consumed: false, outcome: "no_match" });
  });
});
