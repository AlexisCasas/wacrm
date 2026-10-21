/**
 * Server-only gate for AUTHORING "run another flow" (execute_flow) nodes in draft flows.
 *
 * Governed by FLOW_AUTHORING_SCOPE (default "allowlist": only the ids listed here). The value is never taken from the browser. It only governs authoring: execution of subflows is not enabled by
 * this flag (the legacy runner cannot run the node, the API refuses to activate such a flow and migration 068
 * refuses it in the database).
 */
export const SUBFLOW_AUTHORING_ACCOUNT_IDS_ENV = "FLOW_SUBFLOW_AUTHORING_ACCOUNT_IDS";

import { authoringAllowed } from "./flow-scope";

/** "allowlist" mode reads FLOW_SUBFLOW_AUTHORING_ACCOUNT_IDS; "all" opens it for every account; "off" closes it (see flow-scope.ts). */
export function isSubflowAuthoringEnabledForAccount(accountId: string): boolean {
  return authoringAllowed(SUBFLOW_AUTHORING_ACCOUNT_IDS_ENV, accountId);
}
