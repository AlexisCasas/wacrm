// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { FlowEditorProvider } from "../flow-editor-state";
import { NodeConfigForm } from "./node-config-form";
import { resetSubflowAuthoringCache } from "../use-subflow-authoring";
import { summarizeNode } from "../shared";
import type { FlowNodeRow, FlowRow } from "@/lib/flows/types";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: () => ({ select: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }) }) }) }));

const FLOW = { id: "f1", name: "F", description: null, status: "draft", trigger_type: "manual", trigger_config: {}, entry_node_id: "start", fallback_policy: {}, user_id: "u", account_id: "a", created_at: "", updated_at: "" } as unknown as FlowRow;
const NODES = [
  { node_key: "start", node_type: "start" as const, config: {} },
  { node_key: "info", node_type: "send_message" as const, config: { text: "Hidrolavadora", next_node_key: "c" } },
  { node_key: "end", node_type: "end" as const, config: {} },
];
function mount(config: Record<string, unknown>, capability: boolean, all = NODES, onUpdate = vi.fn()) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ subflowAuthoring: false, durableWaitAuthoring: false, customerReplyCondition: capability })));
  render(
    <FlowEditorProvider initialFlow={FLOW} initialNodes={[] as FlowNodeRow[]}>
      <NodeConfigForm node={{ node_key: "c", node_type: "condition", config }} allNodes={[...all, { node_key: "c", node_type: "condition", config }]} showAdvanced={false} onUpdateConfig={onUpdate} />
    </FlowEditorProvider>,
  );
  return onUpdate;
}
const SAVED = { subject: "customer_activity", subject_key: "info", operator: "replied_after_reference", true_next: "end", false_next: "end" };
beforeEach(() => resetSubflowAuthoringCache());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("customer-activity condition form", () => {
  it("shows the saved reference and the YES / NO branches (reload keeps the authored configuration)", async () => {
    mount(SAVED, true);
    await waitFor(() => expect(screen.getByText("repliedAfterReference")).toBeTruthy());
    expect(screen.getByText("referenceMessageLabel")).toBeTruthy(); expect(screen.getByText("ifRepliedAdvance")).toBeTruthy(); expect(screen.getByText("ifNotRepliedAdvance")).toBeTruthy();
    expect(screen.getByText("referenceHelp")).toBeTruthy();
    expect(screen.queryByText("operatorLabel")).toBeNull(); expect(screen.queryByText("valueLabel")).toBeNull();      // no free operator / text comparison
    expect(screen.queryByText("customerReplyDisabled")).toBeNull();
  });
  it("an account without the flag sees a warning on a saved condition instead of silently converting it", async () => {
    mount(SAVED, false);
    await waitFor(() => expect(screen.getByText("customerReplyDisabled")).toBeTruthy());
  });
  it("without any send step the form explains that one is needed as the reference", async () => {
    mount({ subject: "customer_activity", subject_key: "", operator: "replied_after_reference" }, true, NODES.filter((n) => n.node_type !== "send_message"));
    await waitFor(() => expect(screen.getByText("noReferenceCandidates")).toBeTruthy());
  });
  it("existing subjects keep the original form (operator and value are still there)", async () => {
    mount({ subject: "var", subject_key: "x", operator: "equals", value: "1", true_next: "end", false_next: "end" }, true);
    await waitFor(() => expect(screen.getByText("operatorLabel")).toBeTruthy());
    expect(screen.getByText("valueLabel")).toBeTruthy(); expect(screen.getByText("ifTrueAdvance")).toBeTruthy(); expect(screen.queryByText("repliedAfterReference")).toBeNull();
  });
  it("offers the new subject only to an enabled account", async () => {
    const enabled = mount({ subject: "var", subject_key: "", operator: "present" }, true);
    await waitFor(() => expect(screen.getAllByRole("combobox").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole("combobox")[0]);
    await waitFor(() => expect(screen.queryByText("customerActivity")).toBeTruthy());
    expect(enabled).not.toHaveBeenCalled();
    cleanup(); resetSubflowAuthoringCache();
    mount({ subject: "var", subject_key: "", operator: "present" }, false);
    await waitFor(() => expect(screen.getAllByRole("combobox").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole("combobox")[0]);
    await waitFor(() => expect(screen.queryByText("contactHasTag")).toBeTruthy());
    expect(screen.queryByText("customerActivity")).toBeNull();
  });
});

describe("node summary", () => {
  const t = (key: string, v?: Record<string, string | number>) => `${key}:${v?.node ?? ""}`;
  it("describes the condition by its reference", () => {
    expect(summarizeNode({ node_key: "c", node_type: "condition", config: SAVED }, t)).toBe("repliedAfter:info");
  });
  it("leaves the other condition summaries alone", () => {
    expect(summarizeNode({ node_key: "c", node_type: "condition", config: { subject: "var", subject_key: "x", operator: "present" } })).toBe("var.x exists");
  });
});
