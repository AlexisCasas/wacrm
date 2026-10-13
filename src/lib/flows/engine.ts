/**
 * Flow runner.
 *
 * The single entry point `dispatchInboundToFlows` is called by the
 * WhatsApp webhook on every inbound message *for an account that has
 * opted into the Flows beta*. It decides whether the message belongs
 * to an active conversation flow (advance it) or matches the entry
 * trigger of an active flow (start a new run) — and reports back to
 * the webhook so the webhook knows whether to also fire automations.
 *
 * Architecture in a sentence: the runner walks the customer through
 * a DB-stored node graph, suspending only at nodes that need
 * customer input. Each tap or text reply wakes it back up.
 *
 * What lives here vs elsewhere:
 *   - Pure decision logic (which button matched, where to advance to,
 *     when to fallback) — here.
 *   - DB shape (table reads/writes) — here.
 *   - Meta API calls — `meta-send.ts` (engineSendInteractive*).
 *   - Policy resolution (reprompt vs handoff vs end) — `fallback.ts`.
 *   - Type definitions — `types.ts`.
 *
 * Concurrency model:
 *   - Idempotency on `meta_message_id`: the runner refuses to advance
 *     an active run twice for the same Meta message — protects against
 *     Meta's retries.
 *   - Optimistic UPDATE with `current_node_key` precondition: two
 *     simultaneous taps for the same run collide at the DB layer; the
 *     second is a no-op.
 *   - Partial unique index `idx_one_active_run_per_contact`: two
 *     simultaneous starts for the same contact collide; the second
 *     INSERT raises 23505 and the runner catches & exits.
 */

import { supabaseAdmin } from "./admin-client";
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText,
} from "./meta-send";
import { decideFallback, resolveFallbackPolicy } from "./fallback";
import { addContactTagAndDispatch } from "@/lib/contacts/tag-events";
import { removeContactTag } from "@/lib/contacts/tag-write";
import { isCustomConditionEnabledForAccount } from "@/lib/flows/custom-condition-capability";
import { isDurableWaitExecutionEnabledForAccount } from "@/lib/flows/durable-wait-capability";
import { computeResumeAt, durableWaitSeconds, isDurableWaitConfig } from "@/lib/flows/durable-wait";
import { NATIVE_CONTACT_CONDITION_FIELDS } from "@/lib/flows/condition-references";
import { randomUUID } from "node:crypto";
import {
  CUSTOMER_ACTIVITY_SUBJECT,
  INHERITED_REFERENCE_KEY,
  MAX_PRE_EXISTING_IDS,
  REPLIED_AFTER_REFERENCE_OPERATOR,
  REPLY_GUARD_VARS_KEY,
  type SendReference,
  floorToSecondIso,
  isCustomerReplyConditionEnabledForAccount,
  parseReferenceObject,
  parseSendReference,
  referenceKey,
  referencedSendKeys,
  withSendReference,
} from "@/lib/flows/customer-reply-condition";
import { isSubflowExecutionEnabledForAccount, type OnCustomerReply } from "@/lib/flows/subflow-execution-capability";
import { ContactBlockedError } from "@/lib/contacts/blocking";
import {
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  type DelayNodeConfig,
  type DispatchInboundInput,
  type EndNodeConfig,
  type ExecuteFlowNodeConfig,
  type DispatchInboundResult,
  type FlowNodeRow,
  type FlowRow,
  type FlowRunRow,
  type ParsedInbound,
  type SendButtonsNodeConfig,
  type SendListNodeConfig,
  type SendMediaNodeConfig,
  type SendMessageNodeConfig,
  type SetContactFieldNodeConfig,
  type SetTagNodeConfig,
  type StartNodeConfig,
  type KeywordTriggerConfig,
} from "./types";

// ============================================================
// Pure helpers — extracted so engine.test.ts can exercise them
// without a Supabase / Meta mock.
// ============================================================

/**
 * Given a node + the customer's reply_id, return the next_node_key
 * to advance to, or `null` if no option matches.
 */
export function matchReplyId(
  node: { node_type: string; config: Record<string, unknown> },
  reply_id: string,
): string | null {
  if (node.node_type === "send_buttons") {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    const hit = cfg.buttons?.find((b) => b.reply_id === reply_id);
    return hit?.next_node_key ?? null;
  }
  if (node.node_type === "send_list") {
    const cfg = node.config as unknown as SendListNodeConfig;
    for (const section of cfg.sections ?? []) {
      const hit = section.rows?.find((r) => r.reply_id === reply_id);
      if (hit) return hit.next_node_key;
    }
    return null;
  }
  return null;
}

/**
 * Case-insensitive contains/exact match against a list of keywords.
 * Used by the trigger evaluator. Stable enough that the v3 builder
 * UI can preview matches by passing canned strings.
 */
export function matchesKeywordTrigger(
  text: string,
  cfg: KeywordTriggerConfig,
): boolean {
  if (!text || !cfg.keywords?.length) return false;
  const matchType = cfg.match_type ?? "contains";
  const haystack = cfg.case_sensitive ? text : text.toLowerCase();
  for (const raw of cfg.keywords) {
    if (!raw) continue;
    const needle = cfg.case_sensitive ? raw : raw.toLowerCase();
    if (matchType === "exact" ? haystack === needle : haystack.includes(needle)) {
      return true;
    }
  }
  return false;
}

/**
 * The strings an inbound message offers to a flow's *entry* trigger.
 *
 * Typed text offers itself. A button / list tap offers two: the visible
 * title — what the customer would have typed had the button not been
 * there — and the stable reply_id, because the automation engine's
 * `interactive_reply` trigger routes on the id, so an author moving a
 * menu into a flow reaches for the same value.
 *
 * Matching the id does mean a keyword that happens to be a substring of
 * an id can fire (ids are author-controlled slugs, defaulting to
 * `btn_1`). That is the same substring semantic keyword triggers
 * already have for typed text, and the alternative — ignoring the id —
 * silently breaks the author who keyed on it.
 */
export function entryTriggerTexts(message: ParsedInbound): string[] {
  if (message.kind === "text") return [message.text];
  return [...new Set([message.reply_title, message.reply_id])].filter(
    (v): v is string => Boolean(v && v.trim()),
  );
}

/** Nodes that advance to a next_node_key without waiting for input. */
export function isAutoAdvancing(node_type: string): boolean {
  return (
    node_type === "start" ||
    node_type === "send_message" ||
    node_type === "send_media" ||
    node_type === "condition" ||
    node_type === "set_tag" ||
    node_type === "delay" ||
    node_type === "set_contact_field"
  );
}

/** Nodes that send a prompt and suspend awaiting a customer reply. */
export function isSuspending(node_type: string): boolean {
  return (
    node_type === "send_buttons" ||
    node_type === "send_list" ||
    node_type === "collect_input"
  );
}

/** Nodes that end the run. */
export function isTerminal(node_type: string): boolean {
  return node_type === "handoff" || node_type === "end";
}

/**
 * Evaluate a `condition` node's predicate against the current run
 * state. Exported pure for unit testing — the engine wraps it with a
 * DB lookup for `tag` / `contact_field` subjects.
 */
export function evaluateConditionPredicate(args: {
  operator: ConditionNodeConfig["operator"];
  /**
   * Resolved value of the subject. `undefined` means the subject is
   * absent (no var with that key / no such tag / contact field is
   * null). Pure function: caller does the DB lookup.
   */
  subjectValue: string | undefined;
  /** The configured comparison value, when applicable. */
  configValue: string | undefined;
}): boolean {
  switch (args.operator) {
    case "present":
      return args.subjectValue !== undefined && args.subjectValue !== "";
    case "absent":
      return args.subjectValue === undefined || args.subjectValue === "";
    case "equals":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue === (args.configValue ?? "");
    case "contains":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue.includes(args.configValue ?? "");
    default:
      // `replied_after_reference` is decided by `customerRepliedAfterReference` (a DB question), never here. Fail closed.
      return false;
  }
}

// ============================================================
// DB I/O — wrapped in tiny helpers so the dispatch flow stays
// readable. Errors surface as thrown — the entry point catches.
// ============================================================

type AdminClient = ReturnType<typeof supabaseAdmin>;

async function loadActiveRunForContact(
  db: AdminClient,
  accountId: string,
  contactId: string,
): Promise<FlowRunRow | null> {
  // The partial unique index `idx_one_active_run_per_contact` was
  // rebuilt in migration 017 over `(account_id, contact_id)` — so
  // "two active runs for one contact in one account" is impossible
  // by design. But a future migration glitch or manual SQL could
  // create one, and .maybeSingle() throws on >1 row — which would
  // kill dispatch for that contact's webhook entirely. .limit(1) is
  // forgiving: pick the newest, let the cron sweep clean up the
  // stale one.
  const { data, error } = await db
    .from("flow_runs")
    .select("*")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("[flows] loadActiveRunForContact error:", error.message);
    return null;
  }
  const rows = (data as FlowRunRow[] | null) ?? [];
  return rows[0] ?? null;
}

async function loadFlow(
  db: AdminClient,
  flowId: string,
): Promise<FlowRow | null> {
  const { data, error } = await db
    .from("flows")
    .select("*")
    .eq("id", flowId)
    .maybeSingle();
  if (error) {
    console.error("[flows] loadFlow error:", error.message);
    return null;
  }
  return (data as FlowRow | null) ?? null;
}

/**
 * Load every node of a flow in one round trip and key them by
 * `node_key`. The advance loop is then in-memory — a 5-node
 * auto-advancing chain costs one SELECT, not five.
 *
 * Returns an empty map on error so the caller can still dispatch
 * cleanly (every subsequent .get() returns undefined → the run
 * fails with node_not_found, same as the old per-node lookup).
 */
async function loadAllNodes(
  db: AdminClient,
  flowId: string,
): Promise<Map<string, FlowNodeRow>> {
  const { data, error } = await db
    .from("flow_nodes")
    .select("*")
    .eq("flow_id", flowId);
  if (error) {
    console.error("[flows] loadAllNodes error:", error.message);
    return new Map();
  }
  const map = new Map<string, FlowNodeRow>();
  for (const row of (data ?? []) as FlowNodeRow[]) {
    map.set(row.node_key, row);
  }
  return map;
}

async function logEvent(
  db: AdminClient,
  flowRunId: string,
  event_type:
    | "started"
    | "node_entered"
    | "message_sent"
    | "reply_received"
    | "fallback_fired"
    | "handoff"
    | "timeout"
    | "error"
    | "completed",
  node_key: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await db.from("flow_run_events").insert({
    flow_run_id: flowRunId,
    event_type,
    node_key,
    payload,
  });
  if (error) {
    // Logging failure is non-fatal — surface but don't throw.
    console.error("[flows] logEvent error:", error.message);
  }
}

/**
 * Idempotency check — has a `reply_received` event with this Meta
 * message_id already been recorded for any of the contact's flow
 * runs? If yes, the inbound is a duplicate (Meta retry) and we
 * exit without re-advancing.
 *
 * Implementation note: scoped to runs belonging to this user/contact
 * so the lookup is cheap (the index on flow_run_events(flow_run_id,
 * event_type) plus the small set of runs per contact).
 */
async function isDuplicateInbound(
  db: AdminClient,
  accountId: string,
  contactId: string,
  metaMessageId: string,
): Promise<boolean> {
  // Fetch ALL run ids for this contact in this account (active +
  // historical). Bounded by how many flows the customer has been
  // through — small.
  const { data: runs } = await db
    .from("flow_runs")
    .select("id")
    .eq("account_id", accountId)
    .eq("contact_id", contactId);
  if (!runs?.length) return false;
  const runIds = runs.map((r) => (r as { id: string }).id);

  const { count } = await db
    .from("flow_run_events")
    .select("id", { count: "exact", head: true })
    .in("flow_run_id", runIds)
    .eq("event_type", "reply_received")
    .filter("payload->>meta_message_id", "eq", metaMessageId);
  return (count ?? 0) > 0;
}

async function findEntryFlow(
  db: AdminClient,
  accountId: string,
  message: ParsedInbound,
  isFirstInbound: boolean,
): Promise<FlowRow | null> {
  // A tap used to be rejected outright here, on the reasoning that
  // interactive replies are responses to existing prompts. That holds
  // only while a prompt is outstanding — and this function runs solely
  // when the contact has NO active run, so there is nothing the tap
  // could be answering. What it actually blocked was issue #490: an
  // *automation* sends the buttons, the customer taps one, and the flow
  // whose keyword matches that button never starts. Retyping the label
  // by hand worked, which is the tell — same words, different envelope.
  const candidates = entryTriggerTexts(message);

  // Pull all active flows for this account. Active set is bounded
  // (the builder discourages double-trigger overlap; partial index
  // makes the lookup index-supported).
  const { data: flows, error } = await db
    .from("flows")
    .select("*")
    .eq("account_id", accountId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error || !flows) return null;

  const typed = flows as FlowRow[];
  for (const flow of typed) {
    if (flow.trigger_type === "keyword") {
      const cfg = flow.trigger_config as KeywordTriggerConfig;
      if (candidates.some((text) => matchesKeywordTrigger(text, cfg))) {
        return flow;
      }
    } else if (flow.trigger_type === "first_inbound_message" && isFirstInbound) {
      // Also reachable by a tap now: a broadcast template with a
      // quick-reply button can genuinely be what prompts a contact's
      // first-ever inbound. The automations dispatcher has always
      // treated a tap that way (the webhook pushes
      // `first_inbound_message` regardless of envelope) — flows were
      // the inconsistent half.
      return flow;
    }
    // 'manual' triggers do not auto-start from inbound messages.
  }
  return null;
}

// ============================================================
// Node executors — each handles ONE node type. send_buttons and
// send_list also persist `last_prompt_message_id` so the inbox
// thread can quote the prompt the customer is replying to.
// ============================================================

async function sendButtonsAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendButtonsNodeConfig;
  const { whatsapp_message_id } = await engineSendInteractiveButtons({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: cfg.text,
    headerText: cfg.header_text,
    footerText: cfg.footer_text,
    buttons: cfg.buttons.map((b) => ({ id: b.reply_id, title: b.title })),
  });
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "send_buttons",
    whatsapp_message_id,
  });
  // Look up our internal message id so we can stash it on the run.
  // Cheap — indexed on `messages.message_id`.
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsapp_message_id)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq("id", run.id);
  return { outcome: "advanced", node_key: node.node_key };
}

async function sendListAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendListNodeConfig;
  const { whatsapp_message_id } = await engineSendInteractiveList({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: cfg.text,
    buttonLabel: cfg.button_label,
    headerText: cfg.header_text,
    footerText: cfg.footer_text,
    sections: cfg.sections.map((s) => ({
      title: s.title,
      rows: s.rows.map((r) => ({
        id: r.reply_id,
        title: r.title,
        description: r.description,
      })),
    })),
  });
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "send_list",
    whatsapp_message_id,
  });
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsapp_message_id)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq("id", run.id);
  return { outcome: "advanced", node_key: node.node_key };
}

async function executeHandoff(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<void> {
  const cfg = node.config as { assign_to?: string; note?: string };
  const convUpdate: Record<string, unknown> = {
    status: "pending",
    updated_at: new Date().toISOString(),
  };
  if (cfg.assign_to) convUpdate.assigned_agent_id = cfg.assign_to;
  if (run.conversation_id) {
    await db
      .from("conversations")
      .update(convUpdate)
      .eq("id", run.conversation_id);
  }
  await logEvent(db, run.id, "handoff", node.node_key, {
    note: cfg.note ?? null,
    assigned_to: cfg.assign_to ?? null,
  });
  await endRun(db, run.id, "handed_off", "handoff_node");
}

/** The flow the run is inside right now: the callee while a subflow is running, the root flow otherwise. */
function currentFlowIdOf(run: FlowRunRow): string {
  return run.current_flow_id ?? run.flow_id;
}

/** Strict variant of logEvent: callers that must not go on without the evidence (send intent, spontaneous replies) need to know. */
async function logEventStrict(
  db: AdminClient,
  flowRunId: string,
  event_type: "node_entered" | "reply_received" | "error",
  node_key: string | null,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const { error } = await db.from("flow_run_events").insert({ flow_run_id: flowRunId, event_type, node_key, payload });
  if (error) console.error("[flows] strict event failed:", error.message);
  return !error;
}

/** Conversations of the run's contact inside the run's account (one today: idx_conversations_account_contact). */
async function contactConversationIds(db: AdminClient, run: FlowRunRow): Promise<string[]> {
  if (!run.contact_id) throw new Error("customer_reply_contact_missing");
  const { data, error } = await db.from("conversations").select("id").eq("account_id", run.account_id).eq("contact_id", run.contact_id);
  if (error) throw new Error("customer_reply_conversation_lookup_failed");
  return ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
}

/**
 * P7: did the customer write after the reference send? One question, no text comparison.
 *
 * Fails CLOSED (throws, so the caller ends the run WITHOUT sending anything) when: the account is not enabled, the reference is
 * missing / corrupt / not from this contact's conversations, or any query fails.
 *
 * Tenancy: the contact's conversations in the run's account; the reference message must live in one of them. Only
 * `sender_type = 'customer'` rows count, whatever their content_type (text, image, audio, video, document, location, sticker,
 * interactive taps). Bot, agent and automation rows never count; reactions are not stored as messages.
 *
 * Time: inbound rows carry Meta's whole-second timestamp, so "newer than the reference" would miss a reply sent inside the same
 * second as our message. The check is therefore `created_at >= window_start` (the reference second rounded down) excluding the
 * `pre_ids` that were already stored when the reference was recorded (e.g. the message that started the flow).
 */
async function customerRepliedAfterReference(db: AdminClient, run: FlowRunRow, ref: SendReference): Promise<boolean> {
  if (!isCustomerReplyConditionEnabledForAccount(run.account_id) || !isDurableWaitExecutionEnabledForAccount(run.account_id)) {
    throw new Error("customer_reply_capability_disabled");
  }
  const conversationIds = await contactConversationIds(db, run);
  if (!conversationIds.includes(ref.conversation_id)) throw new Error("customer_reply_reference_not_in_contact");

  // The persisted outbound row is the source of truth for the timestamp; the copy in vars is only a pointer.
  const { data: referenceRow, error: referenceError } = await db
    .from("messages").select("id, created_at, sender_type").eq("id", ref.message_id).eq("conversation_id", ref.conversation_id).maybeSingle();
  if (referenceError) throw new Error("customer_reply_reference_lookup_failed");
  const row = referenceRow as { id: string; created_at: string | null; sender_type: string } | null;
  if (!row || row.sender_type === "customer" || !row.created_at || Number.isNaN(Date.parse(row.created_at))
      || new Date(row.created_at).getTime() !== new Date(ref.sent_at).getTime()) {
    throw new Error("customer_reply_reference_invalid");
  }

  let query = db.from("messages").select("id").in("conversation_id", conversationIds).eq("sender_type", "customer").gte("created_at", ref.window_start);
  if (ref.pre_ids.length) query = query.not("id", "in", `(${ref.pre_ids.join(",")})`);
  const { data: replies, error: repliesError } = await query.limit(1);
  if (repliesError) throw new Error("customer_reply_query_failed");
  return (replies ?? []).length > 0;
}

/** Resolve the reference a condition names: a send node of the CURRENT flow, or the one handed down by the calling flow. */
function resolveConditionReference(run: FlowRunRow, subjectKey: string): SendReference {
  const key = subjectKey === INHERITED_REFERENCE_KEY ? INHERITED_REFERENCE_KEY : referenceKey(currentFlowIdOf(run), subjectKey);
  const ref = typeof subjectKey === "string" && subjectKey ? parseSendReference(run.vars, key) : null;
  if (!ref) throw new Error("customer_reply_reference_missing");
  return ref;
}

/**
 * Remember the FIRST successful send of a node that a customer-activity condition (or a calling flow) points at. Never throws:
 * the message is already out, so a failure here only means the condition will fail closed later (no follow-up).
 */
async function recordSendReference(db: AdminClient, run: FlowRunRow, nodeKey: string, whatsappMessageId: string): Promise<void> {
  try {
    const key = referenceKey(currentFlowIdOf(run), nodeKey);
    if (parseSendReference(run.vars, key) || !run.conversation_id) return;
    const { data, error } = await db
      .from("messages").select("id, created_at").eq("conversation_id", run.conversation_id).eq("message_id", whatsappMessageId).maybeSingle();
    const row = data as { id: string; created_at: string | null } | null;
    if (error || !row?.created_at) throw new Error(error?.message ?? "reference_row_not_found");
    // customer messages ALREADY stored whose stamp lies inside the reference second up to our own timestamp: they predate our message and
    // must never count as a reply. A stamp AFTER our timestamp can only be an answer, so it is never excluded.
    const windowStart = floorToSecondIso(row.created_at);
    const conversationIds = await contactConversationIds(db, run);
    const { data: existing, error: existingError } = await db
      .from("messages").select("id").in("conversation_id", conversationIds).eq("sender_type", "customer").gte("created_at", windowStart).lte("created_at", row.created_at).limit(MAX_PRE_EXISTING_IDS + 1);
    if (existingError) throw new Error("pre_existing_lookup_failed");
    const preIds = ((existing ?? []) as Array<{ id: string }>).map((m) => m.id);
    if (preIds.length > MAX_PRE_EXISTING_IDS) throw new Error("too_many_messages_in_reference_second");   // cannot be told apart reliably: no reference, fail closed
    const vars = withSendReference(run.vars, key, { message_id: row.id, conversation_id: run.conversation_id, sent_at: row.created_at, window_start: windowStart, pre_ids: preIds });
    const { error: updateError } = await db.from("flow_runs").update({ vars }).eq("id", run.id).eq("account_id", run.account_id);
    if (updateError) throw new Error(updateError.message);
    run.vars = vars;
    await logEvent(db, run.id, "node_entered", nodeKey, { reason: "reply_reference_recorded", reference_message_id: row.id, pre_existing: preIds.length });
  } catch (err) {
    await logEvent(db, run.id, "error", nodeKey, { reason: "reply_reference_not_recorded", detail: err instanceof Error ? err.message : String(err) });
  }
}

/** Persist (or clear) the "do not send if the customer wrote meanwhile" guard. It stores the RESOLVED reference, so it survives returns. */
async function setReplyGuard(db: AdminClient, run: FlowRunRow, reference: SendReference | null): Promise<void> {
  const vars: Record<string, unknown> = { ...run.vars };
  if (reference) vars[REPLY_GUARD_VARS_KEY] = { reference };
  else delete vars[REPLY_GUARD_VARS_KEY];
  const { error } = await db.from("flow_runs").update({ vars }).eq("id", run.id).eq("account_id", run.account_id);
  if (error) throw new Error("customer_reply_guard_not_saved");
  run.vars = vars;
}

/** The frame of the subflow the run is inside (null for a flat run). */
async function topSubflowFrame(db: AdminClient, run: FlowRunRow): Promise<{ on_customer_reply: OnCustomerReply; called_at: string; return_node_key: string; caller_flow_id: string; callee_flow_id: string } | null> {
  if (!run.current_flow_id) return null;
  const { data, error } = await db
    .from("flow_run_subflow_frames").select("on_customer_reply, called_at, return_node_key, caller_flow_id, callee_flow_id")
    .eq("flow_run_id", run.id).eq("account_id", run.account_id).order("depth", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error("subflow_frame_lookup_failed");
  return (data as never) ?? null;
}

/**
 * A SPONTANEOUS reply is a customer message that reached the run while it sat parked on a wait (recorded as reply_received
 * with during_wait). Answers to a button, a list or a collect_input are consumed by that node and never recorded this way, so
 * they do not count. Evidence comes from the append-only event log, written strictly when the reply arrives.
 */
async function spontaneousReplySince(db: AdminClient, run: FlowRunRow, sinceIso: string): Promise<boolean> {
  const { data, error } = await db
    .from("flow_run_events").select("id").eq("flow_run_id", run.id).eq("event_type", "reply_received").eq("payload->>during_wait", "true").gt("created_at", sinceIso).limit(1);
  if (error) throw new Error("spontaneous_reply_lookup_failed");
  return (data ?? []).length > 0;
}

/**
 * Right before any send, look again at everything that says "do not send this follow-up":
 *   1. the P7 guard armed by a condition that answered "did not reply" (a customer message newer than the reference), and
 *   2. inside a subflow called with on_customer_reply = stop, a spontaneous reply that arrived while the run was parked.
 * Closes the long part of the race (everything between the decision and the send); the few milliseconds of the Meta call itself
 * cannot be closed and are documented. If the answer cannot be determined the run ends WITHOUT sending.
 * Returns true when the send must NOT happen (the run has been ended here).
 */
async function sendSuppressedByReplyGuard(db: AdminClient, run: FlowRunRow, nodeKey: string): Promise<boolean> {
  const guard = run.vars[REPLY_GUARD_VARS_KEY] as { reference?: unknown } | undefined;
  if (!guard && !run.current_flow_id) return false;
  try {
    if (guard) {
      const reference = parseReferenceObject(guard.reference);
      if (!reference) throw new Error("reply_guard_reference_invalid");
      if (await customerRepliedAfterReference(db, run, reference)) {
        await logEvent(db, run.id, "node_entered", nodeKey, { reason: "send_suppressed_customer_replied" });
        await endRun(db, run.id, "completed", "customer_replied_before_send");
        return true;
      }
    }
    const frame = await topSubflowFrame(db, run);
    if (frame?.on_customer_reply === "stop" && (await spontaneousReplySince(db, run, frame.called_at))) {
      await logEvent(db, run.id, "node_entered", nodeKey, { reason: "send_suppressed_spontaneous_reply" });
      await endRun(db, run.id, "completed", "customer_replied_in_subflow");
      return true;
    }
    return false;
  } catch (err) {
    await logEvent(db, run.id, "error", nodeKey, { reason: "reply_guard_failed", code: err instanceof Error ? err.message : "unknown" });
    await endRun(db, run.id, "failed", "reply_guard_failed");
    return true;
  }
}

/**
 * Write the intent to send BEFORE calling Meta. If the process dies afterwards, the run shows an intent without a matching
 * message_sent: the outcome is UNKNOWN and recovery must not resend it. If the intent cannot be written, nothing is sent.
 */
async function recordSendIntent(db: AdminClient, run: FlowRunRow, nodeKey: string, nodeType: string): Promise<boolean> {
  const ok = await logEventStrict(db, run.id, "node_entered", nodeKey, { reason: "send_intent", node_type: nodeType, flow_id: currentFlowIdOf(run), attempt: randomUUID() });
  if (!ok) {
    await logEvent(db, run.id, "error", nodeKey, { reason: "send_intent_not_recorded" });
    await endRun(db, run.id, "failed", "send_intent_not_recorded");
  }
  return ok;
}

/**
 * Resolve a condition node's subject value from DB / run state, then
 * call the pure `evaluateConditionPredicate`. Splits out so the
 * predicate itself stays unit-testable without a Supabase mock.
 *
 * Subject sources:
 *   - `var` → `flow_runs.vars[subject_key]` (captured by collect_input
 *     or http_fetch in v2).
 *   - `tag` → present iff `contact_tags(contact_id, tag_id)` exists.
 *     `subject_key` IS the tag UUID; the SELECT returns 1 row or 0.
 *   - `contact_field` → one of name/email/phone/company on `contacts`.
 */
export async function evaluateConditionNode(
  db: AdminClient,
  run: FlowRunRow,
  cfg: ConditionNodeConfig,
): Promise<boolean> {
  if (cfg.subject === CUSTOMER_ACTIVITY_SUBJECT) {
    if (cfg.operator !== REPLIED_AFTER_REFERENCE_OPERATOR) throw new Error("customer_reply_operator_invalid");
    return customerRepliedAfterReference(db, run, resolveConditionReference(run, cfg.subject_key));
  }
  if (!run.contact_id && cfg.subject !== "var") {
    throw new Error("condition_contact_missing");
  }
  let subjectValue: string | undefined;
  if (cfg.subject === "var") {
    const v = run.vars[cfg.subject_key];
    subjectValue = typeof v === "string" ? v : v === undefined ? undefined : String(v);
  } else if (cfg.subject === "tag") {
    // The service client bypasses RLS: establish both ownership links before
    // looking at the join row, rather than trusting an id from JSONB.
    const [{ data: contact, error: contactError }, { data: tag, error: tagError }] = await Promise.all([
      db.from("contacts").select("id").eq("id", run.contact_id!).eq("account_id", run.account_id).maybeSingle(),
      db.from("tags").select("id").eq("id", cfg.subject_key).eq("account_id", run.account_id).maybeSingle(),
    ]);
    if (contactError || tagError) throw new Error("condition_reference_lookup_failed");
    if (!contact) throw new Error("condition_contact_not_in_account");
    if (!tag) throw new Error("condition_tag_not_in_account");
    const { count, error } = await db
      .from("contact_tags")
      .select("contact_id", { count: "exact", head: true })
      .eq("contact_id", run.contact_id!)
      .eq("tag_id", cfg.subject_key);
    if (error) throw new Error("condition_tag_lookup_failed");
    // For tags, "present" really is the only meaningful test — the
    // `present`/`absent` operators are the natural fit. equals/contains
    // against a tag UUID would still work mechanically (compare its
    // existence to the value).
    subjectValue = (count ?? 0) > 0 ? cfg.subject_key : undefined;
  } else {
    const { data: contact, error: contactError } = await db
      .from("contacts")
      .select("id, name, email, phone, company")
      .eq("id", run.contact_id!)
      .eq("account_id", run.account_id)
      .maybeSingle();
    if (contactError) throw new Error("condition_contact_lookup_failed");
    if (!contact) throw new Error("condition_contact_not_in_account");
    if (cfg.subject_key.startsWith("custom:")) {
      if (!isCustomConditionEnabledForAccount(run.account_id)) {
        throw new Error("custom_condition_capability_disabled");
      }
      const customFieldId = cfg.subject_key.slice("custom:".length);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(customFieldId)) {
        throw new Error("custom_condition_reference_invalid");
      }
      const { data: field, error: fieldError } = await db
        .from("custom_fields").select("id")
        .eq("id", customFieldId).eq("account_id", run.account_id).maybeSingle();
      if (fieldError) throw new Error("custom_condition_field_lookup_failed");
      if (!field) throw new Error("custom_condition_field_not_in_account");
      const { data: value, error: valueError } = await db
        .from("contact_custom_values").select("value")
        .eq("contact_id", run.contact_id!).eq("custom_field_id", customFieldId).maybeSingle();
      if (valueError) throw new Error("custom_condition_value_lookup_failed");
      const raw = (value as { value?: unknown } | null)?.value;
      subjectValue = typeof raw === "string" && raw.length > 0 ? raw : undefined;
    } else {
      if (!(NATIVE_CONTACT_CONDITION_FIELDS as readonly string[]).includes(cfg.subject_key)) {
        throw new Error("condition_native_field_invalid");
      }
      const raw = (contact as Record<string, unknown>)[cfg.subject_key];
      subjectValue = typeof raw === "string" && raw.length > 0 ? raw : undefined;
    }
  }
  return evaluateConditionPredicate({
    operator: cfg.operator,
    subjectValue,
    configValue: cfg.value,
  });
}

/**
 * Tiny `{{vars.foo}}` interpolation. Used by send_message + collect_input
 * prompt text so a captured `name` can show up in the next prompt
 * ("Thanks {{vars.name}}, what's your email?"). Missing vars render as
 * empty string — the same behavior as the automations engine.
 */
function interpolateVars(template: string, vars: Record<string, unknown>): string {
  if (!template) return "";
  return template.replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Re-check a run's status directly from the DB — never trust an
 * in-memory `run` object read before an `await` boundary (a delay node
 * sleeps for real seconds; the row can change underneath it). Used
 * exclusively by the `delay` node to detect an agent take-over that
 * happened while it was sleeping.
 */
async function isRunActive(db: AdminClient, runId: string): Promise<boolean> {
  const { data, error } = await db
    .from("flow_runs")
    .select("status")
    .eq("id", runId)
    .maybeSingle();
  if (error || !data) return false;
  return (data as { status: string }).status === "active";
}

/**
 * Write one custom field on the run's contact, then let the caller
 * advance. Mirrors `update_contact_field` in
 * src/lib/automations/engine.ts (same `custom:<id>` encoding, same
 * defense-in-depth account checks) — narrower on purpose: only
 * `custom:<id>` is accepted here, not the built-in name/email/company
 * columns, since every ManyChat "Set Custom User Field" action this
 * node replicates targets a custom field.
 *
 * Throws on any tenancy failure or DB error; the caller (the advance
 * loop) treats that as non-fatal — logged, then advances anyway — so a
 * bad field reference can't strand the customer mid-flow (same
 * tolerance `set_tag` already has for a bad tag write).
 */
async function executeSetContactField(
  db: AdminClient,
  run: FlowRunRow,
  cfg: SetContactFieldNodeConfig,
): Promise<void> {
  if (!cfg.field.startsWith("custom:")) {
    throw new Error(
      `unsupported field "${cfg.field}" — only custom:<custom_field_id> is writable from a Flow`,
    );
  }
  const customFieldId = cfg.field.slice("custom:".length);
  if (!customFieldId) {
    throw new Error(`field "${cfg.field}" is missing a custom_field_id`);
  }
  if (!run.contact_id) {
    throw new Error("set_contact_field needs a contact on the run");
  }

  // Defense in depth: the service-role client bypasses RLS. Confirm
  // BOTH sides of the write belong to this run's account — the field
  // definition AND the contact — before writing anything.
  const { data: field } = await db
    .from("custom_fields")
    .select("id")
    .eq("id", customFieldId)
    .eq("account_id", run.account_id)
    .maybeSingle();
  if (!field) {
    throw new Error(`custom field ${customFieldId} not found for this account`);
  }

  const { data: contact } = await db
    .from("contacts")
    .select("id")
    .eq("id", run.contact_id)
    .eq("account_id", run.account_id)
    .maybeSingle();
  if (!contact) {
    throw new Error(`contact ${run.contact_id} not found for this account`);
  }

  const value = interpolateVars(cfg.value, run.vars);

  // Upsert on the table's UNIQUE(contact_id, custom_field_id) so
  // repeated visits to this node overwrite rather than duplicate.
  const { error } = await db.from("contact_custom_values").upsert(
    { contact_id: run.contact_id, custom_field_id: customFieldId, value },
    { onConflict: "contact_id,custom_field_id" },
  );
  if (error) throw error;
}

async function endRun(
  db: AdminClient,
  runId: string,
  status: "completed" | "handed_off" | "timed_out" | "failed" | "paused_by_agent",
  reason: string,
): Promise<void> {
  await db
    .from("flow_runs")
    .update({
      status,
      ended_at: new Date().toISOString(),
      end_reason: reason,
    })
    .eq("id", runId);
}

/**
 * A blocked-contact race (agent blocks the contact while a send node
 * was already in flight) must end the run with the SAME status +
 * end_reason the block route itself sets — never let the generic
 * send-failure catch a caller might otherwise fall into relabel this
 * as a plain send failure. That would both misreport why the run
 * stopped AND, since the block route's own pause-active-runs UPDATE is
 * scoped `WHERE status='active'`, could race past this run entirely if
 * this write landed first with some other status.
 */
async function endRunForContactBlocked(
  db: AdminClient,
  runId: string,
  nodeKey: string | null,
): Promise<void> {
  await logEvent(db, runId, "error", nodeKey, { reason: "contact_blocked" });
  await endRun(db, runId, "paused_by_agent", "contact_blocked");
}

/** Re-read what the push / pop RPCs changed on the run, so the in-memory copy never disagrees with the database. */
async function refreshRunAfterStackChange(db: AdminClient, run: FlowRunRow): Promise<boolean> {
  const { data, error } = await db.from("flow_runs").select("vars, current_flow_id, current_node_key, status").eq("id", run.id).eq("account_id", run.account_id).maybeSingle();
  const row = data as { vars: Record<string, unknown>; current_flow_id: string | null; current_node_key: string | null; status: string } | null;
  if (error || !row || row.status !== "active") return false;
  run.vars = row.vars ?? {}; run.current_flow_id = row.current_flow_id; run.current_node_key = row.current_node_key;
  return true;
}

/** The graph of the flow the run is now inside, checked against the pins the frames hold. A mismatch ends the run. */
async function loadStackGraph(db: AdminClient, run: FlowRunRow, nodeKey: string): Promise<Map<string, FlowNodeRow> | null> {
  const graph = await loadAllNodes(db, currentFlowIdOf(run));
  const { data, error } = await db.rpc("verify_flow_run_stack", { p_account_id: run.account_id, p_run_id: run.id });
  const verdict = data as { ok?: boolean; reason?: string } | null;
  if (error || !verdict?.ok || !graph.has(nodeKey)) {
    await logEvent(db, run.id, "error", nodeKey, { reason: "subflow_stack_invalid", code: error ? "rpc_failed" : (verdict?.reason ?? (graph.has(nodeKey) ? "unknown" : "node_missing")) });
    await endRun(db, run.id, "failed", "subflow_stack_invalid");
    return null;
  }
  return graph;
}

/**
 * execute_flow: call another flow of the same account and come back. The database is the authority (migration 070 re-checks the
 * account, the call node, depth, cycles, enablement and pins both graphs); this function only prepares the call and moves on.
 */
async function enterSubflow(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ kind: "ended" } | { kind: "entered"; nodes: Map<string, FlowNodeRow>; entryNodeKey: string }> {
  const fail = async (reason: string, detail?: string): Promise<{ kind: "ended" }> => {
    await logEvent(db, run.id, "error", node.node_key, { reason, ...(detail ? { detail } : {}) });
    await endRun(db, run.id, "failed", reason);
    return { kind: "ended" };
  };
  if (!isSubflowExecutionEnabledForAccount(run.account_id)) return fail("subflow_execution_not_enabled");
  const cfg = node.config as unknown as ExecuteFlowNodeConfig;
  if (typeof cfg.target_flow_id !== "string" || typeof cfg.next_node_key !== "string" || !cfg.next_node_key) return fail("invalid_execute_flow_config");
  const policy: OnCustomerReply = cfg.on_customer_reply === "continue" ? "continue" : "stop";
  // The caller's chosen reference (a send node of THIS flow) travels with the call. Missing => the callee fails closed if it needs it.
  const reference = cfg.reference_node_key ? parseSendReference(run.vars, referenceKey(currentFlowIdOf(run), cfg.reference_node_key)) : null;
  if (cfg.reference_node_key && !reference) return fail("subflow_reference_missing");
  const { data, error } = await db.rpc("push_flow_subflow", {
    p_account_id: run.account_id, p_run_id: run.id, p_call_node_key: node.node_key, p_callee_flow_id: cfg.target_flow_id,
    p_return_node_key: cfg.next_node_key, p_reference: reference, p_on_customer_reply: policy,
  });
  const result = data as { ok?: boolean; reason?: string; entry_node_key?: string; depth?: number } | null;
  if (error || !result?.ok || !result.entry_node_key) return fail(`subflow_call_refused:${error ? "rpc_failed" : (result?.reason ?? "unknown")}`);
  if (!(await refreshRunAfterStackChange(db, run))) return { kind: "ended" };
  await logEvent(db, run.id, "node_entered", node.node_key, { reason: "subflow_called", callee_flow_id: cfg.target_flow_id, depth: result.depth, return_node_key: cfg.next_node_key, on_customer_reply: policy });
  const graph = await loadStackGraph(db, run, result.entry_node_key);
  return graph ? { kind: "entered", nodes: graph, entryNodeKey: result.entry_node_key } : { kind: "ended" };
}

/**
 * "End this subflow and return" reached inside a called flow. The caller continues ONLY if: the stack is intact, and (policy stop)
 * the customer did not write spontaneously while the callee was parked. Otherwise the run ends here and the caller never resumes.
 */
async function leaveSubflow(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ kind: "ended" } | { kind: "returned"; nodes: Map<string, FlowNodeRow>; returnNodeKey: string }> {
  const fail = async (reason: string, detail?: string): Promise<{ kind: "ended" }> => {
    await logEvent(db, run.id, "error", node.node_key, { reason, ...(detail ? { detail } : {}) });
    await endRun(db, run.id, "failed", reason);
    return { kind: "ended" };
  };
  const calleeFlowId = currentFlowIdOf(run);
  let frame: Awaited<ReturnType<typeof topSubflowFrame>>;
  try {
    frame = await topSubflowFrame(db, run);
    if (frame?.on_customer_reply === "stop" && (await spontaneousReplySince(db, run, frame.called_at))) {
      await logEvent(db, run.id, "node_entered", node.node_key, { reason: "return_cancelled_spontaneous_reply", callee_flow_id: calleeFlowId });
      await endRun(db, run.id, "completed", "customer_replied_in_subflow");
      return { kind: "ended" };
    }
  } catch (err) {
    return fail("subflow_return_check_failed", err instanceof Error ? err.message : undefined);
  }
  if (!frame) return fail("subflow_frame_missing");
  const { data, error } = await db.rpc("pop_flow_subflow", { p_account_id: run.account_id, p_run_id: run.id, p_expected_callee_flow_id: calleeFlowId });
  const result = data as { ok?: boolean; reason?: string; return_node_key?: string } | null;
  if (error || !result?.ok || !result.return_node_key) return fail(`subflow_return_refused:${error ? "rpc_failed" : (result?.reason ?? "unknown")}`);
  if (!(await refreshRunAfterStackChange(db, run))) return { kind: "ended" };
  await logEvent(db, run.id, "node_entered", node.node_key, { reason: "subflow_returned", callee_flow_id: calleeFlowId, return_node_key: result.return_node_key });
  const graph = await loadStackGraph(db, run, result.return_node_key);
  return graph ? { kind: "returned", nodes: graph, returnNodeKey: result.return_node_key } : { kind: "ended" };
}

// ============================================================
// The synchronous advance loop. Walks through auto-advance nodes
// until it hits one that suspends (send_buttons/send_list) or
// terminates (handoff/end). Each suspending node persists the
// new current_node_key before returning.
// ============================================================

async function advanceFromNodeKey(
  db: AdminClient,
  run: FlowRunRow,
  startNodeKey: string,
  initialNodes: Map<string, FlowNodeRow>,
): Promise<{ outcome: "advanced" | "completed" | "handed_off" }> {
  let currentKey: string | null = startNodeKey;
  // The graph the run is walking. It changes when the run enters a subflow or returns from one (execute_flow / end).
  let nodes = initialNodes;
  let referenceKeys = referencedSendKeys(nodes.values());
  // Defensive cap — if a flow has a cycle (which the validator
  // SHOULD catch but doesn't yet in v1), we bail rather than loop.
  for (let safety = 0; safety < 64; safety += 1) {
    if (!currentKey) {
      await logEvent(db, run.id, "error", null, {
        reason: "next_node_key was null mid-advance",
      });
      await endRun(db, run.id, "failed", "missing_next_node");
      return { outcome: "completed" };
    }
    const node: FlowNodeRow | null = nodes.get(currentKey) ?? null;
    if (!node) {
      await logEvent(db, run.id, "error", currentKey, {
        reason: "node_not_found",
      });
      await endRun(db, run.id, "failed", "node_not_found");
      return { outcome: "completed" };
    }
    await logEvent(db, run.id, "node_entered", node.node_key, {
      node_type: node.node_type,
    });

    if (node.node_type === "start") {
      currentKey = (node.config as unknown as StartNodeConfig).next_node_key;
      continue;
    }
    if (
      node.node_type === "send_message" || node.node_type === "send_media" || node.node_type === "collect_input" ||
      node.node_type === "send_buttons" || node.node_type === "send_list"
    ) {
      // Re-validate everything that says "do not send this follow-up", then write the intent BEFORE the Meta call.
      if (await sendSuppressedByReplyGuard(db, run, node.node_key)) return { outcome: "completed" };
      if (!(await recordSendIntent(db, run, node.node_key, node.node_type))) return { outcome: "completed" };
    }
    if (node.node_type === "send_message") {
      const cfg = node.config as unknown as SendMessageNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.text, run.vars),
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_message",
          whatsapp_message_id,
        });
        if (referenceKeys.has(node.node_key)) await recordSendReference(db, run, node.node_key, whatsapp_message_id);
      } catch (err) {
        if (err instanceof ContactBlockedError) {
          await endRunForContactBlocked(db, run.id, node.node_key);
          return { outcome: "completed" };
        }
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_text_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_text_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_media") {
      const cfg = node.config as unknown as SendMediaNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendMedia({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          kind: cfg.media_type,
          link: cfg.media_url,
          caption: cfg.caption
            ? interpolateVars(cfg.caption, run.vars)
            : undefined,
          filename: cfg.filename,
          // TEMPORARY ManyChat coexistence bridge (PENDIENTE 02.1B) —
          // ignored by meta-send.ts under Meta transport. No ManyChat
          // dependency here: engine.ts only ever hands the config
          // value through.
          manychatBridgeFlowNs: cfg.manychat_bridge_flow_ns,
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_media",
          media_type: cfg.media_type,
          whatsapp_message_id,
        });
        if (referenceKeys.has(node.node_key)) await recordSendReference(db, run, node.node_key, whatsapp_message_id);
      } catch (err) {
        if (err instanceof ContactBlockedError) {
          await endRunForContactBlocked(db, run.id, node.node_key);
          return { outcome: "completed" };
        }
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_media_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_media_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "collect_input") {
      // Send the prompt and suspend. Customer's next TEXT reply will
      // wake us up via handleReplyForActiveRun's collect_input branch.
      const cfg = node.config as unknown as CollectInputNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "collect_input",
          whatsapp_message_id,
        });
        const { data: msg } = await db
          .from("messages")
          .select("id")
          .eq("message_id", whatsapp_message_id)
          .maybeSingle();
        await db
          .from("flow_runs")
          .update({
            last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
          })
          .eq("id", run.id);
      } catch (err) {
        if (err instanceof ContactBlockedError) {
          await endRunForContactBlocked(db, run.id, node.node_key);
          return { outcome: "completed" };
        }
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "collect_input_prompt_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "collect_input_prompt_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "condition") {
      const cfg = node.config as unknown as ConditionNodeConfig;
      let branch: "true" | "false";
      try {
        branch = (await evaluateConditionNode(db, run, cfg))
          ? "true"
          : "false";
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "condition_evaluation_failed",
          // Do not persist database messages or resolved field values in the
          // run event; they can contain tenant or customer data.
          code: err instanceof Error ? err.message : "condition_unknown_error",
        });
        await endRun(db, run.id, "failed", "condition_evaluation_failed");
        return { outcome: "completed" };
      }
      if (cfg.subject === CUSTOMER_ACTIVITY_SUBJECT) {
        // "Did not reply" arms the guard so every later send re-checks right before going out; "replied" disarms it.
        try {
          await setReplyGuard(db, run, branch === "false" ? resolveConditionReference(run, cfg.subject_key) : null);
        } catch (err) {
          await logEvent(db, run.id, "error", node.node_key, { reason: "reply_guard_failed", code: err instanceof Error ? err.message : "unknown" });
          await endRun(db, run.id, "failed", "reply_guard_failed");
          return { outcome: "completed" };
        }
      }
      currentKey =
        branch === "true" ? cfg.true_next : cfg.false_next;
      await logEvent(db, run.id, "node_entered", node.node_key, {
        condition_result: branch,
        advancing_to: currentKey,
      });
      continue;
    }
    if (node.node_type === "set_tag") {
      const cfg = node.config as unknown as SetTagNodeConfig;
      try {
        if (cfg.mode === "add") {
          await addContactTagAndDispatch({
            db,
            accountId: run.account_id,
            contactId: run.contact_id!,
            tagId: cfg.tag_id,
            context: {
              conversation_id: run.conversation_id ?? undefined,
              vars: run.vars,
            },
          });
        } else {
          await removeContactTag(db, {
            accountId: run.account_id,
            contactId: run.contact_id!,
            tagId: cfg.tag_id,
          });
        }
      } catch (err) {
        // Non-fatal — log + advance. A tag-write failure shouldn't
        // strand the customer mid-flow.
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "set_tag_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "delay" && isDurableWaitConfig(node.config)) {
      // Durable wait (migration 069): never sleep in-process. Park the run and let the scheduler resume it.
      const cfg = node.config as unknown as DelayNodeConfig;
      if (!isDurableWaitExecutionEnabledForAccount(run.account_id)) {
        // Fail CLOSED: a build or a flag that cannot honour the wait must not run the steps after it early.
        await logEvent(db, run.id, "error", node.node_key, { reason: "durable_wait_not_enabled" });
        await endRun(db, run.id, "failed", "durable_wait_not_enabled");
        return { outcome: "completed" };
      }
      const wait = durableWaitSeconds(cfg);
      if (!wait.ok || !cfg.next_node_key || !nodes.has(cfg.next_node_key)) {
        await logEvent(db, run.id, "error", node.node_key, { reason: "invalid_durable_wait", detail: wait.ok ? "next_node_missing" : wait.reason });
        await endRun(db, run.id, "failed", "invalid_durable_wait");
        return { outcome: "completed" };
      }
      const resumeAt = computeResumeAt(wait.seconds, new Date());
      const { data: scheduled, error: scheduleError } = await db.rpc("schedule_flow_wait", {
        p_account_id: run.account_id,
        p_run_id: run.id,
        p_node_key: node.node_key,
        p_wait_until: resumeAt.toISOString(),
      });
      if (scheduleError) {
        await logEvent(db, run.id, "error", node.node_key, { reason: "wait_schedule_failed", detail: scheduleError.message });
        await endRun(db, run.id, "failed", "wait_schedule_failed");
        return { outcome: "completed" };
      }
      if (scheduled !== true) {
        // The run is no longer active (an agent took over, the contact was blocked...): do NOT touch its status.
        await logEvent(db, run.id, "node_entered", node.node_key, { reason: "wait_not_scheduled_run_no_longer_active" });
        return { outcome: "completed" };
      }
      await logEvent(db, run.id, "node_entered", node.node_key, {
        node_type: "delay",
        durable: true,
        amount: cfg.amount,
        unit: cfg.unit,
        resume_at: resumeAt.toISOString(),
      });
      return { outcome: "advanced" };
    }
    if (node.node_type === "delay") {
      const cfg = node.config as unknown as DelayNodeConfig;
      // V1 scope: bounded [1, 30]s, in-process sleep — no scheduler, no
      // persisted "waiting" checkpoint. Clamp defensively even though
      // the builder + validator already enforce the range, since this
      // value came out of the DB, not straight from the form.
      const seconds = Math.min(30, Math.max(1, Math.floor(cfg.seconds) || 1));
      await logEvent(db, run.id, "node_entered", node.node_key, {
        node_type: "delay",
        seconds,
      });
      await sleep(seconds * 1000);
      // The flow must stay the owner of this conversation for the
      // WHOLE delay: never activate AI, never let a fallback fire, and
      // — the specific case a real sleep introduces — never keep
      // sending if a human took over while we were asleep. Re-read the
      // run's status from the DB rather than trusting the in-memory
      // `run` (read before the sleep): send-message.ts's
      // pause-on-agent-send flips status away from 'active' the
      // moment an agent replies, and that write can land at any point
      // during these up-to-30 real seconds.
      if (!(await isRunActive(db, run.id))) {
        await logEvent(db, run.id, "node_entered", node.node_key, {
          reason: "delay_aborted_run_no_longer_active",
        });
        // Deliberately does NOT call endRun() — the row's status/
        // ended_at/end_reason already reflect whatever took over
        // (typically 'paused_by_agent'), and must not be overwritten.
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "set_contact_field") {
      const cfg = node.config as unknown as SetContactFieldNodeConfig;
      try {
        await executeSetContactField(db, run, cfg);
      } catch (err) {
        // Non-fatal — mirrors set_tag: a bad/missing field reference
        // must not strand the customer mid-flow.
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "set_contact_field_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_buttons") {
      await sendButtonsAndSuspend(db, run, node);
      // Persist the new current_node_key via optimistic UPDATE.
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "send_list") {
      await sendListAndSuspend(db, run, node);
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "handoff") {
      await executeHandoff(db, run, node);
      return { outcome: "handed_off" };
    }
    if (node.node_type === "execute_flow") {
      const call = await enterSubflow(db, run, node);
      if (call.kind === "ended") return { outcome: "completed" };
      nodes = call.nodes; referenceKeys = referencedSendKeys(nodes.values()); currentKey = call.entryNodeKey;
      continue;
    }
    if (node.node_type === "end") {
      if ((node.config as EndNodeConfig).scope === "subflow" && run.current_flow_id) {
        // "End this subflow and return": the caller resumes at its return node, unless the stack or the customer says otherwise.
        const back = await leaveSubflow(db, run, node);
        if (back.kind === "ended") return { outcome: "completed" };
        nodes = back.nodes; referenceKeys = referencedSendKeys(nodes.values()); currentKey = back.returnNodeKey;
        continue;
      }
      // Default (historic behaviour): the whole execution ends, wherever the run is.
      await logEvent(db, run.id, "completed", node.node_key);
      await endRun(db, run.id, "completed", "end_node");
      return { outcome: "completed" };
    }
    // Unknown node type — shouldn't happen given the CHECK constraint.
    await logEvent(db, run.id, "error", node.node_key, {
      reason: `unknown_node_type:${node.node_type}`,
    });
    await endRun(db, run.id, "failed", "unknown_node_type");
    return { outcome: "completed" };
  }
  // Safety break — log + fail.
  await logEvent(db, run.id, "error", currentKey, {
    reason: "advance_loop_safety_break",
  });
  await endRun(db, run.id, "failed", "advance_loop_overflow");
  return { outcome: "completed" };
}

/**
 * Optimistic UPDATE — only advance current_node_key when it matches
 * the value we read at the top of dispatch. If another webhook beat
 * us, the row's pointer has already moved and our UPDATE returns
 * zero rows; we treat that as a no-op and let the other run continue.
 */
async function advanceCurrentNodeKey(
  db: AdminClient,
  runId: string,
  expectedOldKey: string | null,
  newKey: string,
): Promise<boolean> {
  // PostgREST: when expectedOldKey is null we can't `.eq` (would match
  // any row); use `.is('current_node_key', null)` instead.
  let q = db
    .from("flow_runs")
    .update({
      current_node_key: newKey,
      last_advanced_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("status", "active");
  if (expectedOldKey === null) {
    q = q.is("current_node_key", null);
  } else {
    q = q.eq("current_node_key", expectedOldKey);
  }
  const { data, error } = await q.select("id");
  if (error) {
    console.error("[flows] advanceCurrentNodeKey error:", error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

// ============================================================
// Public entry point — the webhook calls this on every inbound.
// ============================================================

export async function dispatchInboundToFlows(
  input: DispatchInboundInput & { isFirstInboundMessage: boolean },
): Promise<DispatchInboundResult> {
  const db = supabaseAdmin();
  try {
    const activeRun = await loadActiveRunForContact(
      db,
      input.accountId,
      input.contactId,
    );

    // Idempotency — only matters if there's already a run for this
    // contact. For new runs, the partial unique index catches duplicate
    // starts at INSERT time.
    if (activeRun) {
      const dupe = await isDuplicateInbound(
        db,
        input.accountId,
        input.contactId,
        input.message.meta_message_id,
      );
      if (dupe) {
        return {
          consumed: true,
          flow_run_id: activeRun.id,
          outcome: "duplicate_inbound_ignored",
        };
      }
      // One SELECT for the whole flow's nodes — advance loop is now
      // in-memory. See loadAllNodes.
      const nodes = await loadAllNodes(db, currentFlowIdOf(activeRun));
      if (activeRun.current_flow_id) {
        // The run sits inside a called flow: answer it only if every flow of the stack is still the one the call pinned.
        const { data: verdictData, error: verdictError } = await db.rpc("verify_flow_run_stack", { p_account_id: activeRun.account_id, p_run_id: activeRun.id });
        const verdict = verdictData as { ok?: boolean; reason?: string } | null;
        if (verdictError || !verdict?.ok) {
          await logEvent(db, activeRun.id, "error", activeRun.current_node_key, { reason: "subflow_stack_invalid", code: verdictError ? "rpc_failed" : (verdict?.reason ?? "unknown") });
          await endRun(db, activeRun.id, "failed", "subflow_stack_invalid");
          return { consumed: false, flow_run_id: activeRun.id, outcome: "no_match" };
        }
      }
      return handleReplyForActiveRun(db, activeRun, input.message, nodes);
    }

    // No active run → look for a flow whose entry trigger matches.
    const flow = await findEntryFlow(
      db,
      input.accountId,
      input.message,
      input.isFirstInboundMessage,
    );
    if (!flow || !flow.entry_node_id) {
      return { consumed: false, outcome: "no_match" };
    }
    const nodes = await loadAllNodes(db, flow.id);
    return startNewRun(db, flow, input, nodes);
  } catch (err) {
    console.error(
      "[flows] dispatchInboundToFlows threw:",
      err instanceof Error ? err.message : err,
    );
    return { consumed: false, outcome: "no_match" };
  }
}

async function handleReplyForActiveRun(
  db: AdminClient,
  run: FlowRunRow,
  message: ParsedInbound,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // Note: we intentionally do NOT persist the raw customer text. A
  // `collect_input` prompt that asks "what's your card number?" would
  // otherwise leave the PAN sitting in flow_run_events.payload forever,
  // visible to anyone with access to the runs viewer or the events
  // table. Length is enough for "did they actually reply?" debugging;
  // for the captured value itself, the `node_entered` event already
  // records `captured_key` + `captured_length` after the var is stored.
  const replyPayload = {
    meta_message_id: message.meta_message_id,
    reply_kind: message.kind,
    reply_id: message.kind === "interactive_reply" ? message.reply_id : null,
    text_length: message.kind === "text" ? message.text.length : null,
    // The marker the subflow reply policy (and the P7 history) rely on: a reply that arrived while the run was parked.
    ...(run.wait_until ? { during_wait: true } : {}),
  };
  if (run.wait_until) {
    // A spontaneous reply must be on record: later sends decide from it. If it cannot be recorded, fail closed (no follow-up);
    // the message itself is already in the Inbox and remains available to everything else.
    if (!(await logEventStrict(db, run.id, "reply_received", run.current_node_key, replyPayload))) {
      await logEvent(db, run.id, "error", run.current_node_key, { reason: "reply_not_recorded" });
      await endRun(db, run.id, "failed", "reply_not_recorded");
      return { consumed: false, flow_run_id: run.id, outcome: "no_match" };
    }
  } else {
    await logEvent(db, run.id, "reply_received", run.current_node_key, replyPayload);
  }

  // The run is parked on a durable wait. A reply is NOT an answer to anything: no reprompt, no handoff, no fallback
  // (which could exhaust and end the run). The message itself is already stored for the Inbox and the agents by the
  // webhook; here it is only recorded on the run. The flow does not claim the message (consumed: false), so other
  // automations treat it like any inbound.
  if (run.wait_until) {
    return { consumed: false, flow_run_id: run.id, outcome: "waiting" };
  }

  if (!run.current_node_key) {
    // Defensive — a run with status='active' but no current node is
    // malformed. Fail the run rather than spin.
    await endRun(db, run.id, "failed", "active_run_missing_current_node");
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: "no_match",
    };
  }

  const currentNode = nodes.get(run.current_node_key) ?? null;
  if (!currentNode) {
    await endRun(db, run.id, "failed", "current_node_not_found");
    return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
  }

  // Two ways a reply can advance:
  //   1. Interactive button/list tap on a send_buttons/send_list node.
  //   2. Text reply on a collect_input node — capture into vars.
  //
  // Everything else falls through to the fallback policy below.
  let matched: string | null = null;
  if (
    message.kind === "interactive_reply" &&
    (currentNode.node_type === "send_buttons" ||
      currentNode.node_type === "send_list")
  ) {
    matched = matchReplyId(currentNode, message.reply_id);
  } else if (
    message.kind === "text" &&
    currentNode.node_type === "collect_input"
  ) {
    const cfg = currentNode.config as unknown as CollectInputNodeConfig;
    const captured = message.text.trim();
    if (captured.length > 0 && cfg.var_key) {
      // Persist captured value + reset reprompt count atomically.
      const newVars = { ...run.vars, [cfg.var_key]: captured };
      const { error: capErr } = await db
        .from("flow_runs")
        .update({
          vars: newVars,
          reprompt_count: 0,
        })
        .eq("id", run.id);
      if (!capErr) {
        // Mirror the UPDATE in-memory so downstream interpolation in
        // the advance loop sees the captured var without us having to
        // re-SELECT the whole row.
        run.vars = newVars;
        run.reprompt_count = 0;
        await logEvent(db, run.id, "node_entered", currentNode.node_key, {
          captured_key: cfg.var_key,
          captured_length: captured.length,
        });
        matched = cfg.next_node_key;
      }
    }
  }

  if (matched) {
    // Reset reprompt count on a successful match. Skip the write when
    // already 0 — the collect_input capture branch above already
    // zeroed it, and interactive-reply matches against a fresh run
    // (post-prior-reset) are also already 0. The previous re-read of
    // the whole row was needed only because we weren't mirroring the
    // capture UPDATE into the in-memory `run`; now that we do, the
    // local copy is the source of truth.
    if (run.reprompt_count !== 0) {
      const { error } = await db
        .from("flow_runs")
        .update({ reprompt_count: 0 })
        .eq("id", run.id);
      if (!error) run.reprompt_count = 0;
    }
    const outcome = await advanceFromNodeKey(db, run, matched, nodes);
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: outcome.outcome,
    };
  }

  // No match → fallback. Apply the policy.
  const policy = resolveFallbackPolicy(
    (await loadFlow(db, run.flow_id))?.fallback_policy,
  );
  const newReprompts = run.reprompt_count + 1;
  await db
    .from("flow_runs")
    .update({ reprompt_count: newReprompts })
    .eq("id", run.id);

  const action = decideFallback({ policy, reprompt_count: newReprompts });
  await logEvent(db, run.id, "fallback_fired", run.current_node_key, {
    action: action.type,
    reprompt_count: newReprompts,
  });
  if (action.type === "ignore") {
    // Don't consume — let automations have a shot at it.
    return { consumed: false, flow_run_id: run.id, outcome: "no_match" };
  }
  if (action.type === "reprompt") {
    // Re-send the same prompt. Same node, no current_node_key change.
    if (currentNode.node_type === "send_buttons") {
      await sendButtonsAndSuspend(db, run, currentNode);
    } else if (currentNode.node_type === "send_list") {
      await sendListAndSuspend(db, run, currentNode);
    } else if (currentNode.node_type === "collect_input") {
      // Customer typed something we couldn't accept (empty after trim,
      // or var_key missing — rare). Re-send the prompt so they try again.
      const cfg = currentNode.config as unknown as CollectInputNodeConfig;
      try {
        await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
      } catch (err) {
        await logEvent(db, run.id, "error", currentNode.node_key, {
          reason: "reprompt_send_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { consumed: true, flow_run_id: run.id, outcome: "fallback_fired" };
  }
  if (action.type === "handoff") {
    if (run.conversation_id) {
      await db
        .from("conversations")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .eq("id", run.conversation_id);
    }
    await logEvent(db, run.id, "handoff", run.current_node_key, {
      reason: "fallback_exhausted",
    });
    await endRun(db, run.id, "handed_off", "fallback_exhausted");
    return { consumed: true, flow_run_id: run.id, outcome: "handed_off" };
  }
  // action.type === 'end'
  await endRun(db, run.id, "completed", "fallback_exhausted_end");
  return { consumed: true, flow_run_id: run.id, outcome: "completed" };
}

/**
 * The one shared "create + start" path for a flow_run, used by BOTH
 * the inbound auto-trigger (`startNewRun` below) and the manual Inbox
 * start action (`startFlowManually`). Everything that must never be
 * duplicated between those two entry points lives here: the
 * `vars.contact_name` seed, the INSERT (with its 23505 race handling),
 * the `started` audit event, the `execution_count` bump, and kicking
 * off `advanceFromNodeKey`.
 *
 * `startedEventPayloadExtra` is the only thing that differs between
 * callers — inbound logs `meta_message_id`, manual logs
 * `trigger_source`/`initiated_by_user_id` instead. Neither caller may
 * fabricate the other's fields.
 */
async function createAndStartFlowRun(
  db: AdminClient,
  flow: FlowRow,
  contactId: string,
  conversationId: string | null,
  nodes: Map<string, FlowNodeRow>,
  startedEventPayloadExtra: Record<string, unknown>,
): Promise<
  | { kind: "started"; run: FlowRunRow; advanceOutcome: string }
  | { kind: "duplicate_active_run" }
  | { kind: "insert_error"; message: string }
> {
  // Seed `vars.contact_name` so an authored flow can write
  // "Hola estimado {{vars.contact_name}} 🤗" without first asking the
  // customer for their name. Account-scoped (`flow.account_id`, the
  // SAME tenancy key the run itself is created under just below) —
  // required defense-in-depth: this runs under service_role, which
  // bypasses RLS, so a query scoped by contact id alone could read
  // another account's contact if `contactId` were ever wrong.
  // Never trusts anything from the inbound payload itself — the name
  // comes only from our own `contacts` table.
  const { data: contactRow } = await db
    .from("contacts")
    .select("name")
    .eq("id", contactId)
    .eq("account_id", flow.account_id)
    .maybeSingle();
  const contactName =
    (contactRow as { name?: string | null } | null)?.name?.trim() || "";

  // INSERT — partial unique index `idx_one_active_run_per_contact`
  // catches concurrent inserts with 23505. We catch and report it as
  // a controlled conflict, never a thrown 500.
  const { data: inserted, error: insErr } = await db
    .from("flow_runs")
    .insert({
      flow_id: flow.id,
      // Tenancy: NOT NULL post-017. The partial unique index
      // `idx_one_active_run_per_contact` is over (account_id,
      // contact_id) WHERE status='active', so two accounts sharing
      // a contact phone number each run their own flows independently.
      account_id: flow.account_id,
      // Audit: preserves the flow's author on the run row for log
      // attribution — NEVER the caller who dispatched/started it.
      user_id: flow.user_id,
      contact_id: contactId,
      conversation_id: conversationId,
      status: "active",
      current_node_key: flow.entry_node_id,
      // Only this one predefined var — collect_input's capture merges
      // (`{ ...run.vars, [var_key]: captured }`), so this survives
      // every later variable a flow captures.
      vars: { contact_name: contactName },
    })
    .select("*")
    .maybeSingle();
  if (insErr) {
    // 23505 = unique_violation → someone else already started a run
    // for this contact (a racing webhook, or a racing manual start).
    const msg = insErr.message ?? "";
    if (msg.includes("23505") || msg.includes("duplicate key")) {
      return { kind: "duplicate_active_run" };
    }
    console.error("[flows] createAndStartFlowRun insert error:", insErr.message);
    return { kind: "insert_error", message: insErr.message };
  }
  const run = inserted as FlowRunRow;
  await logEvent(db, run.id, "started", flow.entry_node_id, {
    flow_id: flow.id,
    trigger_type: flow.trigger_type,
    ...startedEventPayloadExtra,
  });
  // Bump the flow's execution counter — used by the builder UI to
  // surface "X runs since activation" on the flow card.
  //
  // Atomic RPC (migration 012) rather than read-modify-write: two
  // concurrent starts for different contacts on the same flow would
  // otherwise both read N and both write N+1, losing a count. Mirrors
  // the automations engine's use of
  // `increment_automation_execution_count` (migration 007).
  const { error: incErr } = await db.rpc("increment_flow_execution_count", {
    p_flow_id: flow.id,
  });
  if (incErr) {
    // Non-fatal — the run itself succeeded; only the counter is off.
    console.error("[flows] execution_count rpc error:", incErr.message);
  }

  // Run the advance loop starting from the entry node.
  const outcome = await advanceFromNodeKey(db, run, flow.entry_node_id!, nodes);
  return { kind: "started", run, advanceOutcome: outcome.outcome };
}

async function startNewRun(
  db: AdminClient,
  flow: FlowRow,
  input: DispatchInboundInput,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  const result = await createAndStartFlowRun(
    db,
    flow,
    input.contactId,
    input.conversationId,
    nodes,
    { meta_message_id: input.message.meta_message_id },
  );
  if (result.kind === "duplicate_active_run") {
    return { consumed: true, outcome: "duplicate_inbound_ignored" };
  }
  if (result.kind === "insert_error") {
    return { consumed: false, outcome: "no_match" };
  }
  return {
    consumed: true,
    flow_run_id: result.run.id,
    outcome:
      result.advanceOutcome === "advanced" ? "started" : (result.advanceOutcome as DispatchInboundResult["outcome"]),
  };
}

// ============================================================
// Manual start — "Iniciar Flow" from the Inbox. A human agent
// picked the flow explicitly, so there is no trigger to match: this
// bypasses `findEntryFlow` entirely and reuses `createAndStartFlowRun`
// for everything after the flow is resolved. Any `status=active`
// flow is eligible regardless of `trigger_type` (keyword/manual/
// first_inbound_message) — only `draft`/`archived` are rejected.
// ============================================================

export interface StartFlowManuallyArgs {
  accountId: string;
  initiatedByUserId: string;
  flowId: string;
  conversationId: string;
}

export type StartFlowManuallyResult =
  | { outcome: "started"; flow_run_id: string; flow_id: string; flow_name: string }
  // P1 bug #2 (docs/P1_DUPLICATE_CHATS_AUDIT.md) — the run WAS created
  // and DID execute (it's preserved for audit — see the flow_run_id),
  // but its first advance ended in `status='failed'` before ever
  // suspending. Deliberately narrow: only a genuine `failed` status
  // maps here. `completed` (an immediate `end` node), `handed_off`,
  // and `paused_by_agent` (e.g. a contact-blocked race) are all still
  // legitimate "started" outcomes — see startFlowManually below.
  | {
      outcome: "run_failed_immediately";
      flow_run_id: string;
      flow_id: string;
      flow_name: string;
    }
  | { outcome: "flow_not_found" }
  | { outcome: "flow_not_active" }
  | { outcome: "conversation_not_found" }
  | { outcome: "contact_not_found" }
  | { outcome: "contact_blocked" }
  | {
      outcome: "active_flow_exists";
      active_flow_run_id?: string;
      active_flow_id?: string;
      active_flow_name?: string;
    }
  | { outcome: "error"; message: string };

export async function startFlowManually(
  args: StartFlowManuallyArgs,
): Promise<StartFlowManuallyResult> {
  const { accountId, initiatedByUserId, flowId, conversationId } = args;
  const db = supabaseAdmin();

  // Flow — scoped by id AND account_id in the SAME query, so a
  // cross-account flow id and a genuinely-missing one are
  // indistinguishable from the caller's point of view (never reveal
  // cross-tenant existence).
  const { data: flowData, error: flowErr } = await db
    .from("flows")
    .select("*")
    .eq("id", flowId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (flowErr) {
    console.error("[flows] startFlowManually flow lookup error:", flowErr.message);
    return { outcome: "error", message: flowErr.message };
  }
  if (!flowData) {
    return { outcome: "flow_not_found" };
  }
  const flow = flowData as FlowRow;
  if (flow.status !== "active" || !flow.entry_node_id) {
    return { outcome: "flow_not_active" };
  }

  // Conversation — same account-scoping discipline. `contact_id` is
  // derived from here server-side; the caller never gets to supply a
  // contact id directly.
  const { data: conversationData, error: convErr } = await db
    .from("conversations")
    .select("id, contact_id, account_id")
    .eq("id", conversationId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (convErr) {
    console.error("[flows] startFlowManually conversation lookup error:", convErr.message);
    return { outcome: "error", message: convErr.message };
  }
  const conversation = conversationData as
    | { id: string; contact_id: string | null; account_id: string }
    | null;
  if (!conversation || !conversation.contact_id) {
    return { outcome: "conversation_not_found" };
  }

  // Contact — confirm it too belongs to this account (defense-in-depth
  // against a stale/forged conversation row), never trust the id alone.
  const { data: contactData, error: contactErr } = await db
    .from("contacts")
    .select("id, blocked")
    .eq("id", conversation.contact_id)
    .eq("account_id", accountId)
    .maybeSingle();
  if (contactErr) {
    console.error("[flows] startFlowManually contact lookup error:", contactErr.message);
    return { outcome: "error", message: contactErr.message };
  }
  if (!contactData) {
    return { outcome: "contact_not_found" };
  }
  const typedContact = contactData as { id: string; blocked: boolean };
  // A blocked contact must never get a Flow started for them manually,
  // even from a stale Inbox tab that still shows the picker.
  if (typedContact.blocked) {
    return { outcome: "contact_blocked" };
  }
  const contactId = typedContact.id;

  // Never auto-replace an active run. Pre-check gives a clean,
  // informative conflict in the common case; the DB's partial unique
  // index (checked again below via 23505) is the last line of defense
  // against a genuine race.
  const existingActive = await loadActiveRunForContact(db, accountId, contactId);
  if (existingActive) {
    const activeFlow = await loadFlow(db, existingActive.flow_id);
    return {
      outcome: "active_flow_exists",
      active_flow_run_id: existingActive.id,
      active_flow_id: existingActive.flow_id,
      active_flow_name: activeFlow?.name,
    };
  }

  const nodes = await loadAllNodes(db, flow.id);
  const result = await createAndStartFlowRun(
    db,
    flow,
    contactId,
    conversationId,
    nodes,
    { trigger_source: "manual", initiated_by_user_id: initiatedByUserId },
  );

  if (result.kind === "duplicate_active_run") {
    // Lost the race despite the pre-check — recover conflict details
    // best-effort so the caller still gets a useful message.
    const raced = await loadActiveRunForContact(db, accountId, contactId);
    const racedFlow = raced ? await loadFlow(db, raced.flow_id) : null;
    return {
      outcome: "active_flow_exists",
      active_flow_run_id: raced?.id,
      active_flow_id: raced?.flow_id,
      active_flow_name: racedFlow?.name,
    };
  }
  if (result.kind === "insert_error") {
    return { outcome: "error", message: result.message };
  }

  // P1 bug #2 — `createAndStartFlowRun` already ran the run's first
  // advance (inside `result`'s creation) and, on any terminal failure,
  // already persisted `status='failed'` via `endRun()`. That is the
  // authoritative truth this function is missing entirely below if we
  // don't check it: `result.kind === "started"` only means "a row was
  // inserted", not "it's still going" or "it went well".
  //
  // Deliberately a SEPARATE read here, scoped to `startFlowManually`
  // only — `createAndStartFlowRun` itself, `startNewRun`, and
  // `dispatchInboundToFlows` (the automatic-trigger path) are
  // untouched and pay no extra query for this. The manual-start route
  // is the only caller that turns this into a synchronous HTTP
  // response a human is watching, so it's the only one that needs to
  // know.
  const { data: finalRunData, error: finalRunErr } = await db
    .from("flow_runs")
    .select("status, end_reason")
    .eq("id", result.run.id)
    .eq("account_id", accountId)
    .maybeSingle();
  if (finalRunErr) {
    console.error("[flows] startFlowManually final-status lookup error:", finalRunErr.message);
    return { outcome: "error", message: finalRunErr.message };
  }
  // Fail closed: `maybeSingle()` can also resolve with `data: null` and
  // `error: null` (zero rows matched) — a row we just inserted (and can
  // see via `result.run`) failing to be found by its own id here would
  // be an inconsistency worth surfacing loudly, NEVER a silent "so it
  // must not be failed, report started". This should not happen in
  // practice (service-role client, no delete path for flow_runs), but
  // this function decides whether a human sees a false success — it
  // must never assume "not failed" from an absence of data.
  if (!finalRunData) {
    console.error(
      "[flows] startFlowManually final-status lookup found no row for a run that was just created",
      { flow_run_id: result.run.id, account_id: accountId },
    );
    return { outcome: "error", message: "Flow run not found immediately after creation" };
  }
  const finalRun = finalRunData as { status: string; end_reason: string | null };
  if (finalRun.status === "failed") {
    // Logged server-side only — never returned to the caller (may
    // contain a raw exception message, a Meta API error, or other
    // internal detail; see advanceFromNodeKey's error branches).
    console.error("[flows] manual start failed immediately:", {
      flow_run_id: result.run.id,
      flow_id: flow.id,
      end_reason: finalRun.end_reason,
    });
    return {
      outcome: "run_failed_immediately",
      flow_run_id: result.run.id,
      flow_id: flow.id,
      flow_name: flow.name,
    };
  }

  // Any other status — completed (immediate `end` node), handed_off,
  // paused_by_agent (e.g. a contact-blocked race), or still active
  // (suspended waiting for a reply) — is a legitimate "started" result.
  return {
    outcome: "started",
    flow_run_id: result.run.id,
    flow_id: flow.id,
    flow_name: flow.name,
  };
}

// ============================================================
// Durable waits: resumption (called by /api/flows/waits/cron).
//
// Four distinct steps, each with its own failure behaviour (see qa/durable-wait/DESIGN.md):
//   1. CLAIM    claim_due_flow_waits: one worker gets the run (lease + token). A crash here leaves the wait intact: the
//               lease expires and another worker claims it. Nothing is lost, nothing is duplicated.
//   2. CONSUME  consume_flow_wait: the token holder ends the wait and moves the run to the next node in ONE statement.
//               From here on the wait can never be resumed again.
//   3. ADVANCE  advanceFromNodeKey: walks the following nodes in memory (the legacy engine only persists progress when
//               it suspends). A crash between 2 and the first send LOSES the follow-up (the run is stranded at the next
//               node until the stale-run sweep ends it); it can never duplicate it.
//   4. EFFECTS  each send is a Meta call followed by an event row. A crash after Meta accepted a message but before the
//               loop finished cannot be recovered without a duplicate, exactly as for any legacy multi-node advance.
// Execution therefore stays disabled per account until these windows are accepted (FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS).
// ============================================================

export interface ResumeWaitsSummary {
  claimed: number;
  resumed: number;
  /** Claimed but not resumed because the run was cancelled / the flow is no longer usable (the run was ended or left alone). */
  skipped: number;
  /** Lost the race at consume time (another worker or a cancellation got there first). */
  lost: number;
  failed: number;
  /** True when the time budget ended the pass early; the rest is picked up by the next pass. */
  budgetExhausted: boolean;
}

export async function resumeDueFlowWaits(options: {
  accountIds: string[];
  limit?: number;
  leaseSeconds?: number;
  /** Stop starting new resumptions after this many milliseconds (default 45 000). */
  budgetMs?: number;
  db?: AdminClient;
}): Promise<ResumeWaitsSummary> {
  const db = options.db ?? supabaseAdmin();
  const summary: ResumeWaitsSummary = { claimed: 0, resumed: 0, skipped: 0, lost: 0, failed: 0, budgetExhausted: false };
  if (options.accountIds.length === 0) return summary;
  const started = Date.now();
  const { data, error } = await db.rpc("claim_due_flow_waits", {
    p_account_ids: options.accountIds,
    p_limit: options.limit ?? 25,
    p_lease_seconds: options.leaseSeconds ?? 300,
  });
  if (error) throw new Error(`claim_due_flow_waits failed: ${error.message}`);
  const claims = (data ?? []) as Array<{ run_id: string; account_id: string; flow_id: string; node_key: string; claim_token: string; due_at: string }>;
  summary.claimed = claims.length;
  for (const claim of claims) {
    if (Date.now() - started > (options.budgetMs ?? 45_000)) {
      // Unprocessed claims simply keep their lease; they are re-claimed after it expires (<= leaseSeconds).
      summary.budgetExhausted = true;
      break;
    }
    try {
      const outcome = await resumeOneWait(db, claim);
      summary[outcome] += 1;
    } catch (err) {
      summary.failed += 1;
      console.error("[flows] durable wait resume threw:", err instanceof Error ? err.message : err);
    }
  }
  return summary;
}

async function resumeOneWait(
  db: AdminClient,
  claim: { run_id: string; account_id: string; flow_id: string; node_key: string; claim_token: string; due_at: string },
): Promise<"resumed" | "skipped" | "lost" | "failed"> {
  const { data: runRow } = await db.from("flow_runs").select("*").eq("id", claim.run_id).eq("account_id", claim.account_id).maybeSingle();
  const run = runRow as FlowRunRow | null;
  // Cancelled (agent, block, sweep, deleted flow) or taken over by another worker since the claim: leave it alone.
  if (!run || run.status !== "active" || run.wait_claim_token !== claim.claim_token) return "lost";

  const flow = await loadFlow(db, run.flow_id);
  if (!flow || flow.status !== "active" || flow.account_id !== run.account_id) {
    // The flow was paused / archived / deleted while the customer waited: do not send on its behalf.
    await logEvent(db, run.id, "error", claim.node_key, { reason: "flow_not_active_at_resume" });
    await endRun(db, run.id, "failed", "flow_not_active_at_resume");
    return "skipped";
  }
  if (run.current_flow_id) {
    // Parked inside a called flow: every flow of the stack must still be the one the call pinned, or nothing continues.
    const { data: verdictData, error: verdictError } = await db.rpc("verify_flow_run_stack", { p_account_id: run.account_id, p_run_id: run.id });
    const verdict = verdictData as { ok?: boolean; reason?: string } | null;
    if (verdictError || !verdict?.ok) {
      await logEvent(db, run.id, "error", claim.node_key, { reason: "subflow_stack_invalid", code: verdictError ? "rpc_failed" : (verdict?.reason ?? "unknown") });
      await endRun(db, run.id, "failed", "subflow_stack_invalid");
      return "skipped";
    }
  }
  const nodes = await loadAllNodes(db, currentFlowIdOf(run));
  const waitNode = nodes.get(claim.node_key);
  const cfg = waitNode?.config as unknown as DelayNodeConfig | undefined;
  const next = cfg?.next_node_key;
  if (!waitNode || waitNode.node_type !== "delay" || !isDurableWaitConfig(cfg) || !next || !nodes.has(next)) {
    await logEvent(db, run.id, "error", claim.node_key, { reason: "wait_node_invalid_at_resume" });
    await endRun(db, run.id, "failed", "wait_node_invalid_at_resume");
    return "skipped";
  }

  // CONSUME: from this point the wait cannot be resumed again by anyone.
  const { data: consumed, error: consumeError } = await db.rpc("consume_flow_wait", {
    p_account_id: run.account_id,
    p_run_id: run.id,
    p_claim_token: claim.claim_token,
    p_next_node_key: next,
  });
  if (consumeError) throw new Error(`consume_flow_wait failed: ${consumeError.message}`);
  if (consumed !== true) return "lost";

  await logEvent(db, run.id, "node_entered", claim.node_key, {
    node_type: "delay",
    reason: "wait_resumed",
    due_at: claim.due_at,
    late_ms: Math.max(0, Date.now() - new Date(claim.due_at).getTime()),
  });
  const advancing: FlowRunRow = { ...run, current_node_key: next, wait_until: null, wait_node_key: null, wait_claim_token: null, wait_claimed_at: null };
  try {
    await advanceFromNodeKey(db, advancing, next, nodes);
  } catch (err) {
    await logEvent(db, run.id, "error", next, { reason: "resume_advance_failed", detail: err instanceof Error ? err.message : String(err) });
    await endRun(db, run.id, "failed", "resume_advance_failed");
    return "failed";
  }
  return "resumed";
}

// ============================================================
// Recovery of stranded runs (P8). Conservative on purpose: what the engine has in memory when a process dies is lost, so a
// stranded run is only RESUMED when the event log proves that nothing was sent after the last persisted cursor. Any send whose
// outcome is unknown is NEVER repeated: the run is ended and the incident is on record.
// ============================================================

export interface RecoverySummary { examined: number; resumed: number; ambiguous: number; unsafe: number; skipped: number; failed: number }

type EvidenceRow = { event_type: string; node_key: string | null; payload: Record<string, unknown>; created_at: string };

/** Pure decision, exported for tests. `events` are the run's events NEWER than its last persisted cursor, oldest first. */
export function classifyStrandedRun(events: EvidenceRow[]): { kind: "recoverable" } | { kind: "ambiguous"; nodeKey: string | null } | { kind: "unsafe" } {
  let pendingIntent: EvidenceRow | null = null;
  let sentAfterCursor = false;
  for (const e of events) {
    if (e.event_type === "node_entered" && e.payload?.reason === "send_intent") pendingIntent = e;
    else if (e.event_type === "message_sent") { sentAfterCursor = true; pendingIntent = null; }
  }
  if (pendingIntent) return { kind: "ambiguous", nodeKey: pendingIntent.node_key };   // an intent without its confirmation: the message may or may not have left
  if (sentAfterCursor) return { kind: "unsafe" };                                    // the run progressed in memory after the cursor and sent something: cannot replay safely
  return { kind: "recoverable" };
}

export async function recoverStrandedRuns(options: { accountIds: string[]; minAgeSeconds?: number; limit?: number; db?: AdminClient }): Promise<RecoverySummary> {
  const db = options.db ?? supabaseAdmin();
  const summary: RecoverySummary = { examined: 0, resumed: 0, ambiguous: 0, unsafe: 0, skipped: 0, failed: 0 };
  if (options.accountIds.length === 0) return summary;
  const cutoff = new Date(Date.now() - (options.minAgeSeconds ?? 300) * 1000).toISOString();
  const { data, error } = await db
    .from("flow_runs").select("*").eq("status", "active").is("wait_until", null).lt("last_advanced_at", cutoff).in("account_id", options.accountIds)
    .order("last_advanced_at", { ascending: true }).limit(options.limit ?? 25);
  if (error) throw new Error(`stranded run lookup failed: ${error.message}`);
  for (const row of (data ?? []) as FlowRunRow[]) {
    try {
      const outcome = await recoverOneStrandedRun(db, row);
      summary.examined += outcome === "skipped" ? 0 : 1;
      summary[outcome] += 1;
    } catch (err) {
      summary.failed += 1;
      console.error("[flows] stranded run recovery threw:", err instanceof Error ? err.message : err);
    }
  }
  return summary;
}

async function recoverOneStrandedRun(db: AdminClient, run: FlowRunRow): Promise<"resumed" | "ambiguous" | "unsafe" | "skipped" | "failed"> {
  if (!run.current_node_key) return "skipped";
  const flowId = currentFlowIdOf(run);
  const nodes = await loadAllNodes(db, flowId);
  const node = nodes.get(run.current_node_key);
  // Runs that legitimately wait for the customer (buttons, lists, collect_input) are not stranded, however long they have been quiet.
  if (!node || !isAutoAdvancing(node.node_type) || (node.node_type === "delay" && isDurableWaitConfig(node.config))) return "skipped";
  const { data: events, error } = await db
    .from("flow_run_events").select("event_type, node_key, payload, created_at").eq("flow_run_id", run.id).gt("created_at", run.last_advanced_at).order("created_at", { ascending: true }).order("id", { ascending: true });
  if (error) throw new Error("recovery_evidence_lookup_failed");
  const verdict = classifyStrandedRun((events ?? []) as EvidenceRow[]);
  if (verdict.kind === "ambiguous") {
    await logEvent(db, run.id, "error", verdict.nodeKey, { reason: "send_outcome_unknown", detail: "intent recorded, no confirmation; NOT resent" });
    await endRun(db, run.id, "failed", "send_outcome_unknown");
    return "ambiguous";
  }
  if (verdict.kind === "unsafe") {
    await logEvent(db, run.id, "error", run.current_node_key, { reason: "recovery_not_safe", detail: "progress after the last cursor included a send; not replayed" });
    await endRun(db, run.id, "failed", "recovery_not_safe");
    return "unsafe";
  }
  // Take the run: only one recovery worker can move the cursor timestamp it just read.
  const { data: taken, error: takeError } = await db
    .from("flow_runs").update({ last_advanced_at: new Date().toISOString() }).eq("id", run.id).eq("account_id", run.account_id).eq("status", "active").eq("last_advanced_at", run.last_advanced_at).is("wait_until", null).select("id");
  if (takeError || !taken || taken.length === 0) return "skipped";
  const flow = await loadFlow(db, run.flow_id);
  if (!flow || flow.status !== "active" || flow.account_id !== run.account_id) {
    await logEvent(db, run.id, "error", run.current_node_key, { reason: "flow_not_active_at_recovery" });
    await endRun(db, run.id, "failed", "flow_not_active_at_recovery");
    return "failed";
  }
  if (run.current_flow_id) {
    const { data: verdictData, error: verdictError } = await db.rpc("verify_flow_run_stack", { p_account_id: run.account_id, p_run_id: run.id });
    const stack = verdictData as { ok?: boolean; reason?: string } | null;
    if (verdictError || !stack?.ok) {
      await logEvent(db, run.id, "error", run.current_node_key, { reason: "subflow_stack_invalid", code: verdictError ? "rpc_failed" : (stack?.reason ?? "unknown") });
      await endRun(db, run.id, "failed", "subflow_stack_invalid");
      return "failed";
    }
  }
  await logEvent(db, run.id, "node_entered", run.current_node_key, { reason: "stranded_run_resumed" });
  try {
    await advanceFromNodeKey(db, run, run.current_node_key, nodes);
  } catch (err) {
    await logEvent(db, run.id, "error", run.current_node_key, { reason: "recovery_advance_failed", detail: err instanceof Error ? err.message : String(err) });
    await endRun(db, run.id, "failed", "recovery_advance_failed");
    return "failed";
  }
  return "resumed";
}
