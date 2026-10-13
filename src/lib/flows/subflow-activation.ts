import { SUBFLOW_MAX_DEPTH, isSubflowExecutionEnabledForAccount } from "./subflow-execution-capability";

/** What the activation check needs to know about every flow of the account (not just the one being activated). */
export interface AccountFlowInfo {
  status: string;
  /** target_flow_id of each execute_flow node, in node order. */
  targets: string[];
  /** The `scope` of each end node (undefined = default = ends the whole execution). */
  endScopes: Array<string | undefined>;
}

export interface CallGraphIssue { node_key: string; severity: "error" | "warning"; code: "target_not_found" | "target_not_active" | "cycle" | "too_deep" | "callee_never_returns"; message: string }

/**
 * Static checks for a flow that runs other flows, before it can be activated. The database re-checks everything at run time
 * (account, active, cycles, depth, pinned graphs); this only gives the author an early, readable answer.
 *   - every target must exist in the account and be ACTIVE (published) now;
 *   - no flow may end up calling itself, directly or through the flows it calls;
 *   - nesting may not exceed SUBFLOW_MAX_DEPTH calls deep;
 *   - warning: a called flow whose End nodes all end the whole execution never gives control back, so the caller stops there.
 */
export function analyzeCallGraph(flowId: string, thisFlow: AccountFlowInfo & { callNodes: Array<{ node_key: string; target: string }> }, others: Map<string, AccountFlowInfo>): CallGraphIssue[] {
  const issues: CallGraphIssue[] = [];
  const depthOf = (id: string, path: string[]): number => {
    const info = id === flowId ? thisFlow : others.get(id);
    if (!info || (id !== flowId && info.status !== "active")) return 0;
    let deepest = 0;
    for (const target of info.targets) {
      if (path.includes(target)) return Number.POSITIVE_INFINITY;   // cycle
      deepest = Math.max(deepest, 1 + depthOf(target, [...path, target]));
    }
    return deepest;
  };
  for (const call of thisFlow.callNodes) {
    const target = others.get(call.target);
    if (call.target === flowId) { issues.push({ node_key: call.node_key, severity: "error", code: "cycle", message: "A flow cannot run itself." }); continue; }
    if (!target) { issues.push({ node_key: call.node_key, severity: "error", code: "target_not_found", message: "The flow to run does not exist in this account." }); continue; }
    if (target.status !== "active") { issues.push({ node_key: call.node_key, severity: "error", code: "target_not_active", message: "The flow to run must be active (published) first." }); continue; }
    const depth = 1 + depthOf(call.target, [flowId, call.target]);
    if (!Number.isFinite(depth)) issues.push({ node_key: call.node_key, severity: "error", code: "cycle", message: "These flows call each other in a loop." });
    else if (depth > SUBFLOW_MAX_DEPTH) issues.push({ node_key: call.node_key, severity: "error", code: "too_deep", message: `Flows can be nested at most ${SUBFLOW_MAX_DEPTH} calls deep.` });
    if (target.endScopes.length > 0 && !target.endScopes.includes("subflow")) {
      issues.push({ node_key: call.node_key, severity: "warning", code: "callee_never_returns", message: "The flow you call ends the whole execution at every End step, so this flow will not continue after it. Set its End to \"return to the caller\" if it should." });
    }
  }
  return issues;
}

/** Both conditions are mandatory: the server environment flag AND the backend-controlled table (migration 070). Fails closed. */
export async function isSubflowExecutionAllowed(
  db: { from: (table: string) => any }, // eslint-disable-line @typescript-eslint/no-explicit-any
  accountId: string,
): Promise<boolean> {
  if (!isSubflowExecutionEnabledForAccount(accountId)) return false;
  const { data, error } = await db.from("flow_execution_enablement").select("subflow_execution").eq("account_id", accountId).maybeSingle();
  return !error && (data as { subflow_execution?: boolean } | null)?.subflow_execution === true;
}
