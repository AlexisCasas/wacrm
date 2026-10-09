/** Read-only compatibility report to run before a downgrade to E1. */
export type DowngradeCompatibility = {
  result: "SAFE_TO_ROLLBACK" | "BLOCKED_BY_CUSTOM_CONDITIONS";
  custom_condition_flow_ids: string[];
  active_custom_condition_flow_ids: string[];
  active_run_flow_ids: string[];
};

export function inspectDowngradeCompatibility(input: {
  flows: Array<{ id: string; status: string }>;
  nodes: Array<{ flow_id: string; node_type: string; config: Record<string, unknown> }>;
  runs: Array<{ flow_id: string; status: string }>;
}): DowngradeCompatibility {
  const customFlowIds = new Set(
    input.nodes
      .filter((node) => node.node_type === "condition" && node.config.subject === "contact_field" && typeof node.config.subject_key === "string" && node.config.subject_key.startsWith("custom:"))
      .map((node) => node.flow_id),
  );
  const activeCustom = input.flows.filter((flow) => flow.status === "active" && customFlowIds.has(flow.id)).map((flow) => flow.id);
  const activeRuns = input.runs.filter((run) => run.status === "active" && customFlowIds.has(run.flow_id)).map((run) => run.flow_id);
  return {
    result: customFlowIds.size ? "BLOCKED_BY_CUSTOM_CONDITIONS" : "SAFE_TO_ROLLBACK",
    custom_condition_flow_ids: [...customFlowIds].sort(),
    active_custom_condition_flow_ids: [...new Set(activeCustom)].sort(),
    active_run_flow_ids: [...new Set(activeRuns)].sort(),
  };
}
