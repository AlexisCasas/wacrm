/**
 * A thread is considered "at the bottom" while it is within this many pixels
 * of the latest message. Keeping the tolerance here (rather than scattered
 * through event handlers) makes the follow/preserve decision consistent for
 * new rows and delayed media layout.
 */
export const MESSAGE_SCROLL_BOTTOM_THRESHOLD_PX = 120;

export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

/**
 * The single measure used by the thread to decide whether it may follow new
 * content. Browsers can briefly report a negative value while clamping a
 * scroll position after content shrinks, which is still visually at bottom.
 */
export function distanceFromBottom({
  scrollHeight,
  scrollTop,
  clientHeight,
}: ScrollMetrics): number {
  return Math.max(0, scrollHeight - scrollTop - clientHeight);
}

export function isNearBottom(metrics: ScrollMetrics): boolean {
  return distanceFromBottom(metrics) <= MESSAGE_SCROLL_BOTTOM_THRESHOLD_PX;
}

export function shouldFollowLatest({
  hasNewMessage,
  wasNearBottom,
  isOwnOptimisticSend = false,
}: {
  hasNewMessage: boolean;
  wasNearBottom: boolean;
  isOwnOptimisticSend?: boolean;
}): boolean {
  return isOwnOptimisticSend || (hasNewMessage && wasNearBottom);
}

/**
 * Realtime persists an optimistic outgoing message under a new database id.
 * Its id alone therefore cannot tell a new inbound row from confirmation of
 * an already-visible bubble. The send paths create these stable message
 * fields before the request, and the persisted row carries the same payload.
 */
export function isOptimisticMessageReplacement(
  previousMessages: Message[],
  nextMessage: Message,
): boolean {
  return previousMessages.some((previousMessage) =>
    previousMessage.id.startsWith("temp-") &&
    previousMessage.sender_type === "agent" &&
    nextMessage.sender_type === "agent" &&
    previousMessage.conversation_id === nextMessage.conversation_id &&
    previousMessage.content_type === nextMessage.content_type &&
    previousMessage.content_text === nextMessage.content_text &&
    previousMessage.media_url === nextMessage.media_url &&
    previousMessage.template_name === nextMessage.template_name &&
    previousMessage.reply_to_message_id === nextMessage.reply_to_message_id,
  );
}
import type { Message } from "@/types";
