// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

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
  // ConversationItem resolves a date-fns locale via useLocale() (see
  // src/lib/date-locale.ts) for its "time ago" label — fixed to 'en' so
  // this test doesn't depend on the app's default locale.
  useLocale: () => "en",
}));

// The list fetches its own copy of conversations + tags on mount via
// Supabase, then hands them back up through onConversationsLoaded — but
// what's actually RENDERED comes from the `conversations` prop, which the
// test controls directly. Most tests don't care about the tag catalog
// fetch's contents, so `h.tagsCatalog` defaults empty; the
// `tagCatalogVersion` describe block below overrides it per-test.
const h = vi.hoisted(() => ({
  tagsCatalog: [] as { id: string; name: string; color: string }[],
  tagsFetchCount: 0,
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        order: () => {
          if (table === "tags") {
            h.tagsFetchCount++;
            return Promise.resolve({ data: h.tagsCatalog, error: null });
          }
          return Promise.resolve({ data: [], error: null });
        },
      };
      return builder;
    },
  }),
}));

beforeEach(() => {
  h.tagsCatalog = [];
  h.tagsFetchCount = 0;
});

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

function taggedContact(
  name: string,
  tags: NonNullable<Conversation["contact"]>["tags"],
): Conversation["contact"] {
  return { ...contact(name), tags } as Conversation["contact"];
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

describe("ConversationList — compact tag badges (P3, no extra query)", () => {
  function tag(id: string, name: string, color = "#3b82f6") {
    return { id, name, color, account_id: "acct-1", user_id: "u-1", created_at: "2026-01-01T00:00:00Z" };
  }

  it("renders nothing extra when the contact has no tags", async () => {
    renderList([NORMAL_CONV]);
    await screen.findByText("Normal Person");
    expect(screen.queryByTitle("Favoritos")).not.toBeInTheDocument();
  });

  it("renders every tag as a chip when there are 2 or fewer", async () => {
    const conversation = conv({
      ...NORMAL_CONV,
      id: "conv-two-tags",
      contact: taggedContact("Two Tags Person", [tag("t1", "Favoritos"), tag("t2", "Pendiente")]),
    });
    renderList([conversation]);
    await screen.findByText("Two Tags Person");
    expect(screen.getByText("Favoritos")).toBeInTheDocument();
    expect(screen.getByText("Pendiente")).toBeInTheDocument();
    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument();
  });

  it("collapses anything past the first 2 tags into a +N chip", async () => {
    const conversation = conv({
      ...NORMAL_CONV,
      id: "conv-many-tags",
      contact: taggedContact("Many Tags Person", [
        tag("t1", "Favoritos"),
        tag("t2", "Pendiente"),
        tag("t3", "Reclamo"),
        tag("t4", "Cliente frecuente"),
      ]),
    });
    renderList([conversation]);
    await screen.findByText("Many Tags Person");
    expect(screen.getByText("Favoritos")).toBeInTheDocument();
    expect(screen.getByText("Pendiente")).toBeInTheDocument();
    expect(screen.queryByText("Reclamo")).not.toBeInTheDocument();
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("badges never block the existing unread badge / status dot from rendering", async () => {
    const conversation = conv({
      ...HANDOFF_CONV,
      contact: taggedContact("Tagged Handoff", [tag("t1", "Favoritos")]),
    });
    renderList([conversation]);
    expect(await screen.findByTitle("needsHumanAttention")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument(); // unread_count
    expect(screen.getByText("Favoritos")).toBeInTheDocument();
  });

  it("does not perform any additional Supabase query to render badges (mocked client only ever returns the empty catalog fetches)", async () => {
    // The module-level mock at the top of this file resolves every
    // `.from(...)` chain to `{ data: [], error: null }` — if badge
    // rendering required a NEW query shape this mock doesn't already
    // satisfy, the component would throw or hang instead of rendering.
    const conversation = conv({
      ...NORMAL_CONV,
      id: "conv-badge-no-query",
      contact: taggedContact("No Extra Query", [tag("t1", "Favoritos")]),
    });
    renderList([conversation]);
    expect(await screen.findByText("Favoritos")).toBeInTheDocument();
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

describe("ConversationList — tagCatalogVersion invalidation (P3 adversarial review, item 3)", () => {
  function renderWithVersion(version: number) {
    return render(
      <ConversationList
        activeConversationId={null}
        onSelect={() => {}}
        conversations={[]}
        onConversationsLoaded={() => {}}
        tagCatalogVersion={version}
      />,
    );
  }

  it("a newly-created tag becomes selectable in the filter as soon as tagCatalogVersion bumps — no reload/resync needed", async () => {
    h.tagsCatalog = [{ id: "t1", name: "Favoritos", color: "#f59e0b" }];
    const { rerender } = renderWithVersion(0);
    await waitFor(() => expect(h.tagsFetchCount).toBe(1));

    fireEvent.click(await screen.findByText("tags"));
    expect(await screen.findByText("Favoritos")).toBeInTheDocument();
    expect(screen.queryByText("Cliente frecuente")).not.toBeInTheDocument();

    // Simulate ContactSidebar creating "Cliente frecuente" — the parent
    // (Inbox page) bumps tagCatalogVersion in response to onTagCreated.
    h.tagsCatalog = [
      { id: "t1", name: "Favoritos", color: "#f59e0b" },
      { id: "t2", name: "Cliente frecuente", color: "#8b5cf6" },
    ];
    rerender(
      <ConversationList
        activeConversationId={null}
        onSelect={() => {}}
        conversations={[]}
        onConversationsLoaded={() => {}}
        tagCatalogVersion={1}
      />,
    );

    await waitFor(() => expect(h.tagsFetchCount).toBe(2));
    expect(await screen.findByText("Cliente frecuente")).toBeInTheDocument();
  });

  it("does NOT refetch the tag catalog when only resyncToken bumps (assign/remove of an existing tag must not force a catalog refetch)", async () => {
    h.tagsCatalog = [{ id: "t1", name: "Favoritos", color: "#f59e0b" }];
    const { rerender } = render(
      <ConversationList
        activeConversationId={null}
        onSelect={() => {}}
        conversations={[]}
        onConversationsLoaded={() => {}}
        tagCatalogVersion={0}
        resyncToken={0}
      />,
    );
    await waitFor(() => expect(h.tagsFetchCount).toBe(1));

    rerender(
      <ConversationList
        activeConversationId={null}
        onSelect={() => {}}
        conversations={[]}
        onConversationsLoaded={() => {}}
        tagCatalogVersion={0}
        resyncToken={1}
      />,
    );

    // Give any (incorrect) effect a chance to fire before asserting it didn't.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.tagsFetchCount).toBe(1);
  });

  it("preserves selectedTagIds / OR-filter behavior across a catalog refresh", async () => {
    h.tagsCatalog = [
      { id: "t1", name: "Favoritos", color: "#f59e0b" },
      { id: "t2", name: "Pendiente", color: "#3b82f6" },
    ];
    const contactWithFavoritos = taggedContact("Has Favoritos", [
      { id: "t1", name: "Favoritos", color: "#f59e0b", user_id: "u-1", created_at: "2026-01-01T00:00:00Z" },
    ]);
    const conversation = conv({ id: "conv-fav", contact_id: "ct-fav", contact: contactWithFavoritos });

    const { rerender } = render(
      <ConversationList
        activeConversationId={null}
        onSelect={() => {}}
        conversations={[conversation]}
        onConversationsLoaded={() => {}}
        tagCatalogVersion={0}
      />,
    );
    await screen.findByText("Has Favoritos");

    // The seeded conversation's contact also carries a "Favoritos" badge
    // chip, so the plain text is ambiguous — the dropdown option is the
    // only one with the menuitemcheckbox role.
    fireEvent.click(screen.getByText("tags"));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Favoritos" }));
    // Selecting the tag filters the list down to the matching conversation
    // (still visible — it has "Favoritos").
    expect(await screen.findByText("Has Favoritos")).toBeInTheDocument();

    h.tagsCatalog = [...h.tagsCatalog, { id: "t3", name: "Reclamo", color: "#ec4899" }];
    rerender(
      <ConversationList
        activeConversationId={null}
        onSelect={() => {}}
        conversations={[conversation]}
        onConversationsLoaded={() => {}}
        tagCatalogVersion={1}
      />,
    );

    // The selection (and therefore the filtered result) survives the
    // catalog refresh triggered by the version bump.
    expect(await screen.findByText("Has Favoritos")).toBeInTheDocument();
  });
});
