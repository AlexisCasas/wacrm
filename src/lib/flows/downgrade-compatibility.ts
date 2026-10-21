/** Read-only compatibility report to run before a downgrade to E1. */
export type DowngradeCompatibility = {
  result: "SAFE_TO_ROLLBACK" | "BLOCKED_BY_CUSTOM_CONDITIONS" | "BLOCKED_BY_SUBFLOW_NODES" | "BLOCKED_BY_DURABLE_WAITS" | "BLOCKED_BY_CUSTOMER_REPLY_CONDITIONS";
  custom_condition_flow_ids: string[];
  /** Flows holding a "run another flow" node (pilot). An app version without the node type cannot edit them. */
  execute_flow_flow_ids: string[];
  /** Flows holding a durable wait (delay with a unit). An older runner would sleep at most 30 s instead of waiting. */
  durable_wait_flow_ids: string[];
  /** Runs parked on a durable wait right now: an older build cannot resume them. */
  waiting_run_ids: string[];
  /** Flows holding a customer-activity condition (P7). A build without it fails closed at that node, so they must not be active. */
  customer_reply_condition_flow_ids: string[];
  /** Runs that are INSIDE a called flow right now (P8): an older build cannot resume or return them. */
  nested_run_ids: string[];
  active_custom_condition_flow_ids: string[];
  active_run_flow_ids: string[];
};

export function inspectDowngradeCompatibility(input: {
  flows: Array<{ id: string; status: string }>;
  nodes: Array<{ flow_id: string; node_type: string; config: Record<string, unknown> }>;
  runs: Array<{ flow_id: string; status: string; wait_until?: string | null; id?: string; current_flow_id?: string | null }>;
}): DowngradeCompatibility {
  const customFlowIds = new Set(
    input.nodes
      .filter((node) => node.node_type === "condition" && node.config.subject === "contact_field" && typeof node.config.subject_key === "string" && node.config.subject_key.startsWith("custom:"))
      .map((node) => node.flow_id),
  );
  const activeCustom = input.flows.filter((flow) => flow.status === "active" && customFlowIds.has(flow.id)).map((flow) => flow.id);
  const activeRuns = input.runs.filter((run) => run.status === "active" && customFlowIds.has(run.flow_id)).map((run) => run.flow_id);
  const subflowFlowIds = new Set(input.nodes.filter((node) => node.node_type === "execute_flow").map((node) => node.flow_id));
  const durableFlowIds = new Set(input.nodes.filter((node) => node.node_type === "delay" && typeof node.config.unit === "string").map((node) => node.flow_id));
  const customerReplyFlowIds = new Set(input.nodes.filter((node) => node.node_type === "condition" && node.config.subject === "customer_activity").map((node) => node.flow_id));
  const nestedRunIds = input.runs.filter((run) => run.status === "active" && run.current_flow_id).map((run) => run.id ?? run.flow_id);
  const waitingRunIds = input.runs.filter((run) => run.status === "active" && run.wait_until).map((run) => run.id ?? run.flow_id);
  return {
    result: customFlowIds.size ? "BLOCKED_BY_CUSTOM_CONDITIONS" : subflowFlowIds.size || nestedRunIds.length ? "BLOCKED_BY_SUBFLOW_NODES" : durableFlowIds.size || waitingRunIds.length ? "BLOCKED_BY_DURABLE_WAITS" : customerReplyFlowIds.size ? "BLOCKED_BY_CUSTOMER_REPLY_CONDITIONS" : "SAFE_TO_ROLLBACK",
    durable_wait_flow_ids: [...durableFlowIds].sort(),
    waiting_run_ids: [...new Set(waitingRunIds)].sort(),
    customer_reply_condition_flow_ids: [...customerReplyFlowIds].sort(),
    nested_run_ids: [...new Set(nestedRunIds)].sort(),
    custom_condition_flow_ids: [...customFlowIds].sort(),
    execute_flow_flow_ids: [...subflowFlowIds].sort(),
    active_custom_condition_flow_ids: [...new Set(activeCustom)].sort(),
    active_run_flow_ids: [...new Set(activeRuns)].sort(),
  };
}
