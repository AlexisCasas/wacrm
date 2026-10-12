import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  validateGraph: vi.fn(),
  validateReferences: vi.fn(),
  enabled: vi.fn(),
  admin: vi.fn(),
}));

vi.mock("@/lib/auth/account", () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() => Response.json({ error: "auth" }, { status: 403 })),
}));
vi.mock("@/lib/flows/validate", () => ({ validateFlowForActivation: mocks.validateGraph }));
vi.mock("@/lib/flows/condition-references", () => ({
  ConditionReferenceInfrastructureError: class extends Error {},
  validateConditionReferences: mocks.validateReferences,
}));
vi.mock("@/lib/flows/custom-condition-capability", () => ({ isCustomConditionEnabledForAccount: mocks.enabled }));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: mocks.admin }));

import { POST } from "./route";

const params = { params: Promise.resolve({ id: "flow-1" }) };
const revision = "2026-10-12T12:00:00.000Z";

function clientForActivation() {
  let flowCalls = 0;
  const flow = { id: "flow-1", name: "Flow", description: null, trigger_type: "manual", trigger_config: {}, entry_node_id: "start", fallback_policy: {} };
  const nodes = [{ node_key: "start", node_type: "start", config: {} }];
  const supabase = {
    from: vi.fn((table: string) => {
      if (table === "flow_nodes") {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ order: vi.fn(() => Promise.resolve({ data: nodes, error: null })) })) })) };
      }
      flowCalls += 1;
      const data = flowCalls === 1 ? { id: "flow-1" } : flow;
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data, error: null }) })) })) };
    }),
    rpc: vi.fn(),
  };
  return supabase;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.validateGraph.mockReturnValue([]);
  mocks.validateReferences.mockResolvedValue([]);
  mocks.enabled.mockReturnValue(false);
  mocks.admin.mockReturnValue({ rpc: vi.fn() });
});

describe("POST /api/flows/[id]/activate", () => {
  it("rejects direct activation with a disabled custom condition before publication", async () => {
    const supabase = clientForActivation();
    mocks.requireRole.mockResolvedValue({ accountId: "11111111-1111-4111-8111-111111111111", supabase });
    mocks.validateReferences.mockResolvedValue([{ node_key: "start", issue: "custom_condition_capability_disabled" }]);

    const response = await POST(
      new Request("http://localhost/api/flows/flow-1/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "active", expected_updated_at: revision }),
      }),
      params,
    );

    expect(response.status).toBe(422);
    expect(mocks.admin().rpc).not.toHaveBeenCalled();
  });

  it("maps a concurrent publication to HTTP 409 without exposing database details", async () => {
    const supabase = clientForActivation();
    const admin = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "40001", message: "raw SQL state" } }) };
    mocks.admin.mockReturnValue(admin);
    mocks.requireRole.mockResolvedValue({ accountId: "11111111-1111-4111-8111-111111111111", supabase });

    const response = await POST(
      new Request("http://localhost/api/flows/flow-1/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "active", expected_updated_at: revision }),
      }),
      params,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "flow_revision_conflict" });
    expect(admin.rpc).toHaveBeenCalledWith("publish_flow_version", expect.objectContaining({ p_expected_updated_at: revision }));
  });

  it("normalizes the single PostgREST publication row", async () => {
    const supabase = clientForActivation();
    const admin = { rpc: vi.fn().mockResolvedValue({ data: [{ version_id: "version-1", version_number: 1, updated_at: "2026-10-12T12:01:00.000Z" }], error: null }) };
    mocks.admin.mockReturnValue(admin);
    mocks.requireRole.mockResolvedValue({ accountId: "11111111-1111-4111-8111-111111111111", userId: "user-1", supabase });

    const response = await POST(new Request("http://localhost/api/flows/flow-1/activate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "active", expected_updated_at: revision }),
    }), params);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ updated_at: "2026-10-12T12:01:00.000Z", active_version: { id: "version-1", version_number: 1 } });
    expect(admin.rpc).toHaveBeenCalledWith("publish_flow_version", expect.objectContaining({
      p_published_by: "user-1",
      p_expected_definition: expect.objectContaining({ flow: expect.objectContaining({ id: "flow-1" }) }),
    }));
  });
});
