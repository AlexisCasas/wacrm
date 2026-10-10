/**
 * Server-only rollout gate for condition nodes that read custom fields.
 *
 * A deliberately empty default means an E2 deployment is safe until an
 * operator explicitly opts an account in.  The value is never sent by the
 * browser and is evaluated again by API routes and the runner.
 *
 * Operational limitation: removing an opted-in account takes effect on the
 * next condition evaluation. A run already parked before a custom condition
 * therefore fails closed at that node; operators must inspect active runs and
 * drain/pause them deliberately before disabling a pilot or downgrading.
 */
export const CUSTOM_CONDITION_ACCOUNT_IDS_ENV =
  "FLOW_CUSTOM_CONDITIONS_ACCOUNT_IDS";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isCustomConditionEnabledForAccount(accountId: string): boolean {
  const configured = process.env[CUSTOM_CONDITION_ACCOUNT_IDS_ENV] ?? "";
  return configured
    .split(",")
    .map((id) => id.trim())
    .filter((id) => UUID.test(id))
    .includes(accountId);
}
