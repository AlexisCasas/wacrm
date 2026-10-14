/**
 * Server-only gates for durable waits (P6). Neither value is ever read from the browser. They now follow the two global scope
 * switches (flow-scope.ts); the historic UUID lists below are the "allowlist" mode and remain the default.
 *
 *  - AUTHORING: the account may add / keep durable waits in DRAFT flows (editor option + PUT /api/flows/[id]).
 *  - EXECUTION: the account may ACTIVATE flows with durable waits and have the scheduler resume them. Off everywhere
 *    until a real, authorised run has been validated; migration 069 also blocks activation in the database.
 */
export const DURABLE_WAIT_AUTHORING_ACCOUNT_IDS_ENV = "FLOW_DURABLE_WAIT_AUTHORING_ACCOUNT_IDS";
export const DURABLE_WAIT_EXECUTION_ACCOUNT_IDS_ENV = "FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS";

import { authoringAllowed, executionAllowed, listedAccountIds, readScope, FLOW_EXECUTION_SCOPE_ENV } from "./flow-scope";

/** Authoring / execution are governed by FLOW_AUTHORING_SCOPE / FLOW_EXECUTION_SCOPE (see flow-scope.ts); the lists above are the "allowlist" mode. */
export function isDurableWaitAuthoringEnabledForAccount(accountId: string): boolean {
  return authoringAllowed(DURABLE_WAIT_AUTHORING_ACCOUNT_IDS_ENV, accountId);
}

export function isDurableWaitExecutionEnabledForAccount(accountId: string): boolean {
  return executionAllowed(DURABLE_WAIT_EXECUTION_ACCOUNT_IDS_ENV, accountId);
}

/**
 * Accounts whose waiting runs the scheduler may resume, according to the ENVIRONMENT half of the two keys.
 * "off" or an empty allowlist: [] (the scheduler does nothing and touches no database).
 * "allowlist": the listed ids. "all": null = "every account the database has enabled" (the caller asks the database).
 */
export function durableWaitExecutionAccountIds(): string[] | null {
  const scope = readScope(FLOW_EXECUTION_SCOPE_ENV);
  if (scope === "all") return null;
  if (scope === "off") return [];
  return listedAccountIds(DURABLE_WAIT_EXECUTION_ACCOUNT_IDS_ENV);
}
