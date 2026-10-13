/**
 * Server-only gate for EXECUTING "Run another flow" (migration 070). Empty by default: nobody has it until an operator lists
 * an account id here AND inserts the account into flow_execution_enablement (a table the application can read but never write).
 * Both conditions are mandatory; the environment value is never read from the browser. Authoring is a separate, older flag
 * (FLOW_SUBFLOW_AUTHORING_ACCOUNT_IDS, P4).
 */
export const SUBFLOW_EXECUTION_ACCOUNT_IDS_ENV = "FLOW_SUBFLOW_EXECUTION_ACCOUNT_IDS";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isSubflowExecutionEnabledForAccount(accountId: string): boolean {
  return (process.env[SUBFLOW_EXECUTION_ACCOUNT_IDS_ENV] ?? "")
    .split(",").map((id) => id.trim()).filter((id) => UUID.test(id)).map((id) => id.toLowerCase())
    .includes(accountId.toLowerCase());
}

/** Limits shared by the engine, the validator and the editor. The database enforces the same numbers. */
export const SUBFLOW_MAX_DEPTH = 3;
export const SUBFLOW_MAX_CALLS_PER_RUN = 8;
export type OnCustomerReply = "stop" | "continue";
export const ON_CUSTOMER_REPLY_VALUES: readonly OnCustomerReply[] = ["stop", "continue"];
export type EndScope = "run" | "subflow";
export const END_SCOPE_VALUES: readonly EndScope[] = ["run", "subflow"];
