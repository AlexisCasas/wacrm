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
    expect(mocks.validateReferences).toHaveBeenCalledWith(context.supabase, context.accountId, expect.any(Array), false, false);
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

  it("refuses to activate a flow with a customer-activity condition when the account does not have it, before any update", async () => {
    const update = vi.fn();
    const flowQuery = { select: () => ({ eq: () => ({ maybeSingle: vi.fn().mockResolvedValue({ data: { name: "Flow", trigger_type: "manual", trigger_config: {}, entry_node_id: "start" }, error: null }) }) }), update };
    const nodesQuery = { select: () => ({ eq: () => Promise.resolve({ data: [{ node_key: "start", node_type: "start", config: { next_node_key: "c" } }, { node_key: "c", node_type: "condition", config: { subject: "customer_activity", subject_key: "info", operator: "replied_after_reference", true_next: "end", false_next: "end" } }], error: null }) }) };
    mocks.admin.mockReturnValue({ from: vi.fn().mockImplementation((table: string) => table === "flows" ? flowQuery : nodesQuery) });
    const response = await POST(new Request("http://localhost/api/flows/flow-1/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "active" }) }), params);
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "customer_reply_condition_disabled" }); expect(update).not.toHaveBeenCalled();
  });
});

describe("POST /api/flows/[id]/activate — voice notes", () => {
  const activate = () => POST(new Request("http://localhost/api/flows/flow-1/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "active" }) }), params);

  it("hands the validator the SERVER's answer for the session account, and the account id for the ownership check", async () => {
    mocks.validateReferences.mockResolvedValue([]);
    mocks.admin.mockReturnValue({ from: vi.fn().mockImplementation((table: string) => table === "flows"
      ? { select: () => ({ eq: () => ({ maybeSingle: vi.fn().mockResolvedValue({ data: { name: "Flow", trigger_type: "manual", trigger_config: {}, entry_node_id: "start" }, error: null }) }) }), update: () => ({ eq: () => ({ select: () => ({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: "flow-1" }, error: null }) }) }) }) }
      : { select: () => ({ eq: () => Promise.resolve({ data: [{ node_key: "start", node_type: "start", config: {} }], error: null }) }) }) });
    delete process.env.FLOW_VOICE_NOTE_ACCOUNT_IDS;
    await activate();
    expect(mocks.validateGraph.mock.calls.at(-1)?.[2]).toMatchObject({ accountId: context.accountId, voiceNoteEnabled: false });
    process.env.FLOW_VOICE_NOTE_ACCOUNT_IDS = context.accountId;
    try { await activate(); expect(mocks.validateGraph.mock.calls.at(-1)?.[2]).toMatchObject({ voiceNoteEnabled: true }); }
    finally { delete process.env.FLOW_VOICE_NOTE_ACCOUNT_IDS; }
  });

  it("a voice-note error from the validator stops the activation with 422 and no status update", async () => {
    const update = vi.fn();
    mocks.validateReferences.mockResolvedValue([]);
    mocks.validateGraph.mockReturnValue([{ severity: "error", scope: "node", node_key: "v", field: "media_type", message: "Voice notes are not enabled for this account." }]);
    mocks.admin.mockReturnValue({ from: vi.fn().mockImplementation((table: string) => table === "flows"
      ? { select: () => ({ eq: () => ({ maybeSingle: vi.fn().mockResolvedValue({ data: { name: "Flow", trigger_type: "manual", trigger_config: {}, entry_node_id: "start" }, error: null }) }) }), update }
      : { select: () => ({ eq: () => Promise.resolve({ data: [{ node_key: "v", node_type: "send_media", config: { media_type: "audio" } }], error: null }) }) }) });
    const response = await activate();
    expect(response.status).toBe(422);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("POST /api/flows/[id]/activate — Audios por producto: optional tag and manual product", () => {
  const TAG = "11111111-1111-4111-8111-111111111111";
  const OWN_PRODUCT = "44444444-4444-4444-8444-444444444444";
  const activate = () => POST(new Request("http://localhost/api/flows/flow-1/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "active" }) }), params);
  const routes = { next_node_key: "end", unknown_node_key: "end", no_audios_node_key: "end" };

  function world(config: Record<string, unknown>, known: { tags?: string[]; products?: string[] } = {}) {
    const lookups: Array<{ table: string; ids: string[] }> = [];
    const update = vi.fn().mockResolvedValue({ data: { id: "flow-1" }, error: null });
    mocks.validateReferences.mockResolvedValue([]);
    mocks.validateGraph.mockReturnValue([]);
    mocks.admin.mockReturnValue({
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "flows") {
          return {
            select: () => ({ eq: () => ({ maybeSingle: vi.fn().mockResolvedValue({ data: { name: "Flow", trigger_type: "manual", trigger_config: {}, entry_node_id: "start" }, error: null }) }) }),
            update: () => ({ eq: () => ({ select: () => ({ maybeSingle: update }) }) }),
          };
        }
        if (table === "tags" || table === "audio_guide_products") {
          const rows = (table === "tags" ? known.tags : known.products) ?? [];
          return { select: () => ({ eq: () => ({ in: (_col: string, ids: string[]) => { lookups.push({ table, ids }); return Promise.resolve({ data: ids.filter((id) => rows.includes(id)).map((id) => ({ id })), error: null }); } }) }) };
        }
        return { select: () => ({ eq: () => Promise.resolve({ data: [{ node_key: "start", node_type: "start", config: { next_node_key: "vp" } }, { node_key: "vp", node_type: "send_product_audios", config }, { node_key: "end", node_type: "end", config: {} }], error: null }) }) };
      }),
    });
    return { lookups, update };
  }

  it("a product chosen by hand that is NOT this account's is refused before any update", async () => {
    const w = world({ gate_mode: "none", gate_tag_id: "", product_source: "manual", product_id: OWN_PRODUCT, ...routes }, { products: [] });
    const response = await activate();
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.issues).toEqual(expect.arrayContaining([expect.objectContaining({ node_key: "vp", field: "product_id", code: "product_audios_product_unknown" })]));
    expect(w.lookups).toEqual([{ table: "audio_guide_products", ids: [OWN_PRODUCT] }]);
    expect(w.update).not.toHaveBeenCalled();
  });

  it("a product chosen by hand that exists in the account lets the flow activate", async () => {
    const w = world({ gate_mode: "none", gate_tag_id: "", product_source: "manual", product_id: OWN_PRODUCT, ...routes }, { products: [OWN_PRODUCT] });
    expect((await activate()).status).toBe(200);
    expect(w.update).toHaveBeenCalled();
  });

  it("a node without a tag does not look for any tag", async () => {
    const w = world({ gate_mode: "none", gate_tag_id: "", product_source: "auto", ...routes });
    expect((await activate()).status).toBe(200);
    expect(w.lookups.filter((l) => l.table === "tags")).toHaveLength(0);
    expect(w.lookups.filter((l) => l.table === "audio_guide_products")).toHaveLength(0);
  });

  it("a node saved before the options existed still has its tag checked against the account", async () => {
    const w = world({ gate_tag_id: TAG, product_field_id: "", ...routes, gate_closed_node_key: "end" }, { tags: [] });
    const response = await activate();
    expect(response.status).toBe(422);
    expect((await response.json()).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "product_audios_gate_unknown" })]));
    expect(w.lookups).toEqual([{ table: "tags", ids: [TAG] }]);
    expect(w.update).not.toHaveBeenCalled();
  });

  it("a legacy node whose tag is the account's can activate (nothing changed for it)", async () => {
    const w = world({ gate_tag_id: TAG, product_field_id: "", ...routes, gate_closed_node_key: "end" }, { tags: [TAG] });
    expect((await activate()).status).toBe(200);
    expect(w.update).toHaveBeenCalled();
  });
});

describe("POST /api/flows/[id]/activate — Audios por producto: one specific audio", () => {
  const PU = "c1111111-1111-4111-8111-111111111111", ID = "d1111111-1111-4111-8111-111111111111", PRODUCT = "44444444-4444-4444-8444-444444444444";
  const activate = () => POST(new Request("http://localhost/api/flows/flow-1/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "active" }) }), params);
  const routes = { next_node_key: "end", unknown_node_key: "end", no_audios_node_key: "end" };
  const single = (over: Record<string, unknown> = {}) => ({ gate_mode: "none", gate_tag_id: "", product_source: "auto", audio_selection: "single", purpose_id: PU, identifier_id: ID, ...routes, ...over });

  function world(config: Record<string, unknown>, rows: { purposes?: Array<{ id: string; active: boolean }>; identifiers?: Array<{ id: string; active: boolean }>; items?: Array<Record<string, unknown>> } = {}) {
    const lookups: Array<{ table: string; ids: string[] }> = [];
    const update = vi.fn().mockResolvedValue({ data: { id: "flow-1" }, error: null });
    mocks.validateReferences.mockResolvedValue([]);
    mocks.validateGraph.mockReturnValue([]);
    const byTable: Record<string, Array<Record<string, unknown>>> = { audio_guide_purposes: rows.purposes ?? [], audio_guide_identifiers: rows.identifiers ?? [], audio_guide_items: rows.items ?? [], audio_guide_products: [{ id: PRODUCT }] };
    mocks.admin.mockReturnValue({
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "flows") {
          return {
            select: () => ({ eq: () => ({ maybeSingle: vi.fn().mockResolvedValue({ data: { name: "Flow", trigger_type: "manual", trigger_config: {}, entry_node_id: "start" }, error: null }) }) }),
            update: () => ({ eq: () => ({ select: () => ({ maybeSingle: update }) }) }),
          };
        }
        if (table in byTable) {
          return { select: () => ({ eq: () => ({ in: (col: string, ids: string[]) => { lookups.push({ table, ids }); return Promise.resolve({ data: byTable[table].filter((r) => ids.includes(String(r[col === "product_id" ? "product_id" : "id"]))), error: null }); } }) }) };
        }
        return { select: () => ({ eq: () => Promise.resolve({ data: [{ node_key: "start", node_type: "start", config: { next_node_key: "vp" } }, { node_key: "vp", node_type: "send_product_audios", config }, { node_key: "end", node_type: "end", config: {} }], error: null }) }) };
      }),
    });
    return { lookups, update };
  }
  const codes = async (response: Response) => ((await response.json()) as { issues?: Array<{ code?: string; severity: string }> }).issues ?? [];

  it("a purpose or identifier that is NOT this account's is an error: nothing is activated", async () => {
    const w = world(single(), { purposes: [], identifiers: [{ id: ID, active: true }] });
    const response = await activate();
    expect(response.status).toBe(422);
    expect(await codes(response)).toEqual(expect.arrayContaining([expect.objectContaining({ code: "product_audios_purpose_unknown", severity: "error" })]));
    expect(w.lookups).toEqual(expect.arrayContaining([{ table: "audio_guide_purposes", ids: [PU] }, { table: "audio_guide_identifiers", ids: [ID] }]));
    expect(w.update).not.toHaveBeenCalled();
    world(single(), { purposes: [{ id: PU, active: true }], identifiers: [] });
    expect(await codes(await activate())).toEqual(expect.arrayContaining([expect.objectContaining({ code: "product_audios_identifier_unknown" })]));
  });

  it("an incomplete node (no purpose or identifier) is refused by the validator's contract, not guessed: it never reaches the account lookups", async () => {
    const w = world(single({ purpose_id: "", identifier_id: "" }));
    mocks.validateGraph.mockReturnValue([{ severity: "error", scope: "node", node_key: "vp", field: "purpose_id", code: "product_audios_purpose_missing", message: "x" }]);
    const response = await activate();
    expect(response.status).toBe(422);
    expect(w.lookups).toEqual([]);
    expect(w.update).not.toHaveBeenCalled();
  });

  it("valid values of the account let it activate; an inactive purpose or identifier only warns", async () => {
    const ok = world(single(), { purposes: [{ id: PU, active: true }], identifiers: [{ id: ID, active: true }] });
    expect((await activate()).status).toBe(200);
    expect(ok.update).toHaveBeenCalled();
    const off = world(single(), { purposes: [{ id: PU, active: false }], identifiers: [{ id: ID, active: false }] });
    const response = await activate();
    expect(response.status).toBe(200);
    expect(off.update).toHaveBeenCalled();
    expect(((await response.json()) as { warnings: Array<{ code: string }> }).warnings.map((w) => w.code).sort()).toEqual(["product_audios_identifier_inactive", "product_audios_purpose_inactive"]);
  });

  it("with the product chosen by hand it also checks the audio exists and is on; when not, it warns but still activates (the node would take 'no audios')", async () => {
    const config = single({ product_source: "manual", product_id: PRODUCT });
    const names = { purposes: [{ id: PU, active: true }], identifiers: [{ id: ID, active: true }] };
    for (const [items, expectCode] of [
      [[], "product_audios_audio_not_classified"],
      [[{ product_id: PRODUCT, purpose_id: PU, identifier_id: ID, status: "disabled" }], "product_audios_audio_disabled"],
    ] as const) {
      const w = world(config, { ...names, items: items as unknown as Array<Record<string, unknown>> });
      // The warning is not an error: the flow activates, and the warning travels with the answer.
      const response = await activate();
      expect(response.status, expectCode).toBe(200);
      expect(((await response.json()) as { warnings?: Array<{ code: string; node_key: string }> }).warnings).toEqual([expect.objectContaining({ code: expectCode, node_key: "vp" })]);
      expect(w.lookups.some((l) => l.table === "audio_guide_items")).toBe(true);
      expect(w.update).toHaveBeenCalled();
    }
    const ok = world(config, { ...names, items: [{ product_id: PRODUCT, purpose_id: PU, identifier_id: ID, status: "active" }] });
    expect((await activate()).status).toBe(200);
    expect(ok.update).toHaveBeenCalled();
  });

  it("a node that sends 'all' (or has no selection) never reads purposes, identifiers or audios", async () => {
    const w = world({ gate_mode: "none", gate_tag_id: "", product_source: "auto", ...routes });
    expect((await activate()).status).toBe(200);
    expect(w.lookups).toEqual([]);
  });
});
