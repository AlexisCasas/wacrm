import { describe, expect, it } from "vitest";
import { validateFlowForActivation } from "./validate";

// Pilot: execute_flow can be authored but the legacy runner cannot execute it, so activation must refuse it.
const flow = { name: "A", trigger_type: "manual" as const, trigger_config: {}, entry_node_id: "start" };
const nodes = [
  { node_key: "start", node_type: "start", config: { next_node_key: "call" } },
  { node_key: "call", node_type: "execute_flow", config: { target_flow_id: "33333333-3333-4333-8333-333333333333", next_node_key: "end" } },
  { node_key: "end", node_type: "end", config: {} },
];

describe("validateFlowForActivation and execute_flow", () => {
  it("refuses a flow with an execute_flow node by default (no versioned execution)", () => {
    const issues = validateFlowForActivation(flow, nodes);
    expect(issues.filter((i) => i.severity === "error").map((i) => i.node_key)).toContain("call");
  });
  it("follows next_node_key for reachability, so the continuation node is not reported as unreachable", () => {
    const issues = validateFlowForActivation(flow, nodes, { versionedExecution: true });
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(issues.some((i) => i.node_key === "end" && /unreachable/i.test(i.message))).toBe(false);
  });
});
