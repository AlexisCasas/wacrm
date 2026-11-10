import type { SupabaseClient } from "@supabase/supabase-js";
import type { Message } from "@/types";

/**
 * Windowed message history for a conversation.
 *
 * PostgREST caps every response at `PGRST_DB_MAX_ROWS` (1000 in production). The thread used to ask for the whole conversation in
 * ascending order, so a conversation with more than 1000 messages silently lost its NEWEST messages. The thread now loads the latest
 * page (newest first, so the cap can only ever cut old history) and pages backwards with a (created_at, id) keyset cursor.
 */
export const INBOX_PAGE_SIZE = 100;

const isOptimistic = (message: Message) => message.id.startsWith("temp-");
const time = (message: Message) => {
  const parsed = Date.parse(message.created_at);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/** Chronological order; ties broken by id so the order is stable. Optimistic (not yet persisted) messages always sit last. */
export function compareMessages(a: Message, b: Message): number {
  const aTemp = isOptimistic(a);
  const bTemp = isOptimistic(b);
  if (aTemp !== bTemp) return aTemp ? 1 : -1;
  const byTime = time(a) - time(b);
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Union by id (the incoming, fresher row wins), chronologically sorted. Never drops a row that is only in `existing`. */
export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const message of existing) byId.set(message.id, message);
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort(compareMessages);
}

export interface LatestPageResult {
  messages: Message[];
  hasMoreOlder: boolean;
}

/**
 * Combine a freshly fetched latest page with what the thread already holds (resync after a reconnect / tab focus / manual refresh).
 * Older pages the reader already loaded and recent realtime rows are kept. The one exception is a GAP: if even the oldest row of the
 * fresh page is newer than everything we hold and there is more history behind it, merging would leave a hole in the middle of the
 * thread, so the window restarts from the fresh page (the reader can page back again).
 */
export function applyLatestPage(args: {
  existing: Message[];
  latest: Message[];
  latestHasMoreOlder: boolean;
  existingHasMoreOlder: boolean;
}): LatestPageResult {
  const persisted = args.existing.filter((message) => !isOptimistic(message));
  if (persisted.length === 0) {
    return { messages: mergeMessages(args.existing, args.latest), hasMoreOlder: args.latestHasMoreOlder };
  }
  const newestHeld = Math.max(...persisted.map(time));
  const oldestFresh = args.latest.length > 0 ? Math.min(...args.latest.map(time)) : Number.NEGATIVE_INFINITY;
  if (args.latestHasMoreOlder && args.latest.length > 0 && oldestFresh > newestHeld) {
    const optimistic = args.existing.filter(isOptimistic);
    return { messages: mergeMessages(optimistic, args.latest), hasMoreOlder: true };
  }
  return { messages: mergeMessages(args.existing, args.latest), hasMoreOlder: args.existingHasMoreOlder };
}

export interface MessageCursor {
  created_at: string;
  id: string;
}

/** The oldest persisted message currently held: the cursor for "load older". */
export function oldestCursor(messages: Message[]): MessageCursor | null {
  const persisted = messages.filter((message) => !isOptimistic(message));
  if (persisted.length === 0) return null;
  const oldest = [...persisted].sort(compareMessages)[0];
  return { created_at: oldest.created_at, id: oldest.id };
}

export interface PageFetchResult {
  messages: Message[];
  hasMoreOlder: boolean;
  error: { message: string } | null;
}

async function fetchPage(supabase: SupabaseClient, conversationId: string, before: MessageCursor | null): Promise<PageFetchResult> {
  let query = supabase.from("messages").select("*").eq("conversation_id", conversationId);
  if (before) {
    // Strictly older than the cursor, with the id as tiebreaker for rows sharing a timestamp. Values are quoted for the filter grammar.
    query = query.or(`created_at.lt."${before.created_at}",and(created_at.eq."${before.created_at}",id.lt."${before.id}")`);
  }
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(INBOX_PAGE_SIZE + 1);
  if (error) return { messages: [], hasMoreOlder: false, error: { message: error.message } };
  const rows = (data ?? []) as Message[];
  const page = rows.slice(0, INBOX_PAGE_SIZE);
  return { messages: page.sort(compareMessages), hasMoreOlder: rows.length > INBOX_PAGE_SIZE, error: null };
}

/** The newest INBOX_PAGE_SIZE messages of the conversation (chronological). */
export const fetchLatestPage = (supabase: SupabaseClient, conversationId: string) => fetchPage(supabase, conversationId, null);

/** The INBOX_PAGE_SIZE messages immediately older than `before` (chronological). */
export const fetchOlderPage = (supabase: SupabaseClient, conversationId: string, before: MessageCursor) => fetchPage(supabase, conversationId, before);
