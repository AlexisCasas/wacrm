/**
 * Server-only pilot gate for AUTHORING "run another flow" (execute_flow) nodes in draft flows.
 *
 * Empty by default: no account can add, change or keep such a node until an operator lists its account id here.
 * The value is never taken from the browser. It only governs authoring: execution of subflows is not enabled by
 * this flag (the legacy runner cannot run the node, the API refuses to activate such a flow and migration 068
 * refuses it in the database).
 */
export const SUBFLOW_AUTHORING_ACCOUNT_IDS_ENV = "FLOW_SUBFLOW_AUTHORING_ACCOUNT_IDS";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isSubflowAuthoringEnabledForAccount(accountId: string): boolean {
  const configured = process.env[SUBFLOW_AUTHORING_ACCOUNT_IDS_ENV] ?? "";
  return configured
    .split(",")
    .map((id) => id.trim())
    .filter((id) => UUID.test(id))
    .includes(accountId);
}
