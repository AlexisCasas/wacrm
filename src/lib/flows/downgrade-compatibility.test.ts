import { describe, expect, it } from "vitest";
import { inspectDowngradeCompatibility } from "./downgrade-compatibility";

describe("inspectDowngradeCompatibility", () => {
  it("is safe when no custom-field condition exists", () => {
    expect(inspectDowngradeCompatibility({ flows: [{ id: "f1", status: "active" }], nodes: [], runs: [] }).result).toBe("SAFE_TO_ROLLBACK");
  });

  it("blocks a downgrade for a persisted custom condition and reports only ids", () => {
    expect(inspectDowngradeCompatibility({
      flows: [{ id: "f1", status: "active" }],
      nodes: [{ flow_id: "f1", node_type: "condition", config: { subject: "contact_field", subject_key: "custom:11111111-1111-4111-8111-111111111111" } }],
      runs: [{ flow_id: "f1", status: "active" }],
    })).toEqual({ result: "BLOCKED_BY_CUSTOM_CONDITIONS", custom_condition_flow_ids: ["f1"], execute_flow_flow_ids: [], durable_wait_flow_ids: [], waiting_run_ids: [], active_custom_condition_flow_ids: ["f1"], active_run_flow_ids: ["f1"] });
  });

  it("blocks drafts too and de-duplicates active run flow ids", () => {
    expect(inspectDowngradeCompatibility({
      flows: [{ id: "draft", status: "draft" }, { id: "native", status: "active" }],
      nodes: [{ flow_id: "draft", node_type: "condition", config: { subject: "contact_field", subject_key: "custom:x" } }],
      runs: [{ flow_id: "draft", status: "active" }, { flow_id: "draft", status: "active" }],
    })).toEqual({ result: "BLOCKED_BY_CUSTOM_CONDITIONS", custom_condition_flow_ids: ["draft"], execute_flow_flow_ids: [], durable_wait_flow_ids: [], waiting_run_ids: [], active_custom_condition_flow_ids: [], active_run_flow_ids: ["draft"] });
  });

  it("blocks a downgrade while any flow holds a 'run another flow' node (pilot), even as a draft", () => {
    const report = inspectDowngradeCompatibility({
      flows: [{ id: "a", status: "draft" }, { id: "b", status: "draft" }],
      nodes: [{ flow_id: "a", node_type: "execute_flow", config: { target_flow_id: "b", next_node_key: "end" } }, { flow_id: "a", node_type: "execute_flow", config: {} }],
      runs: [],
    });
    expect(report).toEqual({ result: "BLOCKED_BY_SUBFLOW_NODES", custom_condition_flow_ids: [], execute_flow_flow_ids: ["a"], durable_wait_flow_ids: [], waiting_run_ids: [], active_custom_condition_flow_ids: [], active_run_flow_ids: [] });
  });

  it("blocks a downgrade while a flow holds a durable wait or a run is parked on one", () => {
    const report = inspectDowngradeCompatibility({
      flows: [{ id: "w", status: "draft" }],
      nodes: [{ flow_id: "w", node_type: "delay", config: { amount: 13, unit: "minutes", next_node_key: "x" } }, { flow_id: "legacy", node_type: "delay", config: { seconds: 5, next_node_key: "x" } }],
      runs: [{ id: "run-1", flow_id: "w", status: "active", wait_until: "2026-10-14T10:00:00Z" }, { id: "run-2", flow_id: "w", status: "active", wait_until: null }],
    });
    expect(report.result).toBe("BLOCKED_BY_DURABLE_WAITS");
    expect(report.durable_wait_flow_ids).toEqual(["w"]);       // the legacy 30-second delay is not reported
    expect(report.waiting_run_ids).toEqual(["run-1"]);
  });
});
