// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

// The list view's "Add step" menu and the canvas's floating "Add step" menu must offer exactly the same steps for the same account.
// Only the account capabilities (hooks) and ReactFlow's viewport are controlled here; the menus, the shared list and the editor state
// (the real FlowEditorProvider) are the real ones.

const cap = vi.hoisted(() => ({ subflow: false, productAudios: false as boolean | null }));

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/hooks/use-audio-guide-enabled", () => ({ useAudioGuideEnabled: () => cap.productAudios }));
vi.mock("./use-subflow-authoring", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSubflowAuthoringCapability: () => cap.subflow,
}));
vi.mock("@xyflow/react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useReactFlow: () => ({ screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }) }),
}));

import { AddNodeButton } from "./flow-builder";
import { CanvasAddNodeButton } from "./flow-canvas";
import { FlowEditorProvider, useFlowEditor } from "./flow-editor-state";
import { addableNodeTypes } from "./shared";
import type { FlowRow } from "@/lib/flows/types";

const t = ((key: string) => key) as never;
const LABEL = (type: string) => `nodes.${type}.label`;

const flow = { id: "flow-1", account_id: "acct-1", user_id: "u-1", name: "Prueba", description: null, status: "draft", trigger_type: "keyword", trigger_config: { keywords: ["x"] }, entry_node_id: null, fallback_policy: {}, created_at: "", updated_at: "" } as unknown as FlowRow;

function Shell({ children }: { children: ReactNode }) {
  return <FlowEditorProvider initialFlow={flow} initialNodes={[]}>{children}</FlowEditorProvider>;
}

/** Open a menu by its trigger and return the labels it offers, in order. */
async function offered(button: HTMLElement): Promise<string[]> {
  fireEvent.click(button);
  const items = await screen.findAllByRole("menuitem");
  // The canvas menu also shows a one-line description under each label: compare by the step's label key only.
  const labels = items.map((i) => (i.textContent ?? "").match(/nodes\.[a-z_]+\.label/)?.[0] ?? (i.textContent ?? ""));
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  return labels;
}

beforeEach(() => {
  cap.subflow = false;
  cap.productAudios = false;
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("addableNodeTypes: the single list behind both menus", () => {
  it("offers Audios por producto only when the account has the module", () => {
    expect(addableNodeTypes({ subflowAuthoring: false, productAudios: false })).not.toContain("send_product_audios");
    expect(addableNodeTypes({ subflowAuthoring: false, productAudios: true })).toContain("send_product_audios");
  });

  it("offers Run another flow only with subflow authoring, independently of the module", () => {
    expect(addableNodeTypes({ subflowAuthoring: true, productAudios: false })).toContain("execute_flow");
    expect(addableNodeTypes({ subflowAuthoring: true, productAudios: false })).not.toContain("send_product_audios");
    expect(addableNodeTypes({ subflowAuthoring: false, productAudios: false })).not.toContain("execute_flow");
  });

  it("keeps the historical order and always ends with Hand off and End; both optional steps sit just before Hand off", () => {
    const base = addableNodeTypes({ subflowAuthoring: false, productAudios: false });
    expect(base).toEqual(["start", "send_buttons", "send_list", "send_message", "send_media", "collect_input", "condition", "set_tag", "delay", "set_contact_field", "handoff", "end"]);
    const all = addableNodeTypes({ subflowAuthoring: true, productAudios: true });
    expect(all.slice(-4)).toEqual(["execute_flow", "send_product_audios", "handoff", "end"]);
    expect(all.filter((x) => !["execute_flow", "send_product_audios"].includes(x))).toEqual(base);
  });
});

describe("the list menu and the canvas menu offer the same steps", () => {
  const cases: Array<[string, boolean | null, boolean]> = [
    ["account WITH the module", true, false],
    ["account WITHOUT the module (e.g. the commercial account)", false, false],
    ["capability still unknown (null)", null, false],
    ["module AND subflow authoring", true, true],
    ["subflow authoring only", false, true],
  ];

  it.each(cases)("%s", async (_name, productAudios, subflow) => {
    cap.productAudios = productAudios;
    cap.subflow = subflow;
    render(<Shell><AddNodeButton onAdd={vi.fn()} t={t} /></Shell>);
    const list = await offered(screen.getByRole("button", { name: "addNode" }));
    cleanup();
    render(<Shell><CanvasAddNodeButton t={t} /></Shell>);
    const canvas = await offered(screen.getByRole("button", { name: "addNode" }));

    expect(canvas).toEqual(list);
    const hasModule = productAudios === true;
    expect(list.includes(LABEL("send_product_audios"))).toBe(hasModule);
    expect(canvas.includes(LABEL("send_product_audios"))).toBe(hasModule);
    expect(canvas.includes(LABEL("execute_flow"))).toBe(subflow);
  });
});

describe("the step can be created, configured, saved and recovered from either view", () => {
  function Probe({ onReady }: { onReady: (api: ReturnType<typeof useFlowEditor>) => void }) {
    onReady(useFlowEditor());
    return null;
  }
  const gate = "11111111-2222-4333-8444-555555555555";

  it("both menus create the same default step; its configuration is saved as typed and comes back unchanged", async () => {
    cap.productAudios = true;
    let api!: ReturnType<typeof useFlowEditor>;
    render(
      <Shell>
        <Probe onReady={(a) => (api = a)} />
        <AddNodeButton onAdd={(type) => api.addNode(type)} t={t} />
        <CanvasAddNodeButton t={t} />
      </Shell>,
    );

    // From the LIST view's menu...
    const [listTrigger, canvasTrigger] = screen.getAllByRole("button", { name: "addNode" });
    fireEvent.click(listTrigger);
    fireEvent.click(within(await screen.findByRole("menu")).getByText(LABEL("send_product_audios")));
    // ...and from the CANVAS menu.
    fireEvent.click(canvasTrigger);
    fireEvent.click(within(await screen.findByRole("menu")).getByText(LABEL("send_product_audios")));

    await waitFor(() => expect(api.state.nodes.filter((n) => n.node_type === "send_product_audios")).toHaveLength(2));
    const [first, second] = api.state.nodes.filter((n) => n.node_type === "send_product_audios");
    expect(first.config).toEqual(second.config); // same defaults whichever menu created it
    expect(first.config).toMatchObject({ gate_tag_id: "", product_field_id: "", next_node_key: "", unknown_node_key: "", no_audios_node_key: "", gate_closed_node_key: "" });
    expect(first.node_key).not.toBe(second.node_key);

    // Configure the first one (what the form writes) and save through the real save path.
    const configured = { gate_tag_id: gate, product_field_id: "", next_node_key: "end", unknown_node_key: "end", no_audios_node_key: "end", gate_closed_node_key: "end" };
    api.updateNodeConfig(first.node_key, configured);
    await waitFor(() => expect(api.state.nodes.find((n) => n.node_key === first.node_key)?.config).toMatchObject(configured));
    const puts: Array<{ url: string; body: { nodes: Array<{ node_key: string; node_type: string; config: Record<string, unknown> }> } }> = [];
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") puts.push({ url, body: JSON.parse(String(init.body)) });
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    expect(await api.save()).toBe(true);
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toBe("/api/flows/flow-1");
    const saved = puts[0].body.nodes.filter((n) => n.node_type === "send_product_audios");
    expect(saved).toHaveLength(2);
    expect(saved.find((n) => n.node_key === first.node_key)?.config).toEqual(configured);

    // Recover: a new editor opened from what was saved shows the same steps with the same configuration.
    cleanup();
    let reopened!: ReturnType<typeof useFlowEditor>;
    render(
      <FlowEditorProvider
        initialFlow={flow}
        initialNodes={puts[0].body.nodes.map((n, i) => ({ id: `n${i}`, flow_id: "flow-1", account_id: "acct-1", node_key: n.node_key, node_type: n.node_type, config: n.config, position_x: 0, position_y: 0, created_at: "" }) as never)}
      >
        <Probe onReady={(a) => (reopened = a)} />
      </FlowEditorProvider>,
    );
    await waitFor(() => expect(reopened.state.nodes.filter((n) => n.node_type === "send_product_audios")).toHaveLength(2));
    expect(reopened.state.nodes.find((n) => n.node_key === first.node_key)?.config).toEqual(configured);
  });
});
