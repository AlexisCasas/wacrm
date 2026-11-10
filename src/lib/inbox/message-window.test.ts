import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Message } from "@/types";
import {
  INBOX_PAGE_SIZE,
  applyLatestPage,
  compareMessages,
  fetchLatestPage,
  fetchOlderPage,
  mergeMessages,
  oldestCursor,
} from "./message-window";

const PGRST_MAX_ROWS = 1000;

function msg(n: number, over: Partial<Message> = {}): Message {
  return {
    id: `m-${String(n).padStart(5, "0")}`,
    conversation_id: "conv-1",
    sender_type: "customer",
    content_type: "text",
    content_text: `t${n}`,
    status: "delivered",
    created_at: new Date(Date.UTC(2026, 10, 9, 0, 0, 0) + n * 1000).toISOString(),
    ...over,
  };
}
const thread = (count: number): Message[] => Array.from({ length: count }, (_, i) => msg(i + 1));

/** A fake PostgREST over one table: eq/or/order/order/limit with the production row cap. Only the shapes message-window.ts builds. */
function fakeSupabase(rows: Message[], opts: { cap?: number } = {}) {
  const calls: Array<{ or?: string; limit?: number; order: Array<[string, boolean]> }> = [];
  const client = {
    from: () => {
      const call: (typeof calls)[number] = { order: [] };
      calls.push(call);
      let conv: string | undefined;
      const builder = {
        select: () => builder,
        eq: (_col: string, value: string) => { conv = value; return builder; },
        or: (filter: string) => { call.or = filter; return builder; },
        order: (col: string, o: { ascending: boolean }) => { call.order.push([col, o.ascending]); return builder; },
        limit: (n: number) => { call.limit = n; return builder; },
        then: (resolve: (value: { data: Message[]; error: null }) => unknown) => {
          let out = rows.filter((r) => r.conversation_id === conv);
          if (call.or) {
            const m = /created_at\.lt\."(.+?)",and\(created_at\.eq\."(.+?)",id\.lt\."(.+?)"\)/.exec(call.or)!;
            const [, ltTime, eqTime, ltId] = m;
            out = out.filter((r) => Date.parse(r.created_at) < Date.parse(ltTime) || (Date.parse(r.created_at) === Date.parse(eqTime) && r.id < ltId));
          }
          const [col, asc] = call.order[0] ?? ["created_at", true];
          out = [...out].sort((a, b) => (asc ? 1 : -1) * (col === "created_at" ? Date.parse(a.created_at) - Date.parse(b.created_at) || (a.id < b.id ? -1 : 1) : 0));
          // id is the second sort key (same direction), applied by the stable sort above through the tiebreak.
          const limit = Math.min(call.limit ?? Infinity, opts.cap ?? PGRST_MAX_ROWS);
          return Promise.resolve({ data: out.slice(0, limit), error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

describe("the defect: ascending + 1000-row cap hides the newest messages", () => {
  it("reproduces it on a 1,239-message conversation (the old query shape), and shows the newest 100 with the new one", async () => {
    const all = thread(1239);
    const yape = all[all.length - 1];
    // OLD: order created_at ascending, no limit -> the server cuts at 1000 and returns the OLDEST 1000.
    const oldFake = fakeSupabase(all);
    const oldRows = await new Promise<Message[]>((resolve) => {
      const builder = (oldFake.client as unknown as { from: (t: string) => { select: () => { eq: (c: string, v: string) => { order: (c: string, o: { ascending: boolean }) => PromiseLike<{ data: Message[] }> } } } }).from("messages");
      builder.select().eq("conversation_id", "conv-1").order("created_at", { ascending: true }).then((r) => resolve(r.data));
    });
    expect(oldRows).toHaveLength(1000);
    expect(oldRows.some((r) => r.id === yape.id)).toBe(false);
    // NEW
    const page = await fetchLatestPage(fakeSupabase(all).client, "conv-1");
    expect(page.error).toBeNull();
    expect(page.messages).toHaveLength(INBOX_PAGE_SIZE);
    expect(page.messages.at(-1)!.id).toBe(yape.id);
    expect(page.messages[0].id).toBe(all[1239 - 100].id);
    expect(page.hasMoreOlder).toBe(true);
    expect(page.messages.map((m) => m.id)).toEqual([...page.messages].sort(compareMessages).map((m) => m.id));
  });

  it("asks for newest-first with a (created_at, id) tiebreak and one extra probe row", async () => {
    const fake = fakeSupabase(thread(5));
    await fetchLatestPage(fake.client, "conv-1");
    expect(fake.calls[0].order).toEqual([["created_at", false], ["id", false]]);
    expect(fake.calls[0].limit).toBe(INBOX_PAGE_SIZE + 1);
    expect(fake.calls[0].or).toBeUndefined();
  });
});

describe("paging backwards", () => {
  it("walks the whole 1,239-message history once: no gaps, no repeats, correct order, ends cleanly", async () => {
    const all = thread(1239);
    const fake = fakeSupabase(all);
    let held: Message[] = [];
    let page = await fetchLatestPage(fake.client, "conv-1");
    held = mergeMessages(held, page.messages);
    let pages = 1;
    while (page.hasMoreOlder) {
      const cursor = oldestCursor(held)!;
      page = await fetchOlderPage(fake.client, "conv-1", cursor);
      expect(page.error).toBeNull();
      held = mergeMessages(held, page.messages);
      pages += 1;
      expect(pages).toBeLessThan(40);
    }
    expect(pages).toBe(13); // 12 full pages + 39 remaining
    expect(held.map((m) => m.id)).toEqual(all.map((m) => m.id));
  });

  it("messages sharing the same timestamp are neither skipped nor repeated across a page boundary", async () => {
    const sameSecond = Date.UTC(2026, 10, 9, 12, 0, 0);
    const rows = Array.from({ length: 250 }, (_, i) => msg(i + 1, { created_at: new Date(sameSecond + Math.floor(i / 5) * 1000).toISOString() }));
    const fake = fakeSupabase(rows);
    let held: Message[] = [];
    let page = await fetchLatestPage(fake.client, "conv-1");
    held = mergeMessages(held, page.messages);
    while (page.hasMoreOlder) {
      page = await fetchOlderPage(fake.client, "conv-1", oldestCursor(held)!);
      held = mergeMessages(held, page.messages);
    }
    expect(held).toHaveLength(250);
    expect(new Set(held.map((m) => m.id)).size).toBe(250);
  });

  it("uses a strict cursor filter with quoted values", async () => {
    const fake = fakeSupabase(thread(300));
    await fetchOlderPage(fake.client, "conv-1", { created_at: "2026-11-09T00:01:00.000Z", id: "m-00060" });
    expect(fake.calls[0].or).toBe('created_at.lt."2026-11-09T00:01:00.000Z",and(created_at.eq."2026-11-09T00:01:00.000Z",id.lt."m-00060")');
  });

  it("reports an error without throwing", async () => {
    const failing = { from: () => { const b = { select: () => b, eq: () => b, or: () => b, order: () => b, limit: () => b, then: (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "boom" } }).then(r) }; return b; } } as unknown as SupabaseClient;
    expect(await fetchLatestPage(failing, "conv-1")).toEqual({ messages: [], hasMoreOlder: false, error: { message: "boom" } });
  });
});

describe("mergeMessages / ordering", () => {
  it("union by id, fresher row wins, chronological, optimistic rows last", () => {
    const a = thread(3);
    const optimistic = msg(99, { id: "temp-1" });
    const merged = mergeMessages([optimistic, a[2], a[0]], [{ ...a[1], status: "read" }, { ...a[2], status: "read" }]);
    expect(merged.map((m) => m.id)).toEqual(["m-00001", "m-00002", "m-00003", "temp-1"]);
    expect(merged.find((m) => m.id === "m-00003")!.status).toBe("read");
  });
  it("never drops a row that only exists locally", () => {
    const held = thread(10);
    expect(mergeMessages(held, thread(3)).map((m) => m.id)).toEqual(held.map((m) => m.id));
  });
});

describe("applyLatestPage (resync)", () => {
  it("overlapping window: keeps older pages already loaded and adds the new rows", () => {
    const held = thread(300).slice(50); // rows 51..300 (older pages loaded)
    const latest = [...thread(320).slice(220)]; // rows 221..320: overlaps with held
    const out = applyLatestPage({ existing: held, latest, latestHasMoreOlder: true, existingHasMoreOlder: true });
    expect(out.messages).toHaveLength(270); // 51..320
    expect(out.messages[0].id).toBe("m-00051");
    expect(out.messages.at(-1)!.id).toBe("m-00320");
    expect(out.hasMoreOlder).toBe(true);
  });
  it("keeps hasMoreOlder=false once the start of the thread was loaded", () => {
    const out = applyLatestPage({ existing: thread(150), latest: thread(160).slice(60), latestHasMoreOlder: true, existingHasMoreOlder: false });
    expect(out.hasMoreOlder).toBe(false);
    expect(out.messages).toHaveLength(160);
  });
  it("gap: the fresh page does not reach what we hold and more history exists -> window restarts, optimistic rows kept", () => {
    const held = [...thread(10), msg(500, { id: "temp-x" })];
    const latest = thread(400).slice(300); // rows 301..400
    const out = applyLatestPage({ existing: held, latest, latestHasMoreOlder: true, existingHasMoreOlder: false });
    expect(out.messages.map((m) => m.id)).toEqual([...latest.map((m) => m.id), "temp-x"]);
    expect(out.hasMoreOlder).toBe(true);
  });
  it("detects a resync gap even when both windows share the same created_at", () => {
    // Postgres now() is transaction-stable; bulk inserts may share a timestamp.
    // Distinct UUID/id ordering must still detect >100 unseen messages.
    const stamp = "2026-11-09T12:00:00.000Z";
    const held = thread(5).map((row) => ({ ...row, created_at: stamp }));
    const latest = thread(220).slice(120).map((row) => ({ ...row, created_at: stamp }));
    const out = applyLatestPage({
      existing: held,
      latest,
      latestHasMoreOlder: true,
      existingHasMoreOlder: false,
    });
    expect(out.messages.map((row) => row.id)).toEqual(latest.map((row) => row.id));
    expect(out.hasMoreOlder).toBe(true);
  });

  it("no gap when the whole thread fit in the fresh page", () => {
    const out = applyLatestPage({ existing: thread(3), latest: thread(8), latestHasMoreOlder: false, existingHasMoreOlder: false });
    expect(out.messages).toHaveLength(8);
  });
  it("empty held thread takes the fresh page as is", () => {
    const latest = thread(100);
    expect(applyLatestPage({ existing: [], latest, latestHasMoreOlder: true, existingHasMoreOlder: false })).toEqual({ messages: latest, hasMoreOlder: true });
  });
});

describe("oldestCursor", () => {
  it("ignores optimistic rows; null for an empty or optimistic-only thread", () => {
    expect(oldestCursor([])).toBeNull();
    expect(oldestCursor([msg(1, { id: "temp-1" })])).toBeNull();
    expect(oldestCursor([msg(5), msg(2), msg(9, { id: "temp-2" })])).toEqual({ created_at: msg(2).created_at, id: "m-00002" });
  });
});
