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
    })).toEqual({ result: "BLOCKED_BY_CUSTOM_CONDITIONS", custom_condition_flow_ids: ["f1"], active_custom_condition_flow_ids: ["f1"], active_run_flow_ids: ["f1"] });
  });
});
