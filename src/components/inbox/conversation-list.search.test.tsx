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
  rows: { contact: [] as unknown[], message: [] as unknown[], normal: [] as unknown[], order: [] as unknown[] },
  orders: [] as { contact_id: string | null }[],
  failOrders: false,
  orderPhones: [] as string[][],
  orderContactIds: [] as string[][],
  orderQueries: 0,
  rpcWindows: [] as Array<{ p_account: string; p_phones: string[]; p_after: string | null; p_before: string | null; p_limit: number }>,
  rpcRows: [] as Array<Array<{ contact_id: string | null }>>,
  fail: false,
  orFilters: [] as string[],
  ilikePatterns: [] as string[],
  ranges: [] as { source: string; from: number; to: number }[],
  eqCalls: [] as [string, string, unknown][],
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: (_name: string, args: { p_account: string; p_phones: string[]; p_after: string | null; p_before: string | null; p_limit: number }) => {
      h.orderQueries++;
      h.orderPhones.push(args.p_phones);
      h.rpcWindows.push(args);
      const index = h.rpcWindows.length - 1;
      const result = { data: h.rpcRows[index] ?? [], error: h.failOrders ? { message: "orders boom" } : null };
      return { abortSignal: () => Promise.resolve(result) };
    },
    from: (table: string) => {
      let source: "normal" | "contact" | "message" | "order" = "normal";
      const b: Record<string, unknown> = {
        select: () => b,
        in: (col: string, vals: string[]) => {
          if (table === "order_confirmations") { h.orderQueries++; h.orderPhones.push(vals); }
          else if (col === "contact_id") { source = "order"; h.orderContactIds.push(vals); }
          return b;
        },
        not: () => b,
        eq: (c: string, v: unknown) => (h.eqCalls.push([table, c, v]), b),
        order: () => b,
        abortSignal: () => b,
        or: (f: string) => ((source = "contact"), h.orFilters.push(f), b),
        ilike: (_c: string, p: string) => ((source = "message"), h.ilikePatterns.push(p), b),
        range: (from: number, to: number) => {
          if (table === "order_confirmations") {
            if (h.failOrders) return Promise.resolve({ data: null, error: { message: "orders boom" } });
            return Promise.resolve({ data: h.orders.slice(from, to + 1), error: null });
          }
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
      accountId="acct-1"
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
  h.rows = { contact: [], message: [], normal: [], order: [] };
  h.orders = []; h.failOrders = false; h.orderPhones = []; h.orderContactIds = []; h.orderQueries = 0; h.rpcWindows = []; h.rpcRows = [];
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

  it("scopes Inbox conversation queries to the authenticated account while preserving blocked filtering", async () => {
    render(<Harness />);
    await type("ana");
    await waitFor(() => expect(h.ranges.length).toBeGreaterThan(0));
    expect(h.eqCalls).toContainEqual(["conversations", "account_id", "acct-1"]);
    expect(h.eqCalls).toContainEqual(["conversations", "contact.blocked", false]);
  });

  it("uses the account supplied to the component for a second tenant", async () => {
    function AccountBHarness() {
      const [list, setList] = useState<Conversation[]>([]);
      return (
        <ConversationList
          accountId="acct-b"
          activeConversationId={null}
          onSelect={() => {}}
          conversations={list}
          onConversationsLoaded={setList}
        />
      );
    }
    render(<AccountBHarness />);
    await type("ana");
    await waitFor(() =>
      expect(h.eqCalls).toContainEqual(["conversations", "account_id", "acct-b"]),
    );
  });

  it("does not query conversations or tags before accountId is resolved", async () => {
    const [list] = [([] as Conversation[])];
    render(
      <ConversationList
        accountId={null}
        activeConversationId={null}
        onSelect={() => {}}
        conversations={list}
        onConversationsLoaded={() => {}}
      />,
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(h.eqCalls).toEqual([]);
    expect(h.orderQueries).toBe(0);
  });

  it("scopes the order lookup to the current account", async () => {
    h.rpcRows = [[{ contact_id: "ct-b1" }]];
    h.rows.order = [mk("b1", "Order Match", "")];
    render(<Harness />);
    await type("987654321");
    await waitFor(() => expect(h.orderQueries).toBe(1));
    expect(h.eqCalls).toContainEqual(["order_confirmations", "account_id", "acct-1"]);
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

  describe("FIX 02: phone on the order", () => {
    const bsuidOnly = (id: string, name: string) => ({ ...mk(id, name, ""), contact: { ...mk(id, name, "").contact, phone: "" } }) as Conversation;

    it("a complete phone also consults orders and shows the BSUID-only conversation with the badge", async () => {
      h.rpcRows = [[{ contact_id: "ct-b1" }, { contact_id: "ct-b1" }]]; // two orders, one contact
      h.rows.order = [bsuidOnly("b1", "Solo Bsuid")];
      render(<Harness />);
      await type("+51 954 953 878");
      await waitFor(() => expect(screen.getByText("Solo Bsuid")).toBeTruthy());
      expect(h.orderPhones.at(-1)).toEqual(["51954953878", "954953878"]);
      expect(h.orderContactIds.at(-1)).toEqual(["ct-b1"]);
      expect(screen.getByText("matchedByOrder")).toBeTruthy();
    });

    it("a conversation already found through the contact is not duplicated nor badged", async () => {
      h.rows.contact = [mk("1", "Ana", "51987654321")];
      h.orders = [{ contact_id: "ct-1" }];
      h.rows.order = [mk("1", "Ana", "51987654321")];
      render(<Harness />);
      await type("987654321");
      await waitFor(() => expect(screen.getByText("Ana")).toBeTruthy());
      expect(screen.getAllByText("Ana")).toHaveLength(1);
      expect(screen.queryByText("matchedByOrder")).toBeNull();
    });

    it("text, names and phone fragments never query orders", async () => {
      render(<Harness />);
      await type("maria");
      await waitFor(() => expect(h.ranges.length).toBeGreaterThan(0));
      await type("654 321");
      await type("1234");
      expect(h.orderQueries).toBe(0);
    });

    it("one phone on orders of several contacts shows every match and selects none", async () => {
      const onSelect = vi.fn();
      h.rpcRows = [[{ contact_id: "ct-b1" }, { contact_id: "ct-b2" }, { contact_id: "ct-b3" }]];
      h.rows.order = [bsuidOnly("b1", "Uno"), bsuidOnly("b2", "Dos"), bsuidOnly("b3", "Tres")];
      function Wrap() {
        const [list, setList] = useState<Conversation[]>([]);
        return <ConversationList accountId="acct-1" activeConversationId={null} onSelect={onSelect} conversations={list} onConversationsLoaded={setList} />;
      }
      render(<Wrap />);
      await type("987654321");
      await waitFor(() => expect(screen.getAllByText("matchedByOrder")).toHaveLength(3));
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("orders with a deleted contact (null) are ignored", async () => {
      h.rpcRows = [[{ contact_id: null }]];
      render(<Harness />);
      await type("987654321");
      await waitFor(() => expect(h.orderQueries).toBe(1));
      expect(h.orderContactIds).toEqual([]);
      await waitFor(() => expect(screen.getByText("noConversations")).toBeTruthy());
    });

    it("more than 100 matching contacts: expands 100 and says there are more", async () => {
      h.rpcRows = [Array.from({ length: 101 }, (_, i) => ({ contact_id: `ct-x${i}` }))];
      h.rows.order = Array.from({ length: 100 }, (_, i) => bsuidOnly(`x${i}`, `Cliente ${i}`));
      render(<Harness />);
      await type("987654321");
      await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
      expect(screen.getByText("orderMatchesTruncated")).toBeTruthy();
      expect(h.orderContactIds.at(-1)).toHaveLength(100);
    });

    it("expands 15d -> 30d -> 90d and stops on the first historical match", async () => {
      h.rpcRows = [[], [], [{ contact_id: "ct-b1" }]];
      h.rows.order = [bsuidOnly("b1", "Historico")];
      render(<Harness />);
      await type("51942309277");
      await waitFor(() => expect(screen.getByText("Historico")).toBeTruthy());
      expect(h.rpcWindows).toHaveLength(3);
      expect(h.rpcWindows[0].p_after).toBeTruthy();
      expect(h.rpcWindows[0].p_before).toBeNull();
      expect(h.rpcWindows[1].p_before).toBe(h.rpcWindows[0].p_after);
      expect(h.rpcWindows[2].p_before).toBe(h.rpcWindows[1].p_after);
      expect(h.rpcWindows.every((w) => w.p_account === "acct-1")).toBe(true);
      expect(h.orderPhones[0]).toEqual(["51942309277", "942309277"]);
    });

    it("skips historical order fallback when the contact phone already matches directly", async () => {
      h.rows.contact = [mk("1", "Directo", "51942309277")];
      render(<Harness />);
      await type("51942309277");
      await waitFor(() => expect(screen.getByText("Directo")).toBeTruthy());
      expect(h.orderQueries).toBe(0);
    });

    it("an order lookup failure is shown as an error, never as partial results", async () => {
      h.rows.contact = [mk("1", "Ana", "51987654321")];
      h.failOrders = true;
      render(<Harness />);
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      await type("987654321");
      await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
      expect(screen.queryByText("Ana")).toBeNull();
      h.failOrders = false; h.rpcRows = [[{ contact_id: "ct-b1" }]]; h.rows.order = [bsuidOnly("b1", "Solo Bsuid")];
      fireEvent.click(screen.getByText("retry"));
      await waitFor(() => expect(screen.getByText("Solo Bsuid")).toBeTruthy());
    });

    it("the order matches respect the status filter", async () => {
      h.rpcRows = [[{ contact_id: "ct-b1" }]];
      h.rows.order = [{ ...bsuidOnly("b1", "Solo Bsuid"), status: "closed" } as Conversation];
      render(<Harness />);
      await type("987654321");
      await waitFor(() => expect(screen.getByText("Solo Bsuid")).toBeTruthy());
      fireEvent.click(screen.getByText("filterAll"));
      fireEvent.click(await screen.findByText("filterOpen"));
      await waitFor(() => expect(screen.queryByText("Solo Bsuid")).toBeNull());
    });
  });
});
