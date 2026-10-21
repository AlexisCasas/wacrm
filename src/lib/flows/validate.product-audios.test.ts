import { describe, expect, it } from "vitest";
import { reachableFromEntry, validateFlowForActivation } from "./validate";
import { applyEdgeConnection, deriveCanvasEdges, outgoingSlots, unlinkNodeReferences } from "./edges";
import { defaultConfigFor } from "@/components/flows/flow-editor-state";
import { isProductAudiosConfigValid } from "./product-audios";

const TAG = "11111111-1111-4111-8111-111111111111";
const flow = { name: "Audios por producto", trigger_type: "keyword" as const, trigger_config: { keywords: ["provincia"], match_type: "contains" }, entry_node_id: "start" };
const cfg = (over: Record<string, unknown> = {}) => ({ gate_tag_id: TAG, product_field_id: "", next_node_key: "ok", unknown_node_key: "unk", no_audios_node_key: "noa", gate_closed_node_key: "gate", ...over });
const nodes = (c: Record<string, unknown>) => [
  { node_key: "start", node_type: "start", config: { next_node_key: "vp" } },
  { node_key: "vp", node_type: "send_product_audios", config: c },
  ...["ok", "unk", "noa", "gate"].map((k) => ({ node_key: k, node_type: "end", config: {} })),
];
const issues = (c: Record<string, unknown>, options = {}) => validateFlowForActivation(flow, nodes(c), options).filter((i) => i.node_key === "vp");

describe("validator: send_product_audios", () => {
  it("accepts a complete node and reaches every route target", () => {
    expect(issues(cfg())).toEqual([]);
    expect(validateFlowForActivation(flow, nodes(cfg()))).toEqual([]);
    expect([...reachableFromEntry("start", nodes(cfg()))].sort()).toEqual(["gate", "noa", "ok", "start", "unk", "vp"]);
  });
  it("the gate has no default: a missing or malformed gate blocks activation", () => {
    for (const bad of ["", undefined, "x", 5]) expect(issues(cfg({ gate_tag_id: bad })).map((i) => (i as { code?: string }).code)).toContain("product_audios_gate_missing");
  });
  it("every route is required and must exist", () => {
    for (const key of ["next_node_key", "unknown_node_key", "no_audios_node_key", "gate_closed_node_key"]) {
      expect(issues(cfg({ [key]: "" })).some((i) => i.field === key && (i as { code?: string }).code === "product_audios_route_missing")).toBe(true);
      expect(issues(cfg({ [key]: "nope" })).some((i) => i.field === key && (i as { code?: string }).code === "product_audios_route_unknown")).toBe(true);
    }
  });
  it("the explicit Producto field must be empty or a uuid", () => {
    expect(issues(cfg({ product_field_id: "" }))).toEqual([]);
    expect(issues(cfg({ product_field_id: "33333333-3333-4333-8333-333333333333" }))).toEqual([]);
    expect(issues(cfg({ product_field_id: "nope" })).some((i) => (i as { code?: string }).code === "product_audios_field_invalid")).toBe(true);
  });
  it("is an error when the server says voice notes are not enabled for the account", () => {
    expect(issues(cfg(), { voiceNoteEnabled: false }).some((i) => (i as { code?: string }).code === "product_audios_not_enabled")).toBe(true);
    expect(issues(cfg(), { voiceNoteEnabled: true })).toEqual([]);
  });
  it("other node types are unaffected by the flag", () => {
    const plain = [{ node_key: "start", node_type: "start", config: { next_node_key: "e" } }, { node_key: "e", node_type: "end", config: {} }];
    expect(validateFlowForActivation(flow, plain, { voiceNoteEnabled: false })).toEqual([]);
  });
});

describe("canvas edges for send_product_audios", () => {
  const node = { node_key: "vp", node_type: "send_product_audios" as const, config: cfg() };
  const all = [node, ...["ok", "unk", "noa", "gate"].map((k) => ({ node_key: k, node_type: "end" as const, config: {} }))];
  it("has four labelled outputs, each an edge to its target", () => {
    expect(outgoingSlots(node).map((s) => s.id)).toEqual(["next", "unknown", "no_audios", "gate_closed"]);
    expect(deriveCanvasEdges(all).map((e) => [e.sourceHandle, e.target])).toEqual([["next", "ok"], ["unknown", "unk"], ["no_audios", "noa"], ["gate_closed", "gate"]]);
  });
  it("connecting a handle patches the matching route only; an unknown handle is refused", () => {
    expect(applyEdgeConnection(node, "unknown", "x")).toEqual({ unknown_node_key: "x" });
    expect(applyEdgeConnection(node, "gate_closed", "y")).toEqual({ gate_closed_node_key: "y" });
    expect(applyEdgeConnection(node, "true", "z")).toBeNull();
  });
  it("deleting a target clears only the routes that pointed at it", () => {
    const [patched] = unlinkNodeReferences(all, "unk");
    expect(patched.config).toMatchObject({ unknown_node_key: "", next_node_key: "ok", gate_tag_id: TAG });
    expect(unlinkNodeReferences(all, "nothing")[0]).toBe(all[0]);
  });
});

describe("the editor's default and the runtime config check", () => {
  it("a new node starts unconfigured: no gate, no routes", () => {
    const d = defaultConfigFor("send_product_audios");
    expect(d).toMatchObject({ gate_tag_id: "", next_node_key: "", unknown_node_key: "", no_audios_node_key: "", gate_closed_node_key: "" });
    expect(isProductAudiosConfigValid(d as never)).toBe(false);
  });
  it("isProductAudiosConfigValid requires the gate and all four routes", () => {
    expect(isProductAudiosConfigValid(cfg() as never)).toBe(true);
    expect(isProductAudiosConfigValid(cfg({ gate_tag_id: "" }) as never)).toBe(false);
    expect(isProductAudiosConfigValid(cfg({ no_audios_node_key: " " }) as never)).toBe(false);
    expect(isProductAudiosConfigValid(null)).toBe(false);
    expect(isProductAudiosConfigValid(cfg({ product_field_id: "bad" }) as never)).toBe(false);
  });
});
