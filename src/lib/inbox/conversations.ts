import type { Conversation, Contact, Tag } from "@/types";

/**
 * Conversation select that embeds the contact plus its tags, so the Inbox
 * can filter conversations by contact tag without a second round-trip.
 * `contact_tags(tags(*))` returns the join rows; {@link normalizeConversation}
 * flattens them onto `contact.tags`.
 */
export const CONVERSATION_SELECT =
  "*, contact:contacts(*, contact_tags(tags(*)))";

/**
 * Same embed as {@link CONVERSATION_SELECT}, but requires (`!inner`)
 * the contact join so a query can add `.eq("contact.blocked", false)`
 * and exclude a blocked contact's conversation at the query layer —
 * it never reaches the client at all, rather than being fetched and
 * then hidden with `array.filter(...)`. `conversations.contact_id` is
 * `NOT NULL` (migration 001), so the inner join never drops a
 * legitimate row for an unrelated reason.
 *
 * Used by the normal Inbox list load and its realtime self-heal
 * (hydrateConversation) — NOT by the public v1 API, which has no
 * "hide blocked contacts" requirement of its own.
 */
export const INBOX_CONVERSATION_SELECT =
  "*, contact:contacts!inner(*, contact_tags(tags(*)))";

/** Raw shape returned by {@link CONVERSATION_SELECT} before flattening. */
type RawContact = Contact & { contact_tags?: { tags: Tag | null }[] };
type RawConversation = Omit<Conversation, "contact"> & {
  contact?: RawContact | null;
};

/**
 * Flatten the embedded `contact_tags(tags(*))` join into `contact.tags`.
 * Safe to call on rows fetched with {@link CONVERSATION_SELECT}; a row with
 * no contact (e.g. a freshly-inserted conversation) passes through untouched.
 */
export function normalizeConversation(raw: RawConversation): Conversation {
  const rawContact = raw.contact;
  if (!rawContact) return raw as Conversation;

  const { contact_tags, ...contact } = rawContact;
  return {
    ...raw,
    contact: {
      ...contact,
      tags: (contact_tags ?? [])
        .map((ct) => ct.tags)
        .filter((t): t is Tag => t != null),
    },
  };
}

export function normalizeConversations(
  rows: RawConversation[],
): Conversation[] {
  return rows.map(normalizeConversation);
}

/**
 * A conversation "needs human attention" only when the bot is paused
 * AND left an actual handoff note — never for a bare manual pause
 * (`ai_autoreply_disabled` with no summary, e.g. an agent just took
 * over via "Take over"). That distinction is what keeps this indicator
 * meaningful: it means "the bot stopped because it needed a human",
 * not "a human happens to be looking at this thread already".
 */
export function needsHumanAttention(
  conversation: Pick<Conversation, 'ai_autoreply_disabled' | 'ai_handoff_summary'>,
): boolean {
  return (
    conversation.ai_autoreply_disabled === true &&
    !!conversation.ai_handoff_summary?.trim()
  )
}

export interface ContactFilters {
  /** Tag ids; a conversation matches if its contact has ANY of them (OR). */
  tagIds: string[];
  /** Exact company match, or null for no company filter. */
  company: string | null;
}

/**
 * Whether a conversation passes the contact-based Inbox filters (issue #272).
 * Empty `tagIds` and null `company` are no-ops, so the default (no filters)
 * always matches. Tags use OR logic, consistent with Broadcast audiences.
 */
export function matchesContactFilters(
  conversation: Conversation,
  { tagIds, company }: ContactFilters,
): boolean {
  if (tagIds.length > 0) {
    const contactTagIds = conversation.contact?.tags ?? [];
    if (!contactTagIds.some((t) => tagIds.includes(t.id))) return false;
  }

  if (company !== null && conversation.contact?.company?.trim() !== company) {
    return false;
  }

  return true;
}
