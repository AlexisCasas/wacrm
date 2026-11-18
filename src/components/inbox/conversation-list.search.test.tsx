// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { ConversationList } from "./conversation-list";
import type { Conversation } from "@/types";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

const h = vi.hoisted(() => ({
  // rows each "branch" returns, keyed by source; error switch for failures
  rows: { contact: [] as unknown[], message: [] as unknown[], normal: [] as unknown[] },
  fail: false,
  orFilters: [] as string[],
  ilikePatterns: [] as string[],
  ranges: [] as { source: string; from: number; to: number }[],
  eqCalls: [] as [string, unknown][],
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      let source: "normal" | "contact" | "message" = "normal";
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (c: string, v: unknown) => (table === "conversations" && h.eqCalls.push([c, v]), b),
        order: () => b,
        abortSignal: () => b,
        or: (f: string) => ((source = "contact"), h.orFilters.push(f), b),
        ilike: (_c: string, p: string) => ((source = "message"), h.ilikePatterns.push(p), b),
        range: (from: number, to: number) => {
          h.ranges.push({ source, from, to });
          if (h.fail) return Promise.resolve({ data: null, error: { message: "boom" } });
          return Promise.resolve({ data: h.rows[source].slice(from, to + 1), error: null });
        },
        then: (resolve: (r: unknown) => unknown) =>
          Promise.resolve({ data: table === "tags" ? [] : h.rows.normal, error: h.fail && table !== "tags" ? { message: "boom" } : null }).then(resolve),
      };
      return b;
    },
  }),
}));

const mk = (id: string, name: string, phone: string | null): Conversation =>
  ({
    id, user_id: "u", contact_id: `ct-${id}`, status: "open", unread_count: 0,
    last_message_at: "2026-01-01T00:00:00Z", last_message_text: "hola",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    contact: { id: `ct-${id}`, account_id: "acct-1", name, phone, tags: [], created_at: "", updated_at: "" },
  }) as unknown as Conversation;

function Harness({ initial }: { initial?: Conversation[] }) {
  const [list, setList] = useState<Conversation[]>(initial ?? []);
  return (
    <ConversationList
      activeConversationId={null}
      onSelect={() => {}}
      conversations={list}
      onConversationsLoaded={setList}
    />
  );
}

async function type(value: string) {
  fireEvent.change(screen.getByPlaceholderText("searchPlaceholder"), { target: { value } });
  await act(async () => { await new Promise((r) => setTimeout(r, 450)); });
}

beforeEach(() => {
  h.rows = { contact: [], message: [], normal: [] };
  h.fail = false; h.orFilters = []; h.ilikePatterns = []; h.ranges = []; h.eqCalls = [];
});
afterEach(cleanup);

describe("Inbox search (FIX-01)", () => {
  it.each(["987654321", "+51 987 654 321", "987-654-321", "(51) 987-654-321"])(
    "phone typed as %s finds the contact (exact normalized filter)",
    async (typed) => {
      h.rows.contact = [mk("1", "Ana", "51987654321")];
      render(<Harness />);
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      await type(typed);
      await waitFor(() => expect(screen.getByText("Ana")).toBeTruthy());
      expect(h.orFilters.at(-1)).toContain("phone_normalized.in.(51987654321,987654321)");
      expect(h.orFilters.at(-1)).not.toContain("phone.ilike");
    },
  );

  it("name with accents and special characters is quoted and still found", async () => {
    h.rows.contact = [mk("1", "José, Ñandú (VIP)", "51900000001")];
    render(<Harness />);
    await type("José, Ñandú (VIP)");
    await waitFor(() => expect(screen.getByText("José, Ñandú (VIP)")).toBeTruthy());
    expect(h.orFilters.at(-1)).toContain('name.ilike."%José, Ñandú (VIP)%"');
    expect(h.ilikePatterns.at(-1)).toBe("%José, Ñandú (VIP)%");
  });

  it("LIKE wildcards in the term are escaped for the message branch", async () => {
    render(<Harness />);
    await type("50%_off");
    await waitFor(() => expect(h.ilikePatterns.length).toBeGreaterThan(0));
    expect(h.ilikePatterns.at(-1)).toBe("%50\\%\\_off%");
  });

  it("no match shows the empty message, not an error", async () => {
    render(<Harness />);
    await type("zzzz");
    await waitFor(() => expect(screen.getByText("noConversations")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("query failure shows an alert with retry, and retry recovers", async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    h.fail = true;
    await type("maria");
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText("loadError")).toBeTruthy();
    expect(screen.queryByText("noConversations")).toBeNull();

    h.fail = false;
    h.rows.contact = [mk("1", "Maria", "51911111111")];
    fireEvent.click(screen.getByText("retry"));
    await waitFor(() => expect(screen.getByText("Maria")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("blocked contacts stay excluded and no account override is added (RLS isolation untouched)", async () => {
    render(<Harness />);
    await type("ana");
    await waitFor(() => expect(h.ranges.length).toBeGreaterThan(0));
    expect(h.eqCalls.every(([c, v]) => c === "contact.blocked" && v === false)).toBe(true);
  });

  it("pages each branch past 1000 rows", async () => {
    h.rows.contact = Array.from({ length: 2300 }, (_, i) => mk(`c${i}`, `Ana ${i}`, `5190000${String(i).padStart(4, "0")}`));
    render(<Harness />);
    await type("ana");
    await waitFor(() => expect(h.ranges.filter((r) => r.source === "contact").length).toBe(3));
    expect(h.ranges.filter((r) => r.source === "contact").map((r) => r.from)).toEqual([0, 1000, 2000]);
  });

  it("status filters still apply to search results", async () => {
    const closed = { ...mk("2", "Ana Cerrada", "51922222222"), status: "closed" } as Conversation;
    h.rows.contact = [mk("1", "Ana Abierta", "51911111111"), closed];
    render(<Harness />);
    await type("ana");
    await waitFor(() => expect(screen.getByText("Ana Cerrada")).toBeTruthy());
    fireEvent.click(screen.getByText("filterAll"));
    fireEvent.click(await screen.findByText("filterClosed"));
    await waitFor(() => expect(screen.queryByText("Ana Abierta")).toBeNull());
    expect(screen.getByText("Ana Cerrada")).toBeTruthy();
  });
});
