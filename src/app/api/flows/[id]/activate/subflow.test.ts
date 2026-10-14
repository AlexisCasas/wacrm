import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireRole: vi.fn(), createClient: vi.fn(), admin: vi.fn(), allowed: vi.fn(), durableExec: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({ requireRole: mocks.requireRole, toErrorResponse: vi.fn(() => Response.json({ error: "auth" }, { status: 403 })) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("@/lib/flows/condition-references", () => ({ ConditionReferenceInfrastructureError: class extends Error {}, validateConditionReferences: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/flows/durable-wait-capability", () => ({ isDurableWaitExecutionEnabledForAccount: mocks.durableExec }));
vi.mock("@/lib/flows/subflow-activation", async (orig) => ({ ...(await orig<typeof import("@/lib/flows/subflow-activation")>()), isSubflowExecutionAllowed: mocks.allowed }));

import { POST } from "./route";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const params = { params: Promise.resolve({ id: ME }) };
const context = { accountId: ACCOUNT, supabase: {}, userId: "u", role: "agent", account: { id: ACCOUNT, name: "A" } };
const myNodes = [
  { node_key: "start", node_type: "start", config: { next_node_key: "call" } },
  { node_key: "call", node_type: "execute_flow", config: { target_flow_id: B, next_node_key: "end" } },
  { node_key: "end", node_type: "end", config: {} },
];

/** Admin double for the three reads the route makes (the flow, its nodes, the account's flows + their call / end nodes) and the update. */
function adminDouble(accountFlows: Array<{ id: string; status: string }>, otherNodes: Array<{ flow_id: string; node_type: string; config: Record<string, unknown> }>) {
  const update = vi.fn();
  const from = vi.fn((table: string) => {
    if (table === "flows") return {
      select: (cols: string) => ({
        eq: (col: string) => col === "id"
          ? { maybeSingle: async () => ({ data: { name: "Flow", trigger_type: "manual", trigger_config: {}, entry_node_id: "start" }, error: null }) }
          : Promise.resolve({ data: accountFlows, error: null }),
        then: undefined, cols,
      }),
      update: (patch: unknown) => { update(patch); return { eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: ME, status: "active" }, error: null }) }) }) }; },
    };
    return { select: () => ({ eq: () => Promise.resolve({ data: myNodes, error: null }), in: () => ({ in: () => Promise.resolve({ data: otherNodes, error: null }) }) }) };
  });
  mocks.admin.mockReturnValue({ from });
  return { update };
}
const activate = () => POST(new Request(`http://localhost/api/flows/${ME}/activate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "active" }) }), params);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRole.mockResolvedValue(context);
  mocks.createClient.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u" } } }) }, from: vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: ME } }) }) }) })) });
  mocks.durableExec.mockReturnValue(false); mocks.allowed.mockResolvedValue(true);
});

describe("POST /api/flows/[id]/activate: flows that run other flows (P8)", () => {
  it("refuses without BOTH switches (environment flag + backend table): 409, nothing updated", async () => {
    mocks.allowed.mockResolvedValue(false); const { update } = adminDouble([{ id: B, status: "active" }], []);
    const response = await activate(); expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "subflow_execution_disabled" }); expect(update).not.toHaveBeenCalled();
    expect(mocks.allowed).toHaveBeenCalledWith(expect.anything(), ACCOUNT);
  });
  it("activates when the account may run subflows and every target is an active flow of the account", async () => {
    const { update } = adminDouble([{ id: B, status: "active" }, { id: ME, status: "draft" }], [{ flow_id: B, node_type: "end", config: { scope: "subflow" } }]);
    const response = await activate(); expect(response.status).toBe(200); expect(update).toHaveBeenCalledTimes(1);
  });
  it("refuses a target that is not active yet, or that does not exist in the account (422, nothing updated)", async () => {
    const { update } = adminDouble([{ id: B, status: "draft" }], []);
    const draft = await activate(); expect(draft.status).toBe(422); expect(JSON.stringify(await draft.json())).toContain("must be active");
    adminDouble([{ id: C, status: "active" }], []);
    const missing = await activate(); expect(missing.status).toBe(422); expect(update).not.toHaveBeenCalled();
  });
  it("refuses a loop through the called flows", async () => {
    const { update } = adminDouble([{ id: B, status: "active" }, { id: ME, status: "draft" }], [{ flow_id: B, node_type: "execute_flow", config: { target_flow_id: ME } }]);
    const response = await activate(); expect(response.status).toBe(422); expect(JSON.stringify(await response.json())).toContain("loop"); expect(update).not.toHaveBeenCalled();
  });
  it("warns, without blocking, when the called flow never returns control", async () => {
    const { update } = adminDouble([{ id: B, status: "active" }, { id: ME, status: "draft" }], [{ flow_id: B, node_type: "end", config: {} }]);
    const response = await activate(); expect(response.status).toBe(200); expect(update).toHaveBeenCalledTimes(1);
  });
});
