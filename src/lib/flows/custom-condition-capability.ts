/**
 * Server-only rollout gate for condition nodes that read custom fields.
 *
 * A deliberately empty default means an E2 deployment is safe until an
 * operator explicitly opts an account in.  The value is never sent by the
 * browser and is evaluated again by API routes and the runner.
 */
export const CUSTOM_CONDITION_ACCOUNT_IDS_ENV =
  "FLOW_CUSTOM_CONDITIONS_ACCOUNT_IDS";

export function isCustomConditionEnabledForAccount(accountId: string): boolean {
  const configured = process.env[CUSTOM_CONDITION_ACCOUNT_IDS_ENV] ?? "";
  return configured
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(accountId);
}
