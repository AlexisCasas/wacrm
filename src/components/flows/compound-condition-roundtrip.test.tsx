// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";

import { FlowEditorProvider, useFlowEditor, type FlowEditorContextValue } from "./flow-editor-state";
import { readConditionConfig, toCompoundPatch } from "@/lib/flows/condition-rules";
import { deriveCanvasEdges, unlinkNodeReferences } from "@/lib/flows/edges";
import { referencedSendKeys } from "@/lib/flows/customer-reply-condition";
import type { FlowNodeRow, FlowRow } from "@/lib/flows/types";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const FLOW = { id: "flow-1", name: "SAFARI copia", description: null, status: "draft", trigger_type: "manual", trigger_config: {}, entry_node_id: "start", fallback_policy: {}, user_id: "u", account_id: "a", created_at: "", updated_at: "" } as unknown as FlowRow;
const LEGACY = { subject: "contact_field", subject_key: "custom:22222222-2222-4222-8222-222222222222", operator: "equals", value: "SAFARI", case_sensitive: false, true_next: "skip", false_next: "present" };
const row = (node_key: string, node_type: string, config: Record<string, unknown>) => ({ id: node_key, flow_id: "flow-1", node_key, node_type, config, position_x: 0, position_y: 0 });
const NODES = [row("start", "start", { next_node_key: "c" }), row("c", "condition", LEGACY), row("skip", "end", {}), row("present", "end", {})] as unknown as FlowNodeRow[];

let ctx: FlowEditorContextValue;
function Probe() { const value = useFlowEditor(); useEffect(() => { ctx = value; }); return null; }
let puts: Array<{ nodes: Array<{ node_key: string; config: Record<string, unknown> }> }>;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function editAndSave(initial: FlowNodeRow[], patchFor: (config: Record<string, unknown>) => Record<string, unknown>) {
  puts = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/capabilities")) return Response.json({});
    puts.push(JSON.parse(String(init?.body)));
    return Response.json({ flow: FLOW, nodes: [] });
  }));
  render(<FlowEditorProvider initialFlow={FLOW} initialNodes={initial}><Probe /></FlowEditorProvider>);
  act(() => ctx.updateNodeConfig("c", patchFor(initial.find((n) => n.node_key === "c")!.config as Record<string, unknown>)));
  await act(async () => { await ctx.save(); });
  return puts[0].nodes.find((n) => n.node_key === "c")!.config;
}

describe("compound condition: save and reopen", () => {
  it("converting a legacy node and saving sends the compound shape with nothing left behind, and it reopens identically", async () => {
    const saved = await editAndSave(NODES, (config) => toCompoundPatch(config, { subject: "tag", subject_key: "t1", operator: "present" } as never, "any"));
    expect(saved).toEqual({
      match_mode: "any",
      conditions: [
        { subject: "contact_field", subject_key: LEGACY.subject_key, operator: "equals", value: "SAFARI", case_sensitive: false },
        { subject: "tag", subject_key: "t1", operator: "present" },
      ],
      true_next: "skip", false_next: "present",
    });
    expect(readConditionConfig(saved).kind).toBe("compound");
    // reopen: load what was saved and save again without edits -> identical
    const reopened = [row("start", "start", { next_node_key: "c" }), row("c", "condition", saved), row("skip", "end", {}), row("present", "end", {})] as unknown as FlowNodeRow[];
    const again = await editAndSave(reopened, () => ({}));
    expect(again).toEqual(saved);
  });

  it("editing one rule and the shared exits persists, and a copy made by cloning the saved JSON behaves the same", async () => {
    const compound = { match_mode: "all", conditions: [{ subject: "var", subject_key: "a", operator: "present" }, { subject: "var", subject_key: "b", operator: "present" }], true_next: "skip", false_next: "present" };
    const nodes = [row("start", "start", { next_node_key: "c" }), row("c", "condition", compound), row("skip", "end", {}), row("present", "end", {})] as unknown as FlowNodeRow[];
    const saved = await editAndSave(nodes, (config) => ({ conditions: (config.conditions as unknown[]).slice(0, 1), true_next: "present" }));
    expect(saved).toMatchObject({ match_mode: "all", conditions: [{ subject_key: "a" }], true_next: "present", false_next: "present" });
    const copy = JSON.parse(JSON.stringify(saved));
    expect(readConditionConfig(copy)).toEqual(readConditionConfig(saved));
  });
});

describe("compound condition: canvas edges and cleanup", () => {
  const compound = { match_mode: "any", conditions: [{ subject: "var", subject_key: "a", operator: "present" }], true_next: "skip", false_next: "present" };
  const nodes = [{ node_key: "c", node_type: "condition", config: compound }, { node_key: "skip", node_type: "end", config: {} }, { node_key: "present", node_type: "end", config: {} }] as never;

  it("a compound node draws exactly its two exits", () => {
    const edges = deriveCanvasEdges(nodes);
    expect(edges.map((e) => `${e.sourceHandle}->${e.target}`).sort()).toEqual(["false->present", "true->skip"]);
  });
  it("deleting a target clears only that exit and leaves the rules alone", () => {
    const cleaned = unlinkNodeReferences(nodes, "skip") as Array<{ node_key: string; config: Record<string, unknown> }>;
    const c = cleaned.find((n) => n.node_key === "c")!.config;
    expect(c.true_next).toBe(""); expect(c.false_next).toBe("present"); expect(c.conditions).toEqual(compound.conditions); expect(c.match_mode).toBe("any");
  });
  it("only a stand-alone customer-activity node feeds the reply tracking; a compound node never does", () => {
    const keys = referencedSendKeys([
      { node_type: "condition", config: { subject: "customer_activity", subject_key: "msg", operator: "replied_after_reference" } },
      { node_type: "condition", config: compound },
    ]);
    expect([...keys]).toEqual(["msg"]);
  });
});
