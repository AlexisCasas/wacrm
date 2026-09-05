import { beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================
// vars.contact_name seed — a new Flow run must start with the
// contact's name already available for interpolation
// ("Hola estimado {{vars.contact_name}} 🤗") without a prior
// collect_input step. Driven through the REAL dispatchInboundToFlows,
// same mock style as dispatch.test.ts (#490).
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    flows: [] as unknown[],
    nodes: [] as unknown[],
    /** Rows loadActiveRunForContact sees. Empty = start a fresh run. */
    activeRuns: [] as unknown[],
    /** contacts.name the tenancy-scoped lookup resolves to. */
    contactRow: { id: "ct-1", name: "Alexis Casas" } as { id: string; name: string | null } | null,
    /** Records every (column, value) the contacts lookup was scoped by. */
    contactLookupEqCalls: [] as [string, unknown][],
    insertedRun: null as Record<string, unknown> | null,
    flowRunUpdateCalls: [] as Record<string, unknown>[],
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
      eq: (col: string, val: unknown) => {
        if (table === "contacts") h.state.contactLookupEqCalls.push([col, val]);
        return b;
      },
      in: () => b,
      filter: () => b,
      order: () => b,
      limit: () => b,
      update: (row: Record<string, unknown>) => {
        if (table === "flow_runs") h.state.flowRunUpdateCalls.push(row);
        return b;
      },
      insert: (row: Record<string, unknown>) => {
        if (table === "flow_runs") {
          h.state.insertedRun = { id: "run-1", reprompt_count: 0, ...row };
        }
        return b;
      },
      maybeSingle: async () => {
        if (table === "contacts") return { data: h.state.contactRow, error: null };
        return {
          data: table === "flow_runs" ? h.state.insertedRun : (rows(table)[0] ?? null),
          error: null,
        };
      },
      then: (resolve: (r: { data: unknown[]; error: null; count: number }) => unknown) =>
        resolve({ data: rows(table), error: null, count: 0 }),
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
  trigger_config: { keywords: ["hola"] },
  entry_node_id: "start",
  created_at: "2026-01-01T00:00:00Z",
};

// start -> greet (send_message using {{vars.contact_name}}) -> end
const GREETING_NODES = [
  { id: "n1", flow_id: "flow-1", node_key: "start", node_type: "start", config: { next_node_key: "greet" } },
  {
    id: "n2",
    flow_id: "flow-1",
    node_key: "greet",
    node_type: "send_message",
    config: { text: "Hola estimado {{vars.contact_name}} 🤗", next_node_key: "done" },
  },
  { id: "n3", flow_id: "flow-1", node_key: "done", node_type: "end", config: {} },
];

function dispatch(message: ParsedInbound, contactId = "ct-1") {
  return dispatchInboundToFlows({
    accountId: "acct-1",
    userId: "u-1",
    contactId,
    conversationId: "cv-1",
    message,
    isFirstInboundMessage: true,
  });
}

beforeEach(() => {
  h.state.flows = [];
  h.state.nodes = [];
  h.state.activeRuns = [];
  h.state.contactRow = { id: "ct-1", name: "Alexis Casas" };
  h.state.contactLookupEqCalls = [];
  h.state.insertedRun = null;
  h.state.flowRunUpdateCalls = [];
  engineSendText.mockClear();
});

describe("A: seeds vars.contact_name from the contact's real name", () => {
  it("a freshly-started run's vars.contact_name equals the contact's name", async () => {
    h.state.flows = [KEYWORD_FLOW];
    h.state.nodes = GREETING_NODES;
    h.state.contactRow = { id: "ct-1", name: "Alexis Casas" };

    await dispatch({ kind: "text", text: "hola", meta_message_id: "m1" });

    expect((h.state.insertedRun!.vars as Record<string, unknown>).contact_name).toBe(
      "Alexis Casas",
    );
  });
});

describe("B: missing / empty name degrades to an empty string, never breaks the flow", () => {
  it.each([null, "", "   "])("name=%j → contact_name === ''", async (name) => {
    h.state.flows = [KEYWORD_FLOW];
    h.state.nodes = GREETING_NODES;
    h.state.contactRow = { id: "ct-1", name };

    const result = await dispatch({ kind: "text", text: "hola", meta_message_id: "m1" });

    expect((h.state.insertedRun!.vars as Record<string, unknown>).contact_name).toBe("");
    expect(result.consumed).toBe(true);
    expect(result.outcome).toBe("completed"); // the flow still ran to the end node
  });

  it("no contact row at all (lookup found nothing) → contact_name === '', flow still runs", async () => {
    h.state.flows = [KEYWORD_FLOW];
    h.state.nodes = GREETING_NODES;
    h.state.contactRow = null;

    await dispatch({ kind: "text", text: "hola", meta_message_id: "m1" });

    expect((h.state.insertedRun!.vars as Record<string, unknown>).contact_name).toBe("");
    expect(engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Hola estimado  🤗" }),
    );
  });
});

describe("C: the contact-name lookup is account-scoped — never leaks another account's contact", () => {
  it("scopes the lookup by BOTH contact id and the flow's account_id", async () => {
    h.state.flows = [KEYWORD_FLOW];
    h.state.nodes = GREETING_NODES;

    await dispatch({ kind: "text", text: "hola", meta_message_id: "m1" });

    expect(h.state.contactLookupEqCalls).toEqual([
      ["id", "ct-1"],
      ["account_id", "acct-1"],
    ]);
  });

  it("never trusts a name from the inbound payload — only from the contacts table lookup", async () => {
    h.state.flows = [KEYWORD_FLOW];
    h.state.nodes = GREETING_NODES;
    h.state.contactRow = { id: "ct-1", name: "Real DB Name" };

    // ParsedInbound (text / interactive_reply) has no name field at
    // all — structurally, there is nowhere for an external name to
    // enter this seed.
    await dispatch({ kind: "text", text: "hola", meta_message_id: "m1" });

    expect((h.state.insertedRun!.vars as Record<string, unknown>).contact_name).toBe(
      "Real DB Name",
    );
  });
});

describe("D: contact_name survives a later collect_input capture", () => {
  const NODES_WITH_CAPTURE = [
    { id: "n1", flow_id: "flow-1", node_key: "start", node_type: "start", config: { next_node_key: "ask" } },
    {
      id: "n2",
      flow_id: "flow-1",
      node_key: "ask",
      node_type: "collect_input",
      config: { prompt_text: "What's your email?", var_key: "email", next_node_key: "done" },
    },
    { id: "n3", flow_id: "flow-1", node_key: "done", node_type: "end", config: {} },
  ];

  it("vars keeps contact_name AND gains the newly captured variable", async () => {
    h.state.flows = [{ ...KEYWORD_FLOW, trigger_config: { keywords: ["start capture"] } }];
    h.state.nodes = NODES_WITH_CAPTURE;
    h.state.contactRow = { id: "ct-1", name: "Alexis Casas" };

    // Start the run — seeds contact_name, suspends at collect_input.
    await dispatch({ kind: "text", text: "start capture", meta_message_id: "m1" });
    expect((h.state.insertedRun!.vars as Record<string, unknown>).contact_name).toBe(
      "Alexis Casas",
    );

    // The customer's reply lands on the now-active run — same run row,
    // now discoverable via loadActiveRunForContact.
    h.state.activeRuns = [
      {
        ...h.state.insertedRun,
        status: "active",
        current_node_key: "ask",
        reprompt_count: 0,
      },
    ];

    await dispatchInboundToFlows({
      accountId: "acct-1",
      userId: "u-1",
      contactId: "ct-1",
      conversationId: "cv-1",
      message: { kind: "text", text: "eve@example.com", meta_message_id: "m2" },
      isFirstInboundMessage: false,
    });

    const capturedUpdate = h.state.flowRunUpdateCalls.find(
      (u) => "vars" in u,
    ) as Record<string, unknown> | undefined;
    expect(capturedUpdate).toBeDefined();
    expect(capturedUpdate!.vars).toMatchObject({
      contact_name: "Alexis Casas",
      email: "eve@example.com",
    });
  });
});

describe("E: send_message interpolates {{vars.contact_name}} for a fresh run", () => {
  it('produces "Hola estimado Alexis Casas 🤗"', async () => {
    h.state.flows = [KEYWORD_FLOW];
    h.state.nodes = GREETING_NODES;
    h.state.contactRow = { id: "ct-1", name: "Alexis Casas" };

    await dispatch({ kind: "text", text: "hola", meta_message_id: "m1" });

    expect(engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Hola estimado Alexis Casas 🤗" }),
    );
  });
});
