import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireRole: vi.fn(), createClient: vi.fn(), admin: vi.fn(), validateReferences: vi.fn(), enabled: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({ requireRole: mocks.requireRole, toErrorResponse: vi.fn(() => Response.json({ error: "auth" }, { status: 403 })) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("@/lib/flows/condition-references", () => ({ ConditionReferenceInfrastructureError: class extends Error {}, validateConditionReferences: mocks.validateReferences }));
vi.mock("@/lib/flows/custom-condition-capability", () => ({ isCustomConditionEnabledForAccount: mocks.enabled }));

import { PUT } from "./route";

const params = { params: Promise.resolve({ id: "flow-1" }) };
const context = { accountId: "11111111-1111-4111-8111-111111111111", supabase: {}, userId: "u", role: "agent", account: { id: "11111111-1111-4111-8111-111111111111", name: "A" } };

beforeEach(() => {
  mocks.requireRole.mockResolvedValue(context);
  mocks.createClient.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u" } } }) }, from: vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: "flow-1" } }) }) }) })) });
  const from = vi.fn();
  mocks.admin.mockReturnValue({ from });
  mocks.validateReferences.mockResolvedValue([{ node_key: "c", issue: "custom_condition_capability_disabled" }]);
  mocks.enabled.mockReturnValue(true);
});

describe("PUT /api/flows/[id]", () => {
  it("rejects direct custom-condition writes before the service client writes metadata or replaces nodes", async () => {
    const response = await PUT(new Request("http://localhost/api/flows/flow-1", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodes: [{ node_key: "c", node_type: "condition", config: { subject: "contact_field", subject_key: "custom:22222222-2222-4222-8222-222222222222" } }] }) }), params);
    expect(response.status).toBe(422);
    expect(mocks.validateReferences).toHaveBeenCalled();
    expect(mocks.admin().from).not.toHaveBeenCalled();
  });
});
