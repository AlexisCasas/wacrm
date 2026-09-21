import type { Conversation, Message } from '@/types';

export type ConversationActivitySnapshot = Pick<
  Conversation,
  'last_message_at' | 'last_message_text'
>;

/**
 * Returns a stable, human-readable preview for a message. Media without a
 * caption deliberately keeps its type marker instead of erasing the current
 * list preview while the conversation row's realtime UPDATE catches up.
 */
export function getMessagePreview(
  message: Pick<Message, 'content_text' | 'content_type'>
): string {
  return message.content_text?.trim() || `[${message.content_type}]`;
}

function timestampValue(timestamp: string | undefined): number | null {
  if (!timestamp) return null;
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : null;
}

/** Returns the activity-only fields that optimistic rollback may restore. */
export function getConversationActivitySnapshot(
  conversation: Conversation
): ConversationActivitySnapshot {
  return {
    last_message_at: conversation.last_message_at,
    last_message_text: conversation.last_message_text,
  };
}

/**
 * Keeps the newest valid activity snapshot. It is used by the page's
 * synchronous event mirror so an optimistic send cannot snapshot activity
 * that a queued React render has not committed yet.
 */
export function mergeConversationActivitySnapshot(
  current: ConversationActivitySnapshot | undefined,
  incoming: ConversationActivitySnapshot
): ConversationActivitySnapshot {
  const currentAt = timestampValue(current?.last_message_at);
  const incomingAt = timestampValue(incoming.last_message_at);
  if (incomingAt !== null && (currentAt === null || incomingAt >= currentAt)) {
    return incoming;
  }
  return current ?? incoming;
}

export function getMessageActivitySnapshot(
  message: Pick<Message, 'content_text' | 'content_type' | 'created_at'>
): ConversationActivitySnapshot {
  return {
    last_message_at: message.created_at,
    last_message_text: getMessagePreview(message),
  };
}

function compareTimestampsDesc(
  left: string | undefined,
  right: string | undefined
): number {
  const leftValue = timestampValue(left);
  const rightValue = timestampValue(right);

  // Null and malformed activity timestamps are deliberately treated as "no
  // activity", so they remain below every valid last_message_at value.
  if (leftValue === null && rightValue === null) return 0;
  if (leftValue === null) return 1;
  if (rightValue === null) return -1;
  return rightValue - leftValue;
}

/**
 * Produces the canonical Inbox ordering without mutating React state. A
 * valid last_message_at wins; created_at then the UUID string make ties
 * deterministic for legacy rows and equal timestamps.
 */
export function sortConversationsByActivity<T extends Conversation>(
  conversations: readonly T[]
): T[] {
  return [...conversations].sort((left, right) => {
    const activityOrder = compareTimestampsDesc(
      left.last_message_at,
      right.last_message_at
    );
    if (activityOrder !== 0) return activityOrder;

    const createdOrder = compareTimestampsDesc(
      left.created_at,
      right.created_at
    );
    if (createdOrder !== 0) return createdOrder;

    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/**
 * Applies one message event to a loaded conversation and restores canonical
 * ordering. Older/out-of-order message events still leave unread accounting
 * intact, but cannot replace a newer preview or move a conversation back.
 */
export function applyMessageActivity(
  conversations: readonly Conversation[],
  message: Pick<
    Message,
    'conversation_id' | 'content_text' | 'content_type' | 'created_at'
  >,
  options: { incrementUnread?: boolean } = {}
): Conversation[] {
  const messageAt = timestampValue(message.created_at);

  return sortConversationsByActivity(
    conversations.map((conversation) => {
      if (conversation.id !== message.conversation_id) return conversation;

      const currentAt = timestampValue(conversation.last_message_at);
      const isNewestActivity =
        messageAt !== null && (currentAt === null || messageAt >= currentAt);

      return {
        ...conversation,
        ...(isNewestActivity
          ? {
              last_message_at: message.created_at,
              last_message_text: getMessagePreview(message),
            }
          : {}),
        ...(options.incrementUnread
          ? { unread_count: conversation.unread_count + 1 }
          : {}),
      };
    })
  );
}

/**
 * Reverts an optimistic list update only while it is still the displayed
 * activity. A realtime confirmation or a newer inbound message makes this a
 * no-op, so a failed request can never restore stale conversation activity.
 */
export function rollbackOptimisticMessageActivity(
  conversations: Conversation[],
  optimisticMessage: Pick<
    Message,
    'conversation_id' | 'content_text' | 'content_type' | 'created_at'
  >,
  snapshot: ConversationActivitySnapshot | undefined
): Conversation[] {
  if (!snapshot) return conversations;

  const current = conversations.find(
    (conversation) => conversation.id === optimisticMessage.conversation_id
  );
  if (
    !current ||
    current.last_message_at !== optimisticMessage.created_at ||
    current.last_message_text !== getMessagePreview(optimisticMessage)
  ) {
    return conversations;
  }

  return sortConversationsByActivity(
    conversations.map((conversation) =>
      conversation.id === optimisticMessage.conversation_id
        ? {
            ...conversation,
            last_message_at: snapshot.last_message_at,
            last_message_text: snapshot.last_message_text,
          }
        : conversation
    )
  );
}

/**
 * Merges a realtime conversation row without allowing an older snapshot to
 * undo an optimistic or message-INSERT activity update. Non-message fields
 * (status, assignment, tags, read receipts, etc.) are retained as supplied.
 */
export function mergeConversationUpdate(
  current: Conversation,
  incoming: Conversation
): Conversation {
  const currentAt = timestampValue(current.last_message_at);
  const incomingAt = timestampValue(incoming.last_message_at);
  const incomingHasNewestActivity =
    incomingAt !== null && (currentAt === null || incomingAt >= currentAt);

  if (incomingHasNewestActivity) return { ...current, ...incoming };

  return {
    ...current,
    ...incoming,
    last_message_at: current.last_message_at,
    last_message_text: current.last_message_text,
  };
}
