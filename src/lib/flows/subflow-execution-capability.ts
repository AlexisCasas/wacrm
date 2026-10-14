/**
 * Server-only gate for EXECUTING "Run another flow" (migration 070). Empty by default: nobody has it until an operator lists
 * an account id here AND inserts the account into flow_execution_enablement (a table the application can read but never write).
 * Both conditions are mandatory; the environment value is never read from the browser. Authoring is a separate, older flag
 * (FLOW_SUBFLOW_AUTHORING_ACCOUNT_IDS, P4).
 */
import { FLOW_EXECUTION_SCOPE_ENV, executionAllowed, listedAccountIds, readScope } from "./flow-scope";

export const SUBFLOW_EXECUTION_ACCOUNT_IDS_ENV = "FLOW_SUBFLOW_EXECUTION_ACCOUNT_IDS";

/** Environment half of the two execution keys: FLOW_EXECUTION_SCOPE ("allowlist" mode reads the list above). The database half is flow_execution_enablement. */
export function isSubflowExecutionEnabledForAccount(accountId: string): boolean {
  return executionAllowed(SUBFLOW_EXECUTION_ACCOUNT_IDS_ENV, accountId);
}

/** Accounts the subflow environment gate lists; null = every account (the database then decides). */
export function subflowExecutionAccountIds(): string[] | null {
  const scope = readScope(FLOW_EXECUTION_SCOPE_ENV);
  if (scope === "all") return null;
  if (scope === "off") return [];
  return listedAccountIds(SUBFLOW_EXECUTION_ACCOUNT_IDS_ENV);
}

/** Limits shared by the engine, the validator and the editor. The database enforces the same numbers. */
export const SUBFLOW_MAX_DEPTH = 3;
export const SUBFLOW_MAX_CALLS_PER_RUN = 8;
export type OnCustomerReply = "stop" | "continue";
export const ON_CUSTOMER_REPLY_VALUES: readonly OnCustomerReply[] = ["stop", "continue"];
export type EndScope = "run" | "subflow";
export const END_SCOPE_VALUES: readonly EndScope[] = ["run", "subflow"];
