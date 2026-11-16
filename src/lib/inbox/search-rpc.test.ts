import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Conversation } from "@/types";
import { INBOX_CONVERSATION_SELECT } from "@/lib/inbox/conversations";
import {
  fetchInboxSearchViaRpc,
  matchesInboxRpcSearch,
} from "@/lib/inbox/search-rpc";

function conversation(
  id: string,
  lastMessageAt: string | null = "2026-11-01T00:00:00Z",
): Conversation {
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
    ...(lastMessageAt === null ? {} : { last_message_at: lastMessageAt }),
    last_message_text: "Referencia 123456",
  };
}

type RpcParams = {
  p_search: string;
  p_cursor_last_message_at: string | null;
  p_cursor_id: string | null;
  p_page_size: number;
};

type Call = {
  name: string;
  params: RpcParams;
  selection?: string;
  orders: Array<[string, boolean, boolean | undefined]>;
  signal?: AbortSignal;
};

type MockRpcResult = {
  data: Conversation[] | null;
  error: { message: string } | null;
};

type MockRpcBuilder = {
  select: (selection: string) => MockRpcBuilder;
  order: (column: string, options: {
    ascending: boolean;
    nullsFirst?: boolean;
  }) => MockRpcBuilder;
  abortSignal: (signal: AbortSignal) => Promise<MockRpcResult>;
};

/** Matches the SQL keyset order: last_message_at DESC NULLS LAST, id ASC. */
function sortKeysetRows(rows: Conversation[]): Conversation[] {
  return [...rows].sort((a, b) => {
    const aAt = a.last_message_at ?? null;
    const bAt = b.last_message_at ?? null;
    if (aAt === null && bAt !== null) return 1;
    if (bAt === null && aAt !== null) return -1;
    if (aAt !== null && bAt !== null && aAt !== bAt) {
      return aAt > bAt ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function fakeClient(
  rows: Conversation[],
  failure?: { message: string },
  repeatFirstPage = false,
) {
  const calls: Call[] = [];
  const orderedRows = sortKeysetRows(rows);
  const rpc = vi.fn((name: string, params: RpcParams) => {
    const call: Call = { name, params, orders: [] };
    calls.push(call);
    const builder: MockRpcBuilder = {
      select(selection: string) {
        call.selection = selection;
        return builder;
      },
      order(column: string, options: { ascending: boolean; nullsFirst?: boolean }) {
        call.orders.push([column, options.ascending, options.nullsFirst]);
        return builder;
      },
      abortSignal(signal: AbortSignal) {
        call.signal = signal;
        if (failure) {
          return Promise.resolve({ data: null, error: failure });
        }
        const cursorId = params.p_cursor_id;
        const cursorAt = params.p_cursor_last_message_at;
        const filtered = orderedRows.filter((row) => {
          if (cursorId === null || repeatFirstPage) return true;
          const at = row.last_message_at ?? null;
          if (cursorAt === null) return at === null && row.id > cursorId;
          return (
            at === null ||
            at < cursorAt ||
            (at === cursorAt && row.id > cursorId)
          );
        });
        return Promise.resolve({
          data: filtered.slice(0, params.p_page_size),
          error: null,
        });
      },
    };
    return builder;
  });
  return { client: { rpc } as unknown as SupabaseClient, calls, rpc };
}

describe("SEARCH-01 read-only keyset Inbox RPC client", () => {
  it("does one query for one phone and preserves the contact/tag select", async () => {
    const { client, calls } = fakeClient([conversation("misael")]);
    const controller = new AbortController();
    const onRequest = vi.fn();
    const result = await fetchInboxSearchViaRpc(
      client,
      "981629790",
      controller.signal,
      onRequest,
    );

    expect(result.map((row) => row.id)).toEqual(["misael"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: "search_inbox_conversations_page",
      params: {
        p_search: "981629790",
        p_cursor_last_message_at: null,
        p_cursor_id: null,
        p_page_size: 1000,
      },
      selection: INBOX_CONVERSATION_SELECT,
      orders: [["last_message_at", false, false], ["id", true, undefined]],
      signal: controller.signal,
    });
    expect(onRequest).toHaveBeenCalledTimes(1);
  });

  it("paginates beyond 1,000 without LIMIT/OFFSET or dropped IDs", async () => {
    const rows = Array.from({ length: 1001 }, (_, i) =>
      conversation(`c-${String(i).padStart(5, "0")}`),
    );
    const { client, calls } = fakeClient(rows);
    const fetched = await fetchInboxSearchViaRpc(client, "QA", new AbortController().signal);
    expect(fetched).toHaveLength(1001);
    expect(new Set(fetched.map((x) => x.id)).size).toBe(1001);
    expect(calls).toHaveLength(2);
    expect(calls[1].params).toMatchObject({
      p_cursor_id: "c-00999",
      p_cursor_last_message_at: "2026-11-01T00:00:00Z",
    });
  });

  it("does not lose any of 12,000 conversations with the same timestamp", async () => {
    const rows = Array.from({ length: 12000 }, (_, i) =>
      conversation(`c-${String(i).padStart(5, "0")}`),
    );
    const { client, calls } = fakeClient(rows);
    const result = await fetchInboxSearchViaRpc(client, "ZZGRAN", new AbortController().signal);
    expect(result).toHaveLength(12000);
    expect(new Set(result.map((row) => row.id)).size).toBe(12000);
    expect(result[0].id).toBe("c-00000");
    expect(result[11999].id).toBe("c-11999");
    // Page 12 was full: page 13 detects completion.
    expect(calls).toHaveLength(13);
    expect(calls.map((call) => call.params.p_cursor_id)).toEqual([
      null,
      ...Array.from({ length: 12 }, (_, i) => `c-${String((i + 1) * 1000 - 1).padStart(5, "0")}`),
    ]);
  });

  it("handles last_message_at NULLS LAST, including a cursor in the null group", async () => {
    const rows = [
      ...Array.from({ length: 999 }, (_, i) =>
        conversation(`c-${String(i).padStart(5, "0")}`, "2026-11-01T00:00:00Z"),
      ),
      conversation("c-null-a", null),
      conversation("c-null-b", null),
    ];
    const { client, calls } = fakeClient(rows);
    const result = await fetchInboxSearchViaRpc(client, "QA", new AbortController().signal);
    expect(result).toHaveLength(1001);
    expect(result.at(-2)?.id).toBe("c-null-a");
    expect(result.at(-1)?.id).toBe("c-null-b");
    expect(calls[1].params).toMatchObject({
      p_cursor_id: "c-null-a",
      p_cursor_last_message_at: null,
    });
  });

  it("finishes after a full 1,000-row page with a separate empty page", async () => {
    const { client, calls } = fakeClient(
      Array.from({ length: 1000 }, (_, i) =>
        conversation(`c-${String(i).padStart(5, "0")}`),
      ),
    );
    expect(await fetchInboxSearchViaRpc(client, "QA", new AbortController().signal)).toHaveLength(1000);
    expect(calls).toHaveLength(2);
  });

  it("rejects a repeated page instead of silently looping", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) =>
      conversation(`c-${String(i).padStart(5, "0")}`),
    );
    const { client } = fakeClient(rows, undefined, true);
    await expect(
      fetchInboxSearchViaRpc(client, "QA", new AbortController().signal),
    ).rejects.toThrow(/missing or repeated conversation ID/);
  });

  it("does not query for empty or already cancelled searches", async () => {
    const { client, rpc } = fakeClient([]);
    expect(await fetchInboxSearchViaRpc(client, "   ", new AbortController().signal)).toEqual([]);
    const aborted = new AbortController();
    aborted.abort();
    expect(await fetchInboxSearchViaRpc(client, "QA", aborted.signal)).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("propagates SQL timeout/permission errors instead of returning partial results", async () => {
    const { client } = fakeClient([], { message: "57014 statement_timeout" });
    await expect(
      fetchInboxSearchViaRpc(client, "ZZGRAN", new AbortController().signal),
    ).rejects.toMatchObject({ message: "57014 statement_timeout" });
  });

  it("keeps name, username, message and normalized phone semantics", () => {
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
