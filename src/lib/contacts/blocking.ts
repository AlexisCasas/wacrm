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
}

export class ContactBlockedError extends Error {
  readonly code = "contact_blocked";
  constructor(message = "This contact is blocked and cannot receive messages.") {
    super(message);
    this.name = "ContactBlockedError";
  }
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
}
