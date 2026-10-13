import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireRole: vi.fn(), createClient: vi.fn(), admin: vi.fn(), validateReferences: vi.fn(), enabled: vi.fn(), toErrorResponse: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({ requireRole: mocks.requireRole, toErrorResponse: mocks.toErrorResponse }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("@/lib/flows/condition-references", () => ({ ConditionReferenceInfrastructureError: class extends Error {}, validateConditionReferences: mocks.validateReferences }));
vi.mock("@/lib/flows/custom-condition-capability", () => ({ isCustomConditionEnabledForAccount: mocks.enabled }));

import { PUT } from "./route";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const params = { params: Promise.resolve({ id: "flow-1" }) };
const context = { accountId: ACCOUNT, supabase: {}, userId: "u", role: "agent", account: { id: ACCOUNT, name: "A" } };
const savedFlow = { id: "flow-1", name: "Saved", status: "draft" };
const savedNodes = [{ id: "n1", node_key: "start" }];

/** Admin client double: `rpc` is the atomic save, `from` only serves the reads that follow it (and the capability pre-check). */
function adminDouble(rpcResult: { error: { code?: string; message?: string } | null } = { error: null }) {
  const rpc = vi.fn().mockResolvedValue(rpcResult);
  const writes = vi.fn();
  const from = vi.fn((table: string) => ({
    select: () => ({
      eq: () => ({
        maybeSingle: vi.fn().mockResolvedValue({ data: table === "flows" ? savedFlow : null }),
        order: vi.fn().mockResolvedValue({ data: savedNodes }),
        then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
      }),
    }),
    update: writes, delete: writes, insert: writes, upsert: writes,
  }));
  mocks.admin.mockReturnValue({ from, rpc });
  return { rpc, from, writes };
}
const put = (body: unknown) => PUT(new Request("http://localhost/api/flows/flow-1", { method: "PUT", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }), params);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.requireRole.mockResolvedValue(context);
  mocks.toErrorResponse.mockReturnValue(Response.json({ error: "auth" }, { status: 403 }));
  mocks.createClient.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u" } } }) }, from: vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: "flow-1" } }) }) }) })) });
  mocks.validateReferences.mockResolvedValue([]);
  mocks.enabled.mockReturnValue(true);
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
});
