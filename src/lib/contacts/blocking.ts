/**
 * Shared "can this contact receive a message right now?" guard.
 *
 * Internal (WACRM-side) contact blocking — migration 044 — NOT
 * WhatsApp/Meta's native block. Flow sends (`@/lib/flows/meta-send`),
 * Automation sends (delegating to the same Flow senders, plus its own
 * template sender), and AI replies (`@/lib/ai/send`, which also
 * delegates to the Flow text sender) all share this single check so
 * there is exactly one place that decides "blocked contacts never
 * receive outbound" — see each call site's own comment for why the
 * check has to run before that function's transport branch (Meta vs
 * the temporary ManyChat bridge), not after.
 *
 * Manual sends (`@/lib/whatsapp/send-message.ts`) do NOT use this
 * helper — that function already loads the contact row alongside the
 * conversation in one query, so it checks `blocked` inline rather than
 * paying for a second round trip here.
 */

/** Minimal shape every caller's Supabase client (RLS-scoped or
 *  service-role) satisfies — avoids importing a concrete client type
 *  into a module used from both `flows` and `automations`. */
interface MinimalClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: string) => any;
  /** Optional: only the order-stop fence below needs it (real Supabase clients always have it). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc?: (fn: string, args: Record<string, unknown>) => any;
}

export class ContactBlockedError extends Error {
  readonly code = "contact_blocked";
  constructor(message = "This contact is blocked and cannot receive messages.") {
    super(message);
    this.name = "ContactBlockedError";
  }
}

/**
 * An AUTOMATIC send (Flow / Automation / Audio Guide) belongs to an execution that started before the contact's order_stop_at ("Confirmar
 * pedido", migration 20261120000000): it must not go out. Extends ContactBlockedError so every existing "contact cannot receive" handler
 * stops the execution without sending; `code` tells them apart for the audit trail. Never thrown for manual sends.
 */
export class AutomatedSendStoppedError extends ContactBlockedError {
  readonly orderStop = true;
  constructor() {
    super("This automatic execution was stopped because an order was confirmed for the contact.");
    this.name = "AutomatedSendStoppedError";
    (this as { code: string }).code = "order_confirmed";
  }
}

/** Which automatic execution is sending. Absent (manual-style callers, AI replies) = no order-stop fence. */
export interface AutomatedSendOrigin {
  flowRunId?: string | null;
  automationLogId?: string | null;
  /** AI auto-reply: ISO time at which the AI activity (the dispatch generating/sending the reply) started. */
  aiActivityStartedAt?: string | null;
}

/**
 * The order-stop fence for ONE execution: true when that run/log started at or before the contact's order_stop_at. Reused by the sender
 * guard below and by the Audio Guide sequencer's halt check. A database without the functions yet (migration not applied) means "not stopped";
 * any other error fails CLOSED (the caller treats it as a failed send).
 */
export async function isExecutionStoppedByOrder(
  db: MinimalClient,
  accountId: string,
  contactId: string,
  origin: AutomatedSendOrigin,
): Promise<boolean> {
  if (typeof db.rpc !== "function") return false;
  const calls: Array<[string, Record<string, unknown>]> = [];
  if (origin.flowRunId) calls.push(["flow_run_stopped_by_order", { p_account: accountId, p_contact: contactId, p_run: origin.flowRunId }]);
  if (origin.automationLogId) calls.push(["automation_run_stopped_by_order", { p_account: accountId, p_contact: contactId, p_log: origin.automationLogId }]);
  if (origin.aiActivityStartedAt) calls.push(["ai_reply_stopped_by_order", { p_account: accountId, p_contact: contactId, p_since: origin.aiActivityStartedAt }]);
  for (const [fn, args] of calls) {
    const { data, error } = await db.rpc(fn, args);
    if (error) {
      if (error.code === "42883" || error.code === "PGRST202") continue;
      throw new Error(`[contacts] failed to verify order-stop fence: ${error.message ?? error.code}`);
    }
    if (data === true) return true;
  }
  return false;
}

/**
 * Throws `ContactBlockedError` if the contact is blocked. Resolves
 * silently (never throws "not found") when the contact doesn't exist
 * for this account or the lookup itself errors — the caller's own
 * existing contact/phone lookup (for wherever this is called from)
 * already owns surfacing that failure with its established message;
 * duplicating it here would just produce a second, differently-worded
 * error for the same condition.
 */
export async function assertContactCanReceive(
  db: MinimalClient,
  accountId: string,
  contactId: string,
  origin?: AutomatedSendOrigin,
): Promise<void> {
  const { data, error } = await db
    .from("contacts")
    .select("blocked")
    .eq("id", contactId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) {
    throw new Error(`[contacts] failed to verify contact block status: ${error.message}`);
  }
  if ((data as { blocked?: boolean } | null)?.blocked) {
    throw new ContactBlockedError();
  }
  // "Confirmar pedido" fence, evaluated at the last moment before the transport (this guard runs before any provider call).
  if (origin && (origin.flowRunId || origin.automationLogId || origin.aiActivityStartedAt) && (await isExecutionStoppedByOrder(db, accountId, contactId, origin))) {
    throw new AutomatedSendStoppedError();
  }
}
