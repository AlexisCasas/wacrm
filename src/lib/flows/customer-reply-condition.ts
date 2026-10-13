/**
 * Condition «Cliente respondió después del mensaje de referencia» (P7).
 *
 * It is a `condition` node with `subject: "customer_activity"`, `operator: "replied_after_reference"` and
 * `subject_key` = the key of the `send_message` / `send_media` node whose FIRST successful send is the reference.
 * The engine stores that send in `flow_runs.vars["$refs"]` the moment it happens (so it survives restarts and waits),
 * and the condition asks one cheap question: is there any message from the customer, in this contact's conversations,
 * newer than the reference? No text is compared. The reference is never "now" and never the flow's creation time.
 */
export const CUSTOMER_REPLY_CONDITION_ACCOUNT_IDS_ENV = "FLOW_CUSTOMER_REPLY_CONDITION_ACCOUNT_IDS";

export const CUSTOMER_ACTIVITY_SUBJECT = "customer_activity";
export const REPLIED_AFTER_REFERENCE_OPERATOR = "replied_after_reference";

/** Reserved `flow_runs.vars` keys. A `$` can never appear in a collect_input `var_key` nor in `{{vars.x}}`. */
export const REFERENCE_VARS_KEY = "$refs";
export const REPLY_GUARD_VARS_KEY = "$reply_guard";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Server-only per-account gate for AUTHORING and evaluating the condition. Empty by default; never read from the browser. */
export function isCustomerReplyConditionEnabledForAccount(accountId: string): boolean {
  return (process.env[CUSTOMER_REPLY_CONDITION_ACCOUNT_IDS_ENV] ?? "")
    .split(",").map((id) => id.trim()).filter((id) => UUID.test(id)).map((id) => id.toLowerCase())
    .includes(accountId.toLowerCase());
}

export function isCustomerActivityConfig(config: unknown): config is { subject: "customer_activity"; subject_key?: unknown; operator?: unknown } {
  return typeof config === "object" && config !== null && (config as { subject?: unknown }).subject === CUSTOMER_ACTIVITY_SUBJECT;
}

/** What the engine remembers about the reference send: the `messages` row it created (DB clock). */
export interface SendReference { message_id: string; conversation_id: string; sent_at: string }

export function parseSendReference(vars: Record<string, unknown>, nodeKey: string): SendReference | null {
  const refs = vars[REFERENCE_VARS_KEY];
  if (typeof refs !== "object" || refs === null || Array.isArray(refs)) return null;
  const ref = (refs as Record<string, unknown>)[nodeKey];
  if (typeof ref !== "object" || ref === null) return null;
  const { message_id, conversation_id, sent_at } = ref as Record<string, unknown>;
  if (typeof message_id !== "string" || !UUID.test(message_id)) return null;
  if (typeof conversation_id !== "string" || !UUID.test(conversation_id)) return null;
  if (typeof sent_at !== "string" || Number.isNaN(Date.parse(sent_at))) return null;
  return { message_id, conversation_id, sent_at };
}

/** Node keys that some customer-activity condition uses as its reference. */
export function referencedSendKeys(nodes: Iterable<{ node_type: string; config: unknown }>): Set<string> {
  const keys = new Set<string>();
  for (const node of nodes) {
    if (node.node_type !== "condition" || !isCustomerActivityConfig(node.config)) continue;
    const key = node.config.subject_key;
    if (typeof key === "string" && key) keys.add(key);
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
