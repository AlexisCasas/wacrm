// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { FlowEditorProvider } from "../flow-editor-state";
import { NodeConfigForm } from "./node-config-form";
import { resetSubflowAuthoringCache } from "../use-subflow-authoring";
import type { FlowNodeRow, FlowRow } from "@/lib/flows/types";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: () => ({ select: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Seguimiento", status: "active" }], error: null }) }) }) }) }) }));

const FLOW = { id: "f1", name: "F", description: null, status: "draft", trigger_type: "manual", trigger_config: {}, entry_node_id: "start", fallback_policy: {}, user_id: "u", account_id: "a", created_at: "", updated_at: "" } as unknown as FlowRow;
const NODES = [
  { node_key: "start", node_type: "start" as const, config: {} },
  { node_key: "info", node_type: "send_message" as const, config: { text: "Hidrolavadora", next_node_key: "call" } },
  { node_key: "end", node_type: "end" as const, config: {} },
];
/** What the closed selects currently display (the value the form holds). */
const shown = () => screen.getAllByRole("combobox").map((el) => (el.textContent ?? "").replace(/[^A-Za-z_]/g, ""));
function mount(node: { node_key: string; node_type: "execute_flow" | "end" | "condition"; config: Record<string, unknown> }, caps: Record<string, boolean> = { subflowAuthoring: true, customerReplyCondition: true }) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(caps)));
  const onUpdate = vi.fn();
  render(<FlowEditorProvider initialFlow={FLOW} initialNodes={[] as FlowNodeRow[]}><NodeConfigForm node={node} allNodes={[...NODES, node]} showAdvanced={false} onUpdateConfig={onUpdate} /></FlowEditorProvider>);
  return onUpdate;
}
beforeEach(() => resetSubflowAuthoringCache());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("execute_flow form (P8)", () => {
  it("offers the reference step, the reply policy (stop by default) and keeps the existing fields", async () => {
    mount({ node_key: "call", node_type: "execute_flow", config: { target_flow_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", next_node_key: "end", reference_node_key: "info" } });
    await waitFor(() => expect(screen.getByText("callReferenceLabel")).toBeTruthy());
    expect(screen.getByText("targetFlow")).toBeTruthy(); expect(screen.getByText("continuesAfterFlow")).toBeTruthy();
    expect(screen.getByText("onCustomerReplyLabel")).toBeTruthy(); expect(shown()).toContain("stop");      // default policy shown
    expect(screen.getByText("callReferenceClear")).toBeTruthy(); expect(screen.getByText("callReferenceHelp")).toBeTruthy();
  });
  it("without a reference there is nothing to clear", async () => {
    mount({ node_key: "call", node_type: "execute_flow", config: { target_flow_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", next_node_key: "end", on_customer_reply: "continue" } });
    await waitFor(() => expect(screen.getByText("callReferenceLabel")).toBeTruthy());
    expect(screen.queryByText("callReferenceClear")).toBeNull(); expect(shown()).toContain("continue");
  });
});

describe("end form (P8)", () => {
  it("defaults to ending the whole execution (the historic behaviour)", async () => {
    mount({ node_key: "fin", node_type: "end", config: {} });
    await waitFor(() => expect(screen.getByText("endScopeLabel")).toBeTruthy()); expect(shown()).toContain("run"); expect(shown()).not.toContain("subflow");
  });
  it("shows the saved 'return to the calling flow' choice after a reload", async () => {
    mount({ node_key: "fin", node_type: "end", config: { scope: "subflow" } });
    await waitFor(() => expect(shown()).toContain("subflow")); expect(screen.getByText("endScopeHelp")).toBeTruthy();
  });
});

describe("condition form: reference inherited from the calling flow", () => {
  it("shows the inherited source and its explanation instead of a step picker", async () => {
    mount({ node_key: "c", node_type: "condition", config: { subject: "customer_activity", subject_key: "$inherited", operator: "replied_after_reference", true_next: "end", false_next: "end" } });
    await waitFor(() => expect(screen.getByText("referenceInheritedHelp")).toBeTruthy()); expect(shown()).toContain("inherited"); expect(screen.queryByText("pickReference")).toBeNull();
  });
  it("a local reference keeps the step picker", async () => {
    mount({ node_key: "c", node_type: "condition", config: { subject: "customer_activity", subject_key: "info", operator: "replied_after_reference", true_next: "end", false_next: "end" } });
    await waitFor(() => expect(shown()).toContain("own")); expect(screen.queryByText("referenceInheritedHelp")).toBeNull();
  });
});
