// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import { ConversationList } from "./conversation-list";
import type { Conversation } from "@/types";

// ---------------------------------------------------------------------------
// Component-level coverage for the Inbox "Needs human attention" indicator
// and filter (this round's item C): the indicator must show only for a real
// handoff (disabled + a non-empty summary), never for a bare manual pause,
// and must not crowd out the existing unread badge / status dot. See
// needsHumanAttention() in src/lib/inbox/conversations.ts for the shared
// predicate this all builds on.
// ---------------------------------------------------------------------------

vi.mock("next-intl", () => ({
  // Identity translator — tests assert against the message KEY, not a
  // localized string, so this file doesn't need to duplicate en.json.
  useTranslations: () => (key: string) => key,
}));

// The list fetches its own copy of conversations + tags on mount via
// Supabase, then hands them back up through onConversationsLoaded — but
// what's actually RENDERED comes from the `conversations` prop, which the
// test controls directly. Resolve both queries to empty so the mount
// effect is a harmless no-op.
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (_table: string) => {
      const builder = {
        select: () => builder,
        order: () => Promise.resolve({ data: [], error: null }),
      };
      return builder;
    },
  }),
}));

function contact(name: string) {
  return {
    id: `ct-${name}`,
    account_id: "acct-1",
    name,
    phone: "+15550000000",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  } as Conversation["contact"];
}

function conv(overrides: Partial<Conversation>): Conversation {
  return {
    id: "conv-default",
    user_id: "u-1",
    contact_id: "ct-default",
    status: "open",
    unread_count: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    last_message_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// A real handoff: disabled + a non-empty summary.
const HANDOFF_CONV = conv({
  id: "conv-handoff",
  contact_id: "ct-handoff",
  contact: contact("Handoff Person"),
  ai_autoreply_disabled: true,
  ai_handoff_summary: "🤖 AI agent handed off after 2 replies.",
  unread_count: 3,
  status: "open",
});

// A plain manual pause: disabled, but NO summary — must NOT count as a
// pending handoff.
const MANUAL_PAUSE_CONV = conv({
  id: "conv-manual-pause",
  contact_id: "ct-manual-pause",
  contact: contact("Manual Pause Person"),
  ai_autoreply_disabled: true,
  ai_handoff_summary: null,
  unread_count: 0,
  status: "pending",
});

// A normal, untouched conversation.
const NORMAL_CONV = conv({
  id: "conv-normal",
  contact_id: "ct-normal",
  contact: contact("Normal Person"),
  ai_autoreply_disabled: false,
  ai_handoff_summary: null,
  unread_count: 0,
  status: "closed",
});

function renderList(conversations: Conversation[]) {
  return render(
    <ConversationList
      activeConversationId={null}
      onSelect={() => {}}
      conversations={conversations}
      onConversationsLoaded={() => {}}
    />,
  );
}

afterEach(() => {
  // vitest.config.ts doesn't set `test.globals: true`, so RTL's
  // automatic per-test cleanup never registers — do it explicitly.
  cleanup();
});

describe('ConversationList — "Needs human" indicator (test #17, #18)', () => {
  it("shows the Needs-human indicator for disabled=true + a non-empty handoffSummary", async () => {
    renderList([HANDOFF_CONV]);
    // The list starts in a loading state until its own (mocked, no-op)
    // fetch effect resolves — wait for the item to actually mount before
    // asserting on it.
    expect(await screen.findByTitle("needsHumanAttention")).toBeInTheDocument();
  });

  it("does NOT show the indicator for disabled=true with no summary (plain manual pause)", async () => {
    renderList([MANUAL_PAUSE_CONV]);
    expect(await screen.findByText("Manual Pause Person")).toBeInTheDocument();
    expect(screen.queryByTitle("needsHumanAttention")).not.toBeInTheDocument();
  });

  it("does NOT show the indicator for a normal, untouched conversation", async () => {
    renderList([NORMAL_CONV]);
    expect(await screen.findByText("Normal Person")).toBeInTheDocument();
    expect(screen.queryByTitle("needsHumanAttention")).not.toBeInTheDocument();
  });
});

describe('ConversationList — badges alongside the indicator (test #20, #21)', () => {
  it("the unread badge still appears next to the Needs-human indicator", async () => {
    renderList([HANDOFF_CONV]);
    expect(await screen.findByTitle("needsHumanAttention")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument(); // unread_count
  });

  it("the status dot still appears next to the Needs-human indicator", async () => {
    renderList([HANDOFF_CONV]);
    await screen.findByTitle("needsHumanAttention");
    // STATUS_COLORS keys the dot's title to the raw status value.
    expect(screen.getByTitle("open")).toBeInTheDocument();
  });

  it("the unread badge and status dot still render normally with no handoff present", async () => {
    renderList([conv({ ...NORMAL_CONV, unread_count: 5, status: "pending" })]);
    expect(await screen.findByText("5")).toBeInTheDocument();
    expect(screen.getByTitle("pending")).toBeInTheDocument();
    expect(screen.queryByTitle("needsHumanAttention")).not.toBeInTheDocument();
  });
});

describe('ConversationList — "Needs human" filter (test #19)', () => {
  it('selecting the "Needs human" filter shows only real handoffs', async () => {
    renderList([HANDOFF_CONV, MANUAL_PAUSE_CONV, NORMAL_CONV]);

    // All three visible under the default "all" filter.
    expect(await screen.findByText("Handoff Person")).toBeInTheDocument();
    expect(screen.getByText("Manual Pause Person")).toBeInTheDocument();
    expect(screen.getByText("Normal Person")).toBeInTheDocument();

    // Open the filter dropdown and pick "Needs human" (rendered by key,
    // per the identity translator above: t("filterNeedsHuman")).
    fireEvent.click(screen.getByText("filterAll"));
    const option = await screen.findByText("filterNeedsHuman");
    fireEvent.click(option);

    expect(await screen.findByText("Handoff Person")).toBeInTheDocument();
    expect(screen.queryByText("Manual Pause Person")).not.toBeInTheDocument();
    expect(screen.queryByText("Normal Person")).not.toBeInTheDocument();
  });
});
