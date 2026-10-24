/**
 * Server-only rollout gate for condition nodes that hold several rules (match all / match any).
 *
 * Independent of `FLOW_CUSTOM_CONDITIONS_ACCOUNT_IDS`: a compound node that reads a custom field still needs that gate too.
 * An empty default means a deployment is inert until an operator opts an account in. The value never reaches the browser and
 * is checked again by the API routes and by the runner, so removing an account makes a parked run fail closed at its next
 * compound condition (see custom-condition-capability.ts for the operational note).
 */
export const COMPOUND_CONDITION_ACCOUNT_IDS_ENV = "FLOW_COMPOUND_CONDITIONS_ACCOUNT_IDS";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isCompoundConditionEnabledForAccount(accountId: string): boolean {
  const configured = process.env[COMPOUND_CONDITION_ACCOUNT_IDS_ENV] ?? "";
  return configured
    .split(",")
    .map((id) => id.trim())
    .filter((id) => UUID.test(id))
    .includes(accountId);
}
