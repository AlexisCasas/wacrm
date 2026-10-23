import { describe, expect, it } from "vitest";
import { reachableFromEntry, validateFlowForActivation } from "./validate";
import { applyEdgeConnection, deriveCanvasEdges, outgoingSlots } from "./edges";
import { defaultConfigFor } from "@/components/flows/flow-editor-state";
import { summarizeNode } from "@/components/flows/shared";

const TAG = "11111111-1111-4111-8111-111111111111";
const PRODUCT = "44444444-4444-4444-8444-444444444444";
const flow = { name: "Audios", trigger_type: "keyword" as const, trigger_config: { keywords: ["provincia"], match_type: "contains" }, entry_node_id: "start" };
const graph = (c: Record<string, unknown>) => [
  { node_key: "start", node_type: "start", config: { next_node_key: "vp" } },
  { node_key: "vp", node_type: "send_product_audios", config: c },
  ...["ok", "unk", "noa", "gate"].map((k) => ({ node_key: k, node_type: "end", config: {} })),
];
const issues = (c: Record<string, unknown>) => validateFlowForActivation(flow, graph(c), { voiceNoteEnabled: true }).filter((i) => i.node_key === "vp");
const codes = (c: Record<string, unknown>) => issues(c).map((i) => (i as { code?: string }).code);

const routes = { next_node_key: "ok", unknown_node_key: "unk", no_audios_node_key: "noa" };
const legacy = { gate_tag_id: TAG, product_field_id: "", ...routes, gate_closed_node_key: "gate" };
const noTag = { gate_mode: "none", gate_tag_id: "", product_source: "auto", product_field_id: "", product_id: "", ...routes, gate_closed_node_key: "" };
const manual = { ...noTag, product_source: "manual", product_id: PRODUCT };

describe("activation validation", () => {
  it("a node saved before the options existed is still valid and still requires its tag and its 'gate closed' output", () => {
    expect(issues(legacy)).toEqual([]);
    expect(codes({ ...legacy, gate_tag_id: "" })).toContain("product_audios_gate_missing");
    expect(codes({ ...legacy, gate_closed_node_key: "" })).toContain("product_audios_route_missing");
    expect(issues({ ...legacy, gate_closed_node_key: "nope" }).some((i) => (i as { code?: string }).code === "product_audios_route_unknown")).toBe(true);
  });

  it("a node without a tag is valid and does NOT need a 'gate closed' output", () => {
    expect(issues(noTag)).toEqual([]);
    expect(issues({ ...noTag, gate_closed_node_key: undefined })).toEqual([]);
  });

  it("a node with a required tag (explicit) behaves like the legacy one", () => {
    const explicit = { ...legacy, gate_mode: "required", product_source: "auto" };
    expect(issues(explicit)).toEqual([]);
    expect(codes({ ...explicit, gate_tag_id: "" })).toContain("product_audios_gate_missing");
    expect(codes({ ...explicit, gate_closed_node_key: "" })).toContain("product_audios_route_missing");
  });

  it("the other three outputs are always required", () => {
    for (const key of ["next_node_key", "unknown_node_key", "no_audios_node_key"]) {
      expect(codes({ ...noTag, [key]: "" })).toContain("product_audios_route_missing");
      expect(codes({ ...noTag, [key]: "nope" })).toContain("product_audios_route_unknown");
    }
  });

  it("a catalog product chosen by hand is accepted; without it, or mixed with a field, it is refused", () => {
    expect(issues(manual)).toEqual([]);
    expect(codes({ ...manual, product_id: "" })).toContain("product_audios_product_missing");
    expect(codes({ ...manual, product_field_id: "33333333-3333-4333-8333-333333333333" })).toContain("product_audios_source_conflict");
  });

  it("contradictions and unknown values block activation", () => {
    expect(codes({ ...noTag, gate_tag_id: TAG })).toContain("product_audios_gate_conflict");
    expect(codes({ ...noTag, gate_mode: "maybe" })).toContain("product_audios_gate_mode_invalid");
    expect(codes({ ...noTag, product_source: "ai" })).toContain("product_audios_source_invalid");
  });

  it("is still an error when the account does not have the module", () => {
    expect(validateFlowForActivation(flow, graph(noTag), { voiceNoteEnabled: false }).some((i) => (i as { code?: string }).code === "product_audios_not_enabled")).toBe(true);
  });
});

describe("the graph follows the outputs the node really has", () => {
  it("without a tag the 'gate closed' target is not a successor (and is not reachable through it)", () => {
    const withLeftover = { ...noTag, gate_closed_node_key: "gate" };
    expect([...reachableFromEntry("start", graph(withLeftover))].sort()).toEqual(["noa", "ok", "start", "unk", "vp"]);
    expect([...reachableFromEntry("start", graph(legacy))].sort()).toEqual(["gate", "noa", "ok", "start", "unk", "vp"]);
  });

  it("canvas: three outputs without a tag, four when a tag is required (and for a node saved before the option)", () => {
    const node = (config: Record<string, unknown>) => ({ node_key: "vp", node_type: "send_product_audios", config, position_x: 0, position_y: 0 }) as never;
    expect(outgoingSlots(node(noTag)).map((s) => s.id)).toEqual(["next", "unknown", "no_audios"]);
    expect(outgoingSlots(node(legacy)).map((s) => s.id)).toEqual(["next", "unknown", "no_audios", "gate_closed"]);
    expect(outgoingSlots(node({ ...noTag, gate_mode: "required" })).map((s) => s.id)).toContain("gate_closed");
    const edges = deriveCanvasEdges(graph({ ...noTag, gate_closed_node_key: "gate" }) as never);
    expect(edges.filter((e) => e.source === "vp").map((e) => e.sourceHandle).sort()).toEqual(["next", "no_audios", "unknown"]);
    expect(deriveCanvasEdges(graph(legacy) as never).filter((e) => e.source === "vp")).toHaveLength(4);
  });

  it("connecting an output from the canvas still works for the outputs that exist", () => {
    const node = { node_key: "vp", node_type: "send_product_audios", config: noTag, position_x: 0, position_y: 0 } as never;
    expect(applyEdgeConnection(node, "unknown", "x")).toEqual({ unknown_node_key: "x" });
    expect(applyEdgeConnection(node, "next", "y")).toEqual({ next_node_key: "y" });
  });
});

describe("new nodes start without a tag, reading the product from the contact", () => {
  it("default configuration, and it is not activatable until the outputs are set", () => {
    const fresh = defaultConfigFor("send_product_audios");
    expect(fresh).toMatchObject({ gate_mode: "none", gate_tag_id: "", product_source: "auto", product_field_id: "", product_id: "" });
    expect(codes(fresh)).toEqual(["product_audios_route_missing", "product_audios_route_missing", "product_audios_route_missing"]);
  });
  it("the card summary says what it does, and flags what is missing", () => {
    const sum = (config: Record<string, unknown>) => summarizeNode({ node_key: "vp", node_type: "send_product_audios", config, position_x: 0, position_y: 0 } as never);
    expect(sum(noTag)).toMatch(/contact/i);
    expect(sum(manual)).toMatch(/chosen/i);
    expect(sum(legacy)).toMatch(/tag required/i);
    expect(sum({ ...legacy, gate_tag_id: "" })).toMatch(/choose the required tag/i);
    expect(sum({ ...manual, product_id: "" })).toMatch(/choose the product/i);
  });
});
