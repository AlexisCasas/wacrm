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
const ALL = [{ node_key: "start", node_type: "start" as const, config: {} }, { node_key: "after", node_type: "end" as const, config: {} }];
function mount(config: Record<string, unknown>, capability: boolean, onUpdate = vi.fn()) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ subflowAuthoring: false, durableWaitAuthoring: capability })));
  render(
    <FlowEditorProvider initialFlow={FLOW} initialNodes={[] as FlowNodeRow[]}>
      <NodeConfigForm node={{ node_key: "pause", node_type: "delay", config }} allNodes={[...ALL, { node_key: "pause", node_type: "delay", config }]} showAdvanced={false} onUpdateConfig={onUpdate} />
    </FlowEditorProvider>,
  );
  return onUpdate;
}
beforeEach(() => resetSubflowAuthoringCache());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("delay node form", () => {
  it("an account without the pilot keeps exactly the original 1-30 second form", async () => {
    mount({ seconds: 7, next_node_key: "after" }, false);
    await waitFor(() => expect(screen.getByText("delaySecondsLabel")).toBeTruthy());
    expect(screen.queryByText("delayKind")).toBeNull(); expect(screen.queryByText("delayAmountLabel")).toBeNull();
    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("7");
  });
  it("an authorised account sees the wait type; a 13-minute wait shows its amount and unit (B: preserved on reload)", async () => {
    mount({ amount: 13, unit: "minutes", next_node_key: "after" }, true);
    await waitFor(() => expect(screen.getByText("delayKind")).toBeTruthy());
    expect((screen.getByLabelText("delayAmountLabel") as HTMLInputElement).value).toBe("13");
    expect(screen.getByText("delayUnit_minutes")).toBeTruthy(); expect(screen.getByText("delayKindDurable")).toBeTruthy();
    expect(screen.getByText("delayDurableHelp")).toBeTruthy();
  });
  it("editing the amount reports the new value bounded to 1..max of the unit", async () => {
    const onUpdate = mount({ amount: 13, unit: "minutes", next_node_key: "after" }, true);
    const input = await screen.findByLabelText("delayAmountLabel");
    fireEvent.change(input, { target: { value: "45" } }); expect(onUpdate).toHaveBeenLastCalledWith({ amount: 45 });
    fireEvent.change(input, { target: { value: "0" } }); expect(onUpdate).toHaveBeenLastCalledWith({ amount: 1 });
    fireEvent.change(input, { target: { value: "99999999" } }); expect(onUpdate).toHaveBeenLastCalledWith({ amount: 43200 });   // 30 days in minutes
    fireEvent.change(input, { target: { value: "abc" } }); expect(onUpdate).toHaveBeenLastCalledWith({ amount: 1 });
  });
  it("a durable wait of an account that lost the flag is shown read-only, not silently converted", async () => {
    mount({ amount: 2, unit: "hours", next_node_key: "after" }, false);
    await waitFor(() => expect(screen.getByText("delayDurableDisabled")).toBeTruthy());
    expect((screen.getByLabelText("delayAmountLabel") as HTMLInputElement).disabled).toBe(true);
  });
});

describe("node summary", () => {
  const t = (key: string, v?: Record<string, string | number>) => `${key}:${v?.amount ?? v?.seconds ?? ""}`;
  it("describes a durable wait with its own amount and unit", () => {
    expect(summarizeNode({ node_key: "p", node_type: "delay", config: { amount: 13, unit: "minutes" } }, t)).toBe("waitDuration_minutes:13");
    expect(summarizeNode({ node_key: "p", node_type: "delay", config: { amount: 3, unit: "days" } }, t)).toBe("waitDuration_days:3");
  });
  it("leaves the legacy delay summary alone", () => { expect(summarizeNode({ node_key: "p", node_type: "delay", config: { seconds: 5 } }, t)).toBe("waitSeconds:5"); });
});
