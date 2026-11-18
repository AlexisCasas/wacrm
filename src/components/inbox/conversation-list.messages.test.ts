import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json";
import es from "../../../messages/es.json";
import ko from "../../../messages/ko.json";

// The Inbox list reads these keys from `Inbox.conversationList`; identity-translator
// component tests cannot notice a key placed in the wrong namespace.
const KEYS = ["noConversations", "loadError", "retry", "matchedByOrder", "matchedByOrderHint", "orderMatchesTruncated"];

describe.each([["en", en], ["es", es], ["ko", ko]] as const)("Inbox.conversationList messages (%s)", (_l, messages) => {
  it.each(KEYS)("has a non-empty %s", (key) => {
    const ns = (messages as unknown as { Inbox: { conversationList: Record<string, string> } }).Inbox.conversationList;
    expect(typeof ns[key]).toBe("string");
    expect(ns[key].trim().length).toBeGreaterThan(0);
  });
});
