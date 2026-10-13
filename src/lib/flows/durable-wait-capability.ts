/**
 * Server-only per-account gates for durable waits. Both default to EMPTY: nobody has them until an operator lists an
 * account id. Neither value is ever read from the browser.
 *
 *  - AUTHORING: the account may add / keep durable waits in DRAFT flows (editor option + PUT /api/flows/[id]).
 *  - EXECUTION: the account may ACTIVATE flows with durable waits and have the scheduler resume them. Off everywhere
 *    until a real, authorised run has been validated; migration 069 also blocks activation in the database.
 */
export const DURABLE_WAIT_AUTHORING_ACCOUNT_IDS_ENV = "FLOW_DURABLE_WAIT_AUTHORING_ACCOUNT_IDS";
export const DURABLE_WAIT_EXECUTION_ACCOUNT_IDS_ENV = "FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function configured(envName: string): string[] {
  return (process.env[envName] ?? "").split(",").map((id) => id.trim()).filter((id) => UUID.test(id)).map((id) => id.toLowerCase());
}

export function isDurableWaitAuthoringEnabledForAccount(accountId: string): boolean {
  return configured(DURABLE_WAIT_AUTHORING_ACCOUNT_IDS_ENV).includes(accountId.toLowerCase());
}

export function isDurableWaitExecutionEnabledForAccount(accountId: string): boolean {
  return configured(DURABLE_WAIT_EXECUTION_ACCOUNT_IDS_ENV).includes(accountId.toLowerCase());
}

/** Accounts whose waiting runs the scheduler may resume. Empty means the scheduler does nothing. */
export function durableWaitExecutionAccountIds(): string[] {
  return configured(DURABLE_WAIT_EXECUTION_ACCOUNT_IDS_ENV);
}
