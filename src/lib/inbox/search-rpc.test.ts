import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Conversation } from "@/types";
import { INBOX_CONVERSATION_SELECT } from "@/lib/inbox/conversations";
import {
  fetchInboxSearchViaRpc,
  matchesInboxRpcSearch,
} from "@/lib/inbox/search-rpc";

function conversation(id: string): Conversation {
  return {
    id,
    user_id: "test-user",
    contact_id: `contact-${id}`,
    status: "open",
    unread_count: 0,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    contact: {
      id: `contact-${id}`,
      user_id: "test-user",
      account_id: "test-account",
      phone: "+51 981 629 790",
      name: "Misael",
      wa_username: "misael_qat",
      created_at: "2026-11-01T00:00:00Z",
      updated_at: "2026-11-01T00:00:00Z",
    },
    last_message_text: "Referencia 123456",
  };
}

type Call = {
  name: string;
  params: Record<string, unknown>;
  selection?: string;
  orders: Array<[string, boolean]>;
  range?: [number, number];
  signal?: AbortSignal;
};

function fakeClient(rows: Conversation[], failure?: { message: string }) {
  const calls: Call[] = [];
  const rpc = vi.fn((name: string, params: Record<string, unknown>) => {
    const call: Call = { name, params, orders: [] };
    calls.push(call);
    const builder = {
      select(selection: string) {
        call.selection = selection;
        return builder;
      },
      order(column: string, options: { ascending: boolean }) {
        call.orders.push([column, options.ascending]);
        return builder;
      },
      range(from: number, to: number) {
        call.range = [from, to];
        return builder;
      },
      abortSignal(signal: AbortSignal) {
        call.signal = signal;
        const [from, to] = call.range ?? [0, 999];
        return Promise.resolve(
          failure
            ? { data: null, error: failure }
            : { data: rows.slice(from, to + 1), error: null },
        );
      },
    };
    return builder;
  });
  return { client: { rpc } as unknown as SupabaseClient, calls, rpc };
}

describe("SEARCH-01 read-only Inbox RPC client", () => {
  it("does a single query for one phone match with the original full select", async () => {
    const { client, calls } = fakeClient([conversation("misael")]);
    const controller = new AbortController();
    const onRequest = vi.fn();
    const result = await fetchInboxSearchViaRpc(client, "981629790", controller.signal, onRequest);
    expect(result.map((row) => row.id)).toEqual(["misael"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: "search_inbox_conversations",
      params: { p_search: "981629790" },
      selection: INBOX_CONVERSATION_SELECT,
      orders: [["last_message_at", false], ["id", true]],
      range: [0, 999],
      signal: controller.signal,
    });
    expect(onRequest).toHaveBeenCalledTimes(1);
  });

  it("does not lose conversations after the first 1,000 and pages deterministically", async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => conversation(`c-${i}`));
    const { client, calls } = fakeClient(rows);
    const fetched = await fetchInboxSearchViaRpc(client, "QA", new AbortController().signal);
    expect(fetched).toHaveLength(1001);
    expect(fetched.at(-1)?.id).toBe("c-1000");
    expect(calls.map((call) => call.range)).toEqual([[0, 999], [1000, 1999]]);
  });

  it("reads one empty page after a full 1,000-row page", async () => {
    const { client, calls } = fakeClient(
      Array.from({ length: 1000 }, (_, i) => conversation(`c-${i}`)),
    );
    await fetchInboxSearchViaRpc(client, "QA", new AbortController().signal);
    expect(calls.map((call) => call.range)).toEqual([[0, 999], [1000, 1999]]);
  });

  it("does not query for an empty search or an already aborted request", async () => {
    const { client, rpc } = fakeClient([]);
    const signal = new AbortController().signal;
    expect(await fetchInboxSearchViaRpc(client, "   ", signal)).toEqual([]);
    const aborted = new AbortController();
    aborted.abort();
    expect(await fetchInboxSearchViaRpc(client, "Misael", aborted.signal)).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("propagates SQL permission or function errors; never silently broadens results", async () => {
    const { client } = fakeClient([], { message: "permission denied" });
    await expect(
      fetchInboxSearchViaRpc(client, "Misael", new AbortController().signal),
    ).rejects.toMatchObject({ message: "permission denied" });
  });

  it("keeps original name/username/message search and formatted exact-number matches", () => {
    const row = conversation("misael");
    expect(matchesInboxRpcSearch(row, "misael")).toBe(true);
    expect(matchesInboxRpcSearch(row, "misael_qat")).toBe(true);
    expect(matchesInboxRpcSearch(row, "Referencia")).toBe(true);
    expect(matchesInboxRpcSearch(row, "51981629790")).toBe(true);
    expect(matchesInboxRpcSearch(row, "+51 (981) 629-790")).toBe(true);
    expect(matchesInboxRpcSearch(row, "1234567")).toBe(false);
    expect(matchesInboxRpcSearch(row, "999999999")).toBe(false);
  });
});
