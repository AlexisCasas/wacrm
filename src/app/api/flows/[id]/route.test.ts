import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireRole: vi.fn(), createClient: vi.fn(), admin: vi.fn(), validateReferences: vi.fn(), enabled: vi.fn(), toErrorResponse: vi.fn(), subflow: vi.fn(), durableAuthoring: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({ requireRole: mocks.requireRole, toErrorResponse: mocks.toErrorResponse }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("@/lib/flows/condition-references", () => ({ ConditionReferenceInfrastructureError: class extends Error {}, validateConditionReferences: mocks.validateReferences }));
vi.mock("@/lib/flows/custom-condition-capability", () => ({ isCustomConditionEnabledForAccount: mocks.enabled }));
vi.mock("@/lib/flows/subflow-authoring-capability", () => ({ isSubflowAuthoringEnabledForAccount: mocks.subflow }));
vi.mock("@/lib/flows/durable-wait-capability", () => ({ isDurableWaitAuthoringEnabledForAccount: mocks.durableAuthoring }));

import { PUT } from "./route";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const params = { params: Promise.resolve({ id: "flow-1" }) };
const context = { accountId: ACCOUNT, supabase: {}, userId: "u", role: "agent", account: { id: ACCOUNT, name: "A" } };
const savedFlow = { id: "flow-1", name: "Saved", status: "draft" };
const savedNodes = [{ id: "n1", node_key: "start" }];

/** Admin client double: `rpc` is the atomic save, `from` only serves the reads that follow it (and the capability pre-check). */
function adminDouble(rpcResult: { error: { code?: string; message?: string } | null } = { error: null }, accountFlows: string[] = [], lookupError: unknown = null) {
  const rpc = vi.fn().mockResolvedValue(rpcResult);
  const lookups: Array<{ ids: string[] }> = [];
  const writes = vi.fn();
  const from = vi.fn((table: string) => ({
    select: () => ({
      eq: () => ({
        maybeSingle: vi.fn().mockResolvedValue({ data: table === "flows" ? savedFlow : null }),
        order: vi.fn().mockResolvedValue({ data: savedNodes }),
        then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
        in: (_col: string, ids: string[]) => { lookups.push({ ids }); return Promise.resolve(lookupError ? { data: null, error: lookupError } : { data: accountFlows.filter((f) => ids.includes(f)).map((id) => ({ id })), error: null }); },
      }),
    }),
    update: writes, delete: writes, insert: writes, upsert: writes,
  }));
  mocks.admin.mockReturnValue({ from, rpc });
  return { rpc, from, writes, lookups };
}
const put = (body: unknown, flowId = "flow-1") => PUT(new Request(`http://localhost/api/flows/${flowId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }), flowId === "flow-1" ? params : { params: Promise.resolve({ id: flowId }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.requireRole.mockResolvedValue(context);
  mocks.toErrorResponse.mockReturnValue(Response.json({ error: "auth" }, { status: 403 }));
  mocks.createClient.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u" } } }) }, from: vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: "flow-1" } }) }) }) })) });
  mocks.validateReferences.mockResolvedValue([]);
  mocks.enabled.mockReturnValue(true);
  mocks.subflow.mockReturnValue(false);
  mocks.durableAuthoring.mockReturnValue(false);
});

describe("PUT /api/flows/[id]", () => {
  it("rejects direct custom-condition writes before anything is written", async () => {
    const { rpc, writes } = adminDouble();
    mocks.validateReferences.mockResolvedValue([{ node_key: "c", issue: "custom_condition_capability_disabled" }]);
    const response = await put({ nodes: [{ node_key: "c", node_type: "condition", config: { subject: "contact_field", subject_key: "custom:22222222-2222-4222-8222-222222222222" } }] });
    expect(response.status).toBe(422);
    expect(mocks.validateReferences).toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
  });

  it("saves header and graph with ONE atomic call, using the session's account, and never with separate writes", async () => {
    const { rpc, writes } = adminDouble();
    const nodes = [
      { node_key: "start", node_type: "start", config: { next_node_key: "m" }, position_x: 5, position_y: 6, extra: "ignored" },
      { node_key: "m", node_type: "send_message", config: { text: "hola" } },
    ];
    const response = await put({ name: "  Renamed ", trigger_type: "keyword", entry_node_id: "start", nodes });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ flow: savedFlow, nodes: savedNodes });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("replace_flow_draft_atomic", {
      p_account_id: ACCOUNT, p_flow_id: "flow-1",
      p_patch: { name: "Renamed", trigger_type: "keyword", entry_node_id: "start" },
      p_nodes: [
        { node_key: "start", node_type: "start", config: { next_node_key: "m" }, position_x: 5, position_y: 6 },
        { node_key: "m", node_type: "send_message", config: { text: "hola" }, position_x: 0, position_y: 0 },
      ],
    });
    expect(writes).not.toHaveBeenCalled(); // no update / delete / insert outside the transaction
  });

  it("a header-only save does not touch the graph (p_nodes is null)", async () => {
    const { rpc } = adminDouble();
    expect((await put({ description: null, trigger_config: { keywords: ["hi"] } })).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("replace_flow_draft_atomic", { p_account_id: ACCOUNT, p_flow_id: "flow-1", p_patch: { description: null, trigger_config: { keywords: ["hi"] } }, p_nodes: null });
  });

  it("an empty array still means 'clear the graph' (unchanged contract)", async () => {
    const { rpc } = adminDouble();
    await put({ nodes: [] });
    expect(rpc.mock.calls[0][1].p_nodes).toEqual([]);
  });

  it("never forwards an account_id or user_id supplied by the client", async () => {
    const { rpc } = adminDouble();
    await put({ name: "x", account_id: "99999999-9999-4999-8999-999999999999", user_id: "evil", status: "active", p_account_id: "evil" });
    const args = rpc.mock.calls[0][1];
    expect(args.p_account_id).toBe(ACCOUNT);
    expect(JSON.stringify(args)).not.toContain("99999999");
    expect(args.p_patch).toEqual({ name: "x" }); // status / ids are not patchable from the editor
  });

  it("maps every database failure to a clear status without echoing database text, and reads nothing back", async () => {
    const cases: Array<[string, number, RegExp]> = [
      ["P0002", 404, /Not found/], ["22023", 400, /Nothing was saved/],
      ["23505", 422, /Nothing was saved/], ["23514", 422, /Nothing was saved/], ["23502", 422, /Nothing was saved/], ["22P02", 422, /Nothing was saved/],
      ["XX000", 500, /Could not save flow/], ["", 500, /Could not save flow/],
    ];
    for (const [code, status, message] of cases) {
      const { rpc, from } = adminDouble({ error: { code, message: 'duplicate key value violates unique constraint "flow_nodes_flow_id_node_key_key" SECRET-NODE-TEXT' } });
      const response = await put({ name: "x", nodes: [{ node_key: "a", node_type: "start", config: {} }] });
      const body = await response.json();
      expect(response.status, code).toBe(status);
      expect(body.error, code).toMatch(message);
      expect(JSON.stringify(body), code).not.toContain("SECRET-NODE-TEXT");
      expect(JSON.stringify(body), code).not.toContain("flow_nodes");
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(from).not.toHaveBeenCalledWith("flows"); // no success payload is assembled after a failed save
    }
  });

  it("rejects a flow the caller cannot see (another account) before any save", async () => {
    const { rpc } = adminDouble();
    mocks.createClient.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u" } } }) }, from: vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: vi.fn().mockResolvedValue({ data: null }) }) }) })) });
    expect((await put({ name: "x" })).status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects users without the agent role, and unauthenticated callers, before any save", async () => {
    const { rpc } = adminDouble();
    mocks.requireRole.mockRejectedValue(new Error("forbidden"));
    expect((await put({ name: "x" })).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
    mocks.requireRole.mockResolvedValue(context);
    mocks.createClient.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) } });
    expect((await put({ name: "x" })).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("validates the payload shape before saving", async () => {
    const { rpc } = adminDouble();
    expect((await put("not json")).status).toBe(400);
    expect((await put({ name: "   " })).status).toBe(400);
    expect((await put({ nodes: { a: 1 } })).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  describe("'run another flow' nodes (pilot)", () => {
    const B = "33333333-3333-4333-8333-333333333333";
    const C = "44444444-4444-4444-8444-444444444444";
    const OTHER_ACCOUNT_FLOW = "55555555-5555-4555-8555-555555555555";
    const call = (target: unknown, key = "call") => ({ node_key: key, node_type: "execute_flow", config: { target_flow_id: target, next_node_key: "end" } });
    const graph = (...calls: unknown[]) => ({ nodes: [{ node_key: "start", node_type: "start", config: { next_node_key: "call" } }, ...calls, { node_key: "end", node_type: "end", config: {} }] });

    it("an account without the flag cannot introduce the node: 403 and nothing is written", async () => {
      const { rpc, writes } = adminDouble({ error: null }, [B]);
      const response = await put(graph(call(B)));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "subflow_authoring_disabled" });
      expect(rpc).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
      expect(mocks.subflow).toHaveBeenCalledWith(ACCOUNT);   // decided by the SESSION account, not by anything in the body
    });

    it("the flag is never read from the request", async () => {
      const { rpc } = adminDouble({ error: null }, [B]);
      const response = await put({ ...graph(call(B)), subflowAuthoring: true, account_id: ACCOUNT, capabilities: { subflowAuthoring: true } });
      expect(response.status).toBe(403);
      expect(rpc).not.toHaveBeenCalled();
    });

    it("an opted-in account saves a valid reference to a flow of its own account (draft targets included)", async () => {
      mocks.subflow.mockReturnValue(true);
      const { rpc, lookups } = adminDouble({ error: null }, [B, C]);
      const response = await put(graph(call(B)));
      expect(response.status).toBe(200);
      expect(lookups).toHaveLength(1); expect(lookups[0].ids).toEqual([B]);
      expect(rpc.mock.calls[0][1].p_nodes.find((n: { node_key: string }) => n.node_key === "call")).toEqual({ node_key: "call", node_type: "execute_flow", config: { target_flow_id: B, next_node_key: "end" }, position_x: 0, position_y: 0 });
    });

    it("an unfinished node (no target picked yet) can be saved as part of a draft", async () => {
      mocks.subflow.mockReturnValue(true);
      const { rpc } = adminDouble({ error: null }, []);
      expect((await put(graph(call(""), { node_key: "call2", node_type: "execute_flow", config: {} }))).status).toBe(200);
      expect(rpc).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["a flow of another account", OTHER_ACCOUNT_FLOW, "target_not_found"],
      ["a deleted / unknown flow", C, "target_not_found"],
      ["the flow itself", "66666666-6666-4666-8666-666666666666", "target_is_self"],
      ["a malformed id", "not-a-uuid", "invalid_target"],
      ["a non-string id", 42, "invalid_target"],
    ])("rejects %s with a clear error and writes nothing", async (_label, target, issue) => {
      mocks.subflow.mockReturnValue(true);
      const { rpc, writes } = adminDouble({ error: null }, [B]);
      const self = issue === "target_is_self";
      const response = await put(graph(call(target)), self ? String(target) : "flow-1");
      const json = await response.json();
      expect(response.status).toBe(422);
      expect(json).toMatchObject({ code: "invalid_subflow_target", issues: [{ node_key: "call", issue }] });
      expect(json.error).toMatch(/Nothing was saved/);
      expect(rpc).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
    });

    it("does not save when the reference cannot be verified", async () => {
      mocks.subflow.mockReturnValue(true);
      const { rpc } = adminDouble({ error: null }, [B], { message: "db down" });
      expect((await put(graph(call(B)))).status).toBe(503);
      expect(rpc).not.toHaveBeenCalled();
    });

    it("maps the database guards (migration 068) to clear responses", async () => {
      mocks.subflow.mockReturnValue(true);
      let { rpc } = adminDouble({ error: { code: "23503", message: "execute_flow target flow is not a flow of this account" } }, [B]);
      let response = await put(graph(call(B)));
      expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ code: "invalid_subflow_target" }); expect(rpc).toHaveBeenCalledTimes(1);
      ({ rpc } = adminDouble({ error: { code: "0A000", message: "execute_flow nodes cannot be added to an active flow" } }, [B]));
      response = await put(graph(call(B)));
      expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "subflow_requires_draft" });
    });

    it("flows without the node are unaffected by the flag, whatever its value", async () => {
      for (const flag of [false, true]) {
        mocks.subflow.mockReturnValue(flag);
        const { rpc, lookups } = adminDouble();
        expect((await put({ nodes: [{ node_key: "m", node_type: "send_message", config: { text: "hi" } }] })).status).toBe(200);
        expect(rpc).toHaveBeenCalledTimes(1); expect(lookups).toHaveLength(0);
      }
    });
  });

  describe("durable waits (delay with a unit)", () => {
    const wait = (config: Record<string, unknown>) => ({ nodes: [{ node_key: "start", node_type: "start", config: { next_node_key: "pause" } }, { node_key: "pause", node_type: "delay", config: { ...config, next_node_key: "end" } }, { node_key: "end", node_type: "end", config: {} }] });

    it("an account without the flag cannot save one: 403, nothing written; the flag is the session account's, never the body's", async () => {
      const { rpc } = adminDouble();
      const response = await put({ ...wait({ amount: 13, unit: "minutes" }), durableWaitAuthoring: true });
      expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ code: "durable_wait_authoring_disabled" });
      expect(rpc).not.toHaveBeenCalled(); expect(mocks.durableAuthoring).toHaveBeenCalledWith(ACCOUNT);
    });
    it("an authorised account saves a 13-minute wait exactly as authored (amount and unit are kept)", async () => {
      mocks.durableAuthoring.mockReturnValue(true); const { rpc } = adminDouble();
      expect((await put(wait({ amount: 13, unit: "minutes" }))).status).toBe(200);
      expect(rpc.mock.calls[0][1].p_nodes.find((n: { node_key: string }) => n.node_key === "pause").config).toEqual({ amount: 13, unit: "minutes", next_node_key: "end" });
    });
    it.each([[{ amount: 31, unit: "days" }, "too_long"], [{ amount: 0, unit: "minutes" }, "invalid_amount"], [{ amount: 1.5, unit: "hours" }, "invalid_amount"], [{ amount: 5, unit: "weeks" }, "invalid_unit"]])("rejects %j (%s) with 422 and writes nothing", async (config, issue) => {
      mocks.durableAuthoring.mockReturnValue(true); const { rpc } = adminDouble();
      const response = await put(wait(config)); expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: "invalid_durable_wait", issues: [{ node_key: "pause", issue }] }); expect(rpc).not.toHaveBeenCalled();
    });
    it("legacy short delays are untouched for every account", async () => {
      const { rpc } = adminDouble(); expect((await put(wait({ seconds: 10 }))).status).toBe(200); expect(rpc).toHaveBeenCalledTimes(1); expect(mocks.durableAuthoring).not.toHaveBeenCalled();
    });
    it("maps the database guard for a wait in an active flow", async () => {
      mocks.durableAuthoring.mockReturnValue(true); adminDouble({ error: { code: "0A000", message: "durable waits cannot be added to an active flow: waiting is not enabled" } });
      const response = await put(wait({ amount: 5, unit: "minutes" })); expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "durable_wait_requires_draft" });
    });
  });
});
