// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { FlowEditorProvider } from "../flow-editor-state";
import { NodeConfigForm } from "./node-config-form";
import { resetSubflowAuthoringCache } from "../use-subflow-authoring";
import type { FlowNodeRow, FlowRow } from "@/lib/flows/types";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: null }) }));
const flowsInAccount = vi.hoisted(() => ({ rows: [] as Array<{ id: string; name: string; status: string }> }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ from: () => ({ select: () => ({ order: () => ({ limit: () => Promise.resolve({ data: flowsInAccount.rows, error: null }) }) }) }) }),
}));

const SELF = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const FLOW = { id: SELF, name: "Flow A", description: null, status: "draft", trigger_type: "manual", trigger_config: {}, entry_node_id: "start", fallback_policy: {}, user_id: "u", account_id: "a", created_at: "", updated_at: "" } as unknown as FlowRow;
const node = (target: string) => ({ node_key: "call", node_type: "execute_flow" as const, config: { target_flow_id: target, next_node_key: "" } });
const all = (target: string) => [{ node_key: "start", node_type: "start" as const, config: {} }, node(target), { node_key: "end", node_type: "end" as const, config: {} }];
function mount(target: string, capability: boolean) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ customConditions: false, subflowAuthoring: capability })));
  return render(
    <FlowEditorProvider initialFlow={FLOW} initialNodes={[] as FlowNodeRow[]}>
      <NodeConfigForm node={node(target)} allNodes={all(target)} showAdvanced={false} onUpdateConfig={() => {}} />
    </FlowEditorProvider>,
  );
}

beforeEach(() => { resetSubflowAuthoringCache(); flowsInAccount.rows = [{ id: SELF, name: "Flow A", status: "draft" }, { id: B, name: "Flow B", status: "draft" }]; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("execute_flow node form", () => {
  it("shows the selected flow of the same account and the draft-only notice when the account is opted in", async () => {
    mount(B, true);
    await waitFor(() => expect(screen.getByText("Flow B · flowStatusDraft")).toBeTruthy());
    expect(screen.getByText("subflowDraftOnly")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("warns clearly when the stored target does not exist (deleted or another account)", async () => {
    mount("99999999-9999-4999-8999-999999999999", true);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("targetFlowMissing"));
  });
  it("never offers the flow itself as its own target (it is treated as unavailable)", async () => {
    mount(SELF, true);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("targetFlowMissing"));
  });
  it("tells the user the feature is off when the server did not opt the account in", async () => {
    mount(B, false);
    await waitFor(() => expect(screen.getByText("subflowAuthoringDisabled")).toBeTruthy());
  });
});
