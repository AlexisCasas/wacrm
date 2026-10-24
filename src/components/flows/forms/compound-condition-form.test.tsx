// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { FlowEditorProvider } from "../flow-editor-state";
import { NodeConfigForm } from "./node-config-form";
import { resetSubflowAuthoringCache } from "../use-subflow-authoring";
import { readConditionConfig } from "@/lib/flows/condition-rules";
import type { FlowNodeRow, FlowRow } from "@/lib/flows/types";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: () => ({ order: () => (table === "custom_fields" ? Promise.resolve({ data: [{ id: "22222222-2222-4222-8222-222222222222", field_name: "Producto" }], error: null }) : Promise.resolve({ data: [], error: null })) }),
    }),
  }),
}));

const FLOW = { id: "f1", name: "F", description: null, status: "draft", trigger_type: "manual", trigger_config: {}, entry_node_id: "start", fallback_policy: {}, user_id: "u", account_id: "a", created_at: "", updated_at: "" } as unknown as FlowRow;
const NODES = [
  { node_key: "start", node_type: "start" as const, config: {} },
  { node_key: "info", node_type: "send_message" as const, config: { text: "hola", next_node_key: "c" } },
  { node_key: "end", node_type: "end" as const, config: {} },
];
const FIELD = "custom:22222222-2222-4222-8222-222222222222";

function mount(config: Record<string, unknown>, caps: { compound?: boolean; custom?: boolean } = { compound: true, custom: true }) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ customConditions: caps.custom === true, compoundConditions: caps.compound === true, customerReplyCondition: true })));
  const onUpdate = vi.fn();
  const view = render(
    <FlowEditorProvider initialFlow={FLOW} initialNodes={[] as FlowNodeRow[]}>
      <NodeConfigForm node={{ node_key: "c", node_type: "condition", config }} allNodes={[...NODES, { node_key: "c", node_type: "condition", config }]} showAdvanced={false} onUpdateConfig={onUpdate} />
    </FlowEditorProvider>,
  );
  return { onUpdate, view };
}
const LEGACY = { subject: "contact_field", subject_key: FIELD, operator: "equals", value: "SAFARI", case_sensitive: false, true_next: "end", false_next: "end" };
const COMPOUND = { match_mode: "any", conditions: [{ subject: "contact_field", subject_key: FIELD, operator: "equals", value: "SAFARI", case_sensitive: false }, { subject: "tag", subject_key: "t1", operator: "present" }], true_next: "end", false_next: "end" };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); resetSubflowAuthoringCache(); });

describe("condition form — several conditions", () => {
  it("a legacy node keeps its single-rule form; 'Add condition' converts it WITHOUT losing the rule", async () => {
    const { onUpdate } = mount(LEGACY);
    await waitFor(() => expect(screen.getByTestId("condition-add-rule")).toBeTruthy());
    expect(screen.queryByTestId("condition-match-mode")).toBeNull();
    expect(screen.getByDisplayValue("SAFARI")).toBeTruthy();                       // the saved value is still shown
    fireEvent.click(screen.getByTestId("condition-add-rule"));
    const patch = onUpdate.mock.calls[0][0] as Record<string, unknown>;
    const stored = JSON.parse(JSON.stringify({ ...LEGACY, ...patch }));            // what the editor state would persist
    expect(stored.conditions[0]).toEqual({ subject: "contact_field", subject_key: FIELD, operator: "equals", value: "SAFARI", case_sensitive: false });
    expect(stored.conditions).toHaveLength(2);
    expect(stored.match_mode).toBe("all");
    expect(["subject", "subject_key", "operator", "value", "case_sensitive"].some((k) => k in stored)).toBe(false);
    expect(stored).toMatchObject({ true_next: "end", false_next: "end" });
    expect(readConditionConfig(stored).kind).toBe("compound");
  });

  it("editing a legacy node in place stays legacy (no silent conversion)", async () => {
    const { onUpdate } = mount(LEGACY);
    await waitFor(() => expect(screen.getByDisplayValue("SAFARI")).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue("SAFARI"), { target: { value: "OTRO" } });
    expect(onUpdate).toHaveBeenCalledWith({ value: "OTRO" });
  });

  it("the add button is not offered without the compound capability", async () => {
    mount(LEGACY, { compound: false, custom: true });
    await waitFor(() => expect(screen.getByDisplayValue("SAFARI")).toBeTruthy());
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId("condition-add-rule")).toBeNull();
  });

  it("customer activity stays a stand-alone condition: no add button, no list", async () => {
    mount({ subject: "customer_activity", subject_key: "info", operator: "replied_after_reference", true_next: "end", false_next: "end" });
    await waitFor(() => expect(screen.getByText("repliedAfterReference")).toBeTruthy());
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId("condition-add-rule")).toBeNull();
    expect(screen.getByText("ifRepliedAdvance")).toBeTruthy();
  });

  it("reopening a saved compound node shows the mode, every rule and the two shared exits", async () => {
    mount(COMPOUND);
    await waitFor(() => expect(screen.getByTestId("condition-match-mode")).toBeTruthy());
    expect(screen.getByTestId("condition-rule-0")).toBeTruthy(); expect(screen.getByTestId("condition-rule-1")).toBeTruthy();
    expect(screen.queryByTestId("condition-rule-2")).toBeNull();
    expect(screen.getAllByText("ifTrueAdvance")).toHaveLength(1); expect(screen.getAllByText("ifFalseAdvance")).toHaveLength(1);
    expect(within(screen.getByTestId("condition-rule-0")).getByDisplayValue("SAFARI")).toBeTruthy();
    expect(screen.queryByText(/customerActivity/)).toBeNull();                        // not offered inside a list
  });

  it("adds a blank rule at the end and removes a single rule without touching the others", async () => {
    const { onUpdate } = mount(COMPOUND);
    await waitFor(() => expect(screen.getByTestId("condition-add-rule")).toBeTruthy());
    fireEvent.click(screen.getByTestId("condition-add-rule"));
    const added = (onUpdate.mock.calls[0][0] as { conditions: Array<Record<string, unknown>> }).conditions;
    expect(added).toHaveLength(3); expect(added[0]).toEqual(COMPOUND.conditions[0]); expect(added[1]).toEqual(COMPOUND.conditions[1]);
    expect(added[2]).toMatchObject({ subject: "var", subject_key: "", operator: "equals", case_sensitive: false });
    onUpdate.mockClear();
    fireEvent.click(screen.getByTestId("condition-remove-0"));
    expect(onUpdate).toHaveBeenCalledWith({ conditions: [COMPOUND.conditions[1]] });
  });

  it("editing one rule changes only that rule", async () => {
    const { onUpdate } = mount(COMPOUND);
    await waitFor(() => expect(screen.getByTestId("condition-rule-0")).toBeTruthy());
    fireEvent.change(within(screen.getByTestId("condition-rule-0")).getByDisplayValue("SAFARI"), { target: { value: "OTRO" } });
    const next = (onUpdate.mock.calls[0][0] as { conditions: Array<Record<string, unknown>> }).conditions;
    expect(next[0]).toMatchObject({ value: "OTRO", operator: "equals", case_sensitive: false });
    expect(next[1]).toEqual(COMPOUND.conditions[1]);
  });

  it("the last rule cannot be removed and the 10-rule limit disables 'Add condition'", async () => {
    mount({ ...COMPOUND, conditions: [COMPOUND.conditions[0]] });
    await waitFor(() => expect(screen.getByTestId("condition-remove-0")).toBeTruthy());
    expect((screen.getByTestId("condition-remove-0") as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    mount({ ...COMPOUND, conditions: Array.from({ length: 10 }, () => COMPOUND.conditions[1]) });
    await waitFor(() => expect(screen.getByTestId("condition-add-rule")).toBeTruthy());
    expect((screen.getByTestId("condition-add-rule") as HTMLButtonElement).disabled).toBe(true);
  });

  it("an invalid saved shape is reported, not silently rewritten", async () => {
    const { onUpdate } = mount({ subject: "var", subject_key: "x", operator: "present", match_mode: "all", conditions: [], true_next: "end", false_next: "end" });
    await waitFor(() => expect(screen.getByTestId("condition-config-invalid")).toBeTruthy());
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("the closed pickers show readable names, not raw values (field name, operator, kind, mode)", async () => {
    mount(COMPOUND);
    await waitFor(() => expect(screen.getByTestId("condition-rule-0")).toBeTruthy());
    await waitFor(() => expect(within(screen.getByTestId("condition-rule-0")).getByText("Producto")).toBeTruthy());
    const triggers = Array.from(screen.getByTestId("condition-rule-0").querySelectorAll("[role=combobox]")).map((e) => (e.textContent ?? "").replace("▼", ""));
    expect(triggers).toEqual(["contactField", "Producto", "equals"]);
    expect((screen.getByTestId("condition-match-mode").textContent ?? "")).toContain("matchAny");
  });
});
