import { describe, expect, it } from "vitest";

import {
  distanceFromBottom,
  isNearBottom,
  isOptimisticMessageReplacement,
  MESSAGE_SCROLL_BOTTOM_THRESHOLD_PX,
  shouldFollowLatest,
} from "./message-scroll";
import type { Message } from "@/types";

function message(overrides: Partial<Message>): Message {
  return {
    id: "message",
    conversation_id: "conversation",
    sender_type: "customer",
    content_type: "text",
    status: "sent",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("message thread scroll position", () => {
  it("uses one clamped distance-from-bottom measure", () => {
    expect(
      distanceFromBottom({ scrollHeight: 1_000, scrollTop: 700, clientHeight: 250 }),
    ).toBe(50);
    expect(
      distanceFromBottom({ scrollHeight: 1_000, scrollTop: 800, clientHeight: 250 }),
    ).toBe(0);
  });

  it("treats a small tolerance near the bottom as following latest content", () => {
    expect(
      isNearBottom({
        scrollHeight: 1_000,
        scrollTop: 1_000 - 250 - MESSAGE_SCROLL_BOTTOM_THRESHOLD_PX,
        clientHeight: 250,
      }),
    ).toBe(true);
    expect(
      isNearBottom({
        scrollHeight: 1_000,
        scrollTop: 1_000 - 250 - MESSAGE_SCROLL_BOTTOM_THRESHOLD_PX - 1,
        clientHeight: 250,
      }),
    ).toBe(false);
  });

  it("preserves history for status updates, same-history resyncs, and inbound rows while reading above", () => {
    expect(shouldFollowLatest({ hasNewMessage: false, wasNearBottom: false })).toBe(false);
    expect(shouldFollowLatest({ hasNewMessage: false, wasNearBottom: true })).toBe(false);
    expect(shouldFollowLatest({ hasNewMessage: true, wasNearBottom: false })).toBe(false);
  });

  it("follows inbound and delayed media growth only when already near bottom", () => {
    expect(shouldFollowLatest({ hasNewMessage: true, wasNearBottom: true })).toBe(true);
    expect(shouldFollowLatest({ hasNewMessage: false, wasNearBottom: true })).toBe(false);
  });

  it("always follows an agent's optimistic text, media, template, or interactive send", () => {
    for (const type of ["text", "media", "template", "interactive"]) {
      expect(
        shouldFollowLatest({
          hasNewMessage: true,
          wasNearBottom: false,
          isOwnOptimisticSend: true,
        }),
        type,
      ).toBe(true);
    }
  });

  it("recognizes a persisted outgoing row as the replacement of its optimistic bubble", () => {
    const optimistic = message({
      id: "temp-123",
      sender_type: "agent",
      content_text: "same payload",
    });
    const persisted = message({
      id: "real-999",
      sender_type: "agent",
      content_text: "same payload",
    });
    const inbound = message({ id: "inbound", content_text: "same payload" });

    expect(isOptimisticMessageReplacement([optimistic], persisted)).toBe(true);
    expect(isOptimisticMessageReplacement([optimistic], inbound)).toBe(false);
  });
});
