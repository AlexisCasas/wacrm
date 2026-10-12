import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  validateReferences: vi.fn(),
  enabled: vi.fn(),
}));

vi.mock("@/lib/auth/account", () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() => Response.json({ error: "auth" }, { status: 403 })),
}));
vi.mock("@/lib/flows/condition-references", () => ({
  ConditionReferenceInfrastructureError: class extends Error {},
  validateConditionReferences: mocks.validateReferences,
}));
vi.mock("@/lib/flows/custom-condition-capability", () => ({
  isCustomConditionEnabledForAccount: mocks.enabled,
}));

import { PUT } from "./route";

const params = { params: Promise.resolve({ id: "flow-1" }) };
const revision = "2026-10-12T12:00:00.000Z";

function readableClient() {
  const maybeSingle = vi.fn().mockResolvedValue({ data: { id: "flow-1" }, error: null });
  const supabase = {
    from: vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle })) })) })),
    rpc: vi.fn(),
  };
  return supabase;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.validateReferences.mockResolvedValue([]);
  mocks.enabled.mockReturnValue(true);
});

describe("PUT /api/flows/[id]", () => {
  it("rejects disabled custom-condition writes before the transactional RPC", async () => {
    const supabase = readableClient();
    mocks.requireRole.mockResolvedValue({ accountId: "11111111-1111-4111-8111-111111111111", supabase });
    mocks.enabled.mockReturnValue(false);
    mocks.validateReferences.mockResolvedValue([{ node_key: "c", issue: "custom_condition_capability_disabled" }]);

    const response = await PUT(
      new Request("http://localhost/api/flows/flow-1", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_updated_at: revision,
          nodes: [{ node_key: "c", node_type: "condition", config: { subject: "contact_field", subject_key: "custom:field" } }],
        }),
      }),
      params,
    );

    expect(response.status).toBe(422);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("maps a stale revision from the RPC to a sanitized conflict", async () => {
    const supabase = readableClient();
    supabase.rpc.mockResolvedValue({ data: null, error: { code: "40001", message: "internal detail" } });
    mocks.requireRole.mockResolvedValue({ accountId: "11111111-1111-4111-8111-111111111111", supabase });

    const response = await PUT(
      new Request("http://localhost/api/flows/flow-1", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expected_updated_at: revision, name: "Renamed" }),
      }),
      params,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "flow_revision_conflict" });
    expect(supabase.rpc).toHaveBeenCalledWith("save_flow_draft", expect.objectContaining({ p_expected_updated_at: revision }));
  });

  it("returns the one PostgREST row's revision after a successful save", async () => {
    const supabase = readableClient();
    supabase.rpc.mockResolvedValue({ data: [{ updated_at: "2026-10-12T12:01:00.000Z" }], error: null });
    mocks.requireRole.mockResolvedValue({ accountId: "11111111-1111-4111-8111-111111111111", supabase });

    const response = await PUT(new Request("http://localhost/api/flows/flow-1", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_updated_at: revision, name: "Renamed" }),
    }), params);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ updated_at: "2026-10-12T12:01:00.000Z" });
  });
});
