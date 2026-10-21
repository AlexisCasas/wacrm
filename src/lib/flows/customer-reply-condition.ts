/**
 * Condition «Cliente respondió después del mensaje de referencia» (P7).
 *
 * It is a `condition` node with `subject: "customer_activity"`, `operator: "replied_after_reference"` and
 * `subject_key` = the key of the `send_message` / `send_media` node whose FIRST successful send is the reference.
 * The engine stores that send in `flow_runs.vars["$refs"]` the moment it happens (so it survives restarts and waits),
 * and the condition asks one cheap question: is there any message from the customer, in this contact's conversations,
 * newer than the reference? No text is compared. The reference is never "now" and never the flow's creation time.
 */
import { authoringAllowed } from "./flow-scope";

export const CUSTOMER_REPLY_CONDITION_ACCOUNT_IDS_ENV = "FLOW_CUSTOMER_REPLY_CONDITION_ACCOUNT_IDS";

export const CUSTOMER_ACTIVITY_SUBJECT = "customer_activity";
export const REPLIED_AFTER_REFERENCE_OPERATOR = "replied_after_reference";

/** Reserved `flow_runs.vars` keys. A `$` can never appear in a collect_input `var_key` nor in `{{vars.x}}`. */
export const REFERENCE_VARS_KEY = "$refs";
export const REPLY_GUARD_VARS_KEY = "$reply_guard";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Server-only gate for AUTHORING (and evaluating) the condition: FLOW_AUTHORING_SCOPE, whose "allowlist" mode reads the list above. Never read from the browser. */
export function isCustomerReplyConditionEnabledForAccount(accountId: string): boolean {
  return authoringAllowed(CUSTOMER_REPLY_CONDITION_ACCOUNT_IDS_ENV, accountId);
}

export function isCustomerActivityConfig(config: unknown): config is { subject: "customer_activity"; subject_key?: unknown; operator?: unknown } {
  return typeof config === "object" && config !== null && (config as { subject?: unknown }).subject === CUSTOMER_ACTIVITY_SUBJECT;
}

/** Key under which a flow hands its chosen reference down to the flow it calls (migration 070 maintains it per frame). */
export const INHERITED_REFERENCE_KEY = "$inherited";
export const MAX_PRE_EXISTING_IDS = 20;

/**
 * What the engine remembers about the reference send: the `messages` row it created (DB clock) plus the customer messages that
 * ALREADY existed inside the reference second. Meta stamps inbound messages with whole seconds, so a real reply sent within the
 * same second as our message can look "older" than the reference. The comparison is therefore
 * "created_at >= window_start (the reference second, rounded down) AND not one of pre_ids": whatever was already stored when the
 * reference was recorded can never count as a reply, whatever arrives afterwards can, even inside the same second.
 */
export interface SendReference { message_id: string; conversation_id: string; sent_at: string; window_start: string; pre_ids: string[] }

/** The qualified key of a send node's reference: two flows can both have a node called "info". */
export function referenceKey(flowId: string, nodeKey: string): string { return `${flowId}#${nodeKey}`; }

export function floorToSecondIso(iso: string): string { return new Date(Math.floor(Date.parse(iso) / 1000) * 1000).toISOString(); }

export function parseReferenceObject(ref: unknown): SendReference | null {
  if (typeof ref !== "object" || ref === null || Array.isArray(ref)) return null;
  const { message_id, conversation_id, sent_at, window_start, pre_ids } = ref as Record<string, unknown>;
  if (typeof message_id !== "string" || !UUID.test(message_id)) return null;
  if (typeof conversation_id !== "string" || !UUID.test(conversation_id)) return null;
  if (typeof sent_at !== "string" || Number.isNaN(Date.parse(sent_at))) return null;
  if (typeof window_start !== "string" || Number.isNaN(Date.parse(window_start)) || window_start !== floorToSecondIso(sent_at)) return null;
  if (!Array.isArray(pre_ids) || pre_ids.length > MAX_PRE_EXISTING_IDS || !pre_ids.every((id) => typeof id === "string" && UUID.test(id))) return null;
  return { message_id, conversation_id, sent_at, window_start, pre_ids: pre_ids as string[] };
}

export function parseSendReference(vars: Record<string, unknown>, key: string): SendReference | null {
  const refs = vars[REFERENCE_VARS_KEY];
  if (typeof refs !== "object" || refs === null || Array.isArray(refs)) return null;
  return parseReferenceObject((refs as Record<string, unknown>)[key]);
}

/** Node keys of THIS flow whose first send must be remembered: the reference of a customer-activity condition, or the one a call hands down. */
export function referencedSendKeys(nodes: Iterable<{ node_type: string; config: unknown }>): Set<string> {
  const keys = new Set<string>();
  for (const node of nodes) {
    let key: unknown;
    if (node.node_type === "condition" && isCustomerActivityConfig(node.config)) key = node.config.subject_key;
    else if (node.node_type === "execute_flow" && typeof node.config === "object" && node.config !== null) key = (node.config as { reference_node_key?: unknown }).reference_node_key;
    if (typeof key === "string" && key && key !== INHERITED_REFERENCE_KEY) keys.add(key);
  }
  return keys;
}

/** Remembers only the FIRST send of a node: a loop must not move the reference forward. Pure. */
export function withSendReference(vars: Record<string, unknown>, nodeKey: string, ref: SendReference): Record<string, unknown> {
  if (parseSendReference(vars, nodeKey)) return vars;
  const refs = typeof vars[REFERENCE_VARS_KEY] === "object" && vars[REFERENCE_VARS_KEY] !== null && !Array.isArray(vars[REFERENCE_VARS_KEY])
    ? (vars[REFERENCE_VARS_KEY] as Record<string, unknown>) : {};
  return { ...vars, [REFERENCE_VARS_KEY]: { ...refs, [nodeKey]: ref } };
}
