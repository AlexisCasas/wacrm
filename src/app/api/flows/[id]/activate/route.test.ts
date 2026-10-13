import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  createClient: vi.fn(),
  admin: vi.fn(),
  validateGraph: vi.fn(),
  validateReferences: vi.fn(),
  enabled: vi.fn(),
  durableExec: vi.fn(),
}));

vi.mock("@/lib/auth/account", () => ({ requireRole: mocks.requireRole, toErrorResponse: vi.fn(() => Response.json({ error: "auth" }, { status: 403 })) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("@/lib/flows/validate", () => ({ validateFlowForActivation: mocks.validateGraph }));
vi.mock("@/lib/flows/condition-references", () => ({ ConditionReferenceInfrastructureError: class extends Error {}, validateConditionReferences: mocks.validateReferences }));
vi.mock("@/lib/flows/custom-condition-capability", () => ({ isCustomConditionEnabledForAccount: mocks.enabled }));
vi.mock("@/lib/flows/durable-wait-capability", () => ({ isDurableWaitExecutionEnabledForAccount: mocks.durableExec }));

import { POST } from "./route";

const params = { params: Promise.resolve({ id: "flow-1" }) };
const context = { accountId: "11111111-1111-4111-8111-111111111111", supabase: {}, userId: "u", role: "agent", account: { id: "11111111-1111-4111-8111-111111111111", name: "A" } };

beforeEach(() => {
  mocks.requireRole.mockResolvedValue(context);
  mocks.createClient.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u" } } }) }, from: vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: "flow-1" } }) }) }) })) });
  const flowQuery = { select: () => ({ eq: () => ({ maybeSingle: vi.fn().mockResolvedValue({ data: { name: "Flow", trigger_type: "manual", trigger_config: {}, entry_node_id: "start" }, error: null }) }) }) };
  const nodesQuery = { select: () => ({ eq: () => Promise.resolve({ data: [{ node_key: "c", node_type: "condition", config: {} }], error: null }) }) };
  mocks.admin.mockReturnValue({ from: vi.fn().mockImplementation((table: string) => table === "flows" ? flowQuery : nodesQuery) });
  mocks.validateGraph.mockReturnValue([]);
  mocks.validateReferences.mockResolvedValue([{ node_key: "c", issue: "custom_condition_capability_disabled" }]);
  mocks.enabled.mockReturnValue(false);
  mocks.durableExec.mockReturnValue(false);
});

describe("POST /api/flows/[id]/activate", () => {
  it("rejects a direct activation with a disabled custom condition before status update", async () => {
    const response = await POST(new Request("http://localhost/api/flows/flow-1/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "active" }) }), params);
    expect(response.status).toBe(422);
    expect(mocks.validateReferences).toHaveBeenCalledWith(context.supabase, context.accountId, expect.any(Array), false);
  });

  it("refuses to activate a flow that runs another flow, before any status update (pilot: authoring only)", async () => {
    const update = vi.fn();
    const flowQuery = { select: () => ({ eq: () => ({ maybeSingle: vi.fn().mockResolvedValue({ data: { name: "Flow", trigger_type: "manual", trigger_config: {}, entry_node_id: "start" }, error: null }) }) }), update };
    const nodesQuery = { select: () => ({ eq: () => Promise.resolve({ data: [{ node_key: "start", node_type: "start", config: { next_node_key: "call" } }, { node_key: "call", node_type: "execute_flow", config: { target_flow_id: "22222222-2222-4222-8222-222222222222", next_node_key: "end" } }], error: null }) }) };
    mocks.admin.mockReturnValue({ from: vi.fn().mockImplementation((table: string) => table === "flows" ? flowQuery : nodesQuery) });
    const response = await POST(new Request("http://localhost/api/flows/flow-1/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "active" }) }), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "subflow_execution_disabled" });
    expect(update).not.toHaveBeenCalled();
  });

  it("maps the database guard (0A000) to the same refusal if it fires at update time", async () => {
    const flowQuery = {
      select: () => ({ eq: () => ({ maybeSingle: vi.fn().mockResolvedValue({ data: { name: "Flow", trigger_type: "manual", trigger_config: {}, entry_node_id: "start" }, error: null }) }) }),
      update: () => ({ eq: () => ({ select: () => ({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { code: "0A000", message: "flows with execute_flow nodes cannot be activated" } }) }) }) }),
    };
    const nodesQuery = { select: () => ({ eq: () => Promise.resolve({ data: [{ node_key: "start", node_type: "start", config: {} }], error: null }) }) };
    mocks.admin.mockReturnValue({ from: vi.fn().mockImplementation((table: string) => table === "flows" ? flowQuery : nodesQuery) });
    mocks.validateReferences.mockResolvedValue([]);
    const response = await POST(new Request("http://localhost/api/flows/flow-1/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "active" }) }), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "subflow_execution_disabled" });
  });

  it("refuses to activate a flow that contains a durable wait while execution is disabled (the default), before any update", async () => {
    const update = vi.fn();
    const flowQuery = { select: () => ({ eq: () => ({ maybeSingle: vi.fn().mockResolvedValue({ data: { name: "Flow", trigger_type: "manual", trigger_config: {}, entry_node_id: "start" }, error: null }) }) }), update };
    const nodesQuery = { select: () => ({ eq: () => Promise.resolve({ data: [{ node_key: "start", node_type: "start", config: { next_node_key: "w" } }, { node_key: "w", node_type: "delay", config: { amount: 13, unit: "minutes", next_node_key: "end" } }], error: null }) }) };
    mocks.admin.mockReturnValue({ from: vi.fn().mockImplementation((table: string) => table === "flows" ? flowQuery : nodesQuery) });
    const response = await POST(new Request("http://localhost/api/flows/flow-1/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "active" }) }), params);
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "durable_wait_execution_disabled" }); expect(update).not.toHaveBeenCalled();
    expect(mocks.durableExec).toHaveBeenCalledWith(context.accountId);
  });
});
