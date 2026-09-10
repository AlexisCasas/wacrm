// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

import { TagManager } from "./tag-manager";

// P3 adversarial review — TagManager's catalog fetch was scoped by
// `user_id`, which is wrong under account sharing (migration 017):
// two admins/owners of the SAME account must see the SAME tags, not
// only the ones each of them personally created. This file covers
// ONLY that regression — TagManager's create/delete flows are
// exercised elsewhere (tag-create.test.ts, the /api/tags route test).

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/contacts/tag-api", () => ({
  createTag: vi.fn(),
  TagApiError: class TagApiError extends Error {},
}));

const h = vi.hoisted(() => ({
  accountId: "acct-1" as string | null,
  userId: "user-1" as string | null,
  fromCalls: [] as { table: string; filters: [string, unknown][] }[],
  tagsByAccount: {} as Record<string, { id: string; name: string; color: string }[]>,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: h.userId ? { id: h.userId } : null,
    accountId: h.accountId,
    loading: false,
  }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      const filters: [string, unknown][] = [];
      const builder = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return builder;
        },
        order: () => {
          h.fromCalls.push({ table, filters });
          if (table !== "tags") return Promise.resolve({ data: [], error: null });
          const accountFilter = filters.find(([col]) => col === "account_id");
          const data = accountFilter ? h.tagsByAccount[accountFilter[1] as string] ?? [] : [];
          return Promise.resolve({ data, error: null });
        },
      };
      return builder;
    },
  }),
}));

beforeEach(() => {
  h.accountId = "acct-1";
  h.userId = "user-1";
  h.fromCalls = [];
  h.tagsByAccount = {
    "acct-1": [
      { id: "t1", name: "Favoritos", color: "#f59e0b" },
      { id: "t2", name: "Pendiente", color: "#3b82f6" },
    ],
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TagManager — account-scoped catalog (P3 adversarial review)", () => {
  it("fetches tags filtered by account_id, never by user_id", async () => {
    render(<TagManager />);
    await screen.findByText("Favoritos");

    const tagsCall = h.fromCalls.find((c) => c.table === "tags");
    expect(tagsCall).toBeDefined();
    expect(tagsCall!.filters).toContainEqual(["account_id", "acct-1"]);
    expect(tagsCall!.filters.some(([col]) => col === "user_id")).toBe(false);
  });

  it("two different users on the SAME account see the SAME tag catalog", async () => {
    h.userId = "user-A";
    const { unmount } = render(<TagManager />);
    expect(await screen.findByText("Favoritos")).toBeInTheDocument();
    expect(screen.getByText("Pendiente")).toBeInTheDocument();
    unmount();

    h.userId = "user-B"; // different user, SAME accountId ('acct-1')
    render(<TagManager />);
    expect(await screen.findByText("Favoritos")).toBeInTheDocument();
    expect(screen.getByText("Pendiente")).toBeInTheDocument();
  });

  it("does not query for tags before the account is resolved", async () => {
    h.accountId = null;
    render(<TagManager />);
    await waitFor(() => {
      expect(h.fromCalls.find((c) => c.table === "tags")).toBeUndefined();
    });
  });
});
