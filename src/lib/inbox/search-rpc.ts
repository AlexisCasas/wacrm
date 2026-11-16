import type { SupabaseClient } from "@supabase/supabase-js";
import type { Conversation } from "@/types";
import { contactSearchText } from "@/lib/contacts/display";
import { normalizePhone } from "@/lib/whatsapp/phone-utils";
import { INBOX_CONVERSATION_SELECT, normalizeConversations } from "@/lib/inbox/conversations";

export const INBOX_SEARCH_PAGE_SIZE = 1_000;
const PHONE_LOOKING_TERM = /^[+() .0-9-]+$/;

/**
 * Read-only RPC alternative to the two-branch Inbox search.
 *
 * Can only be used after public.search_inbox_conversations(text) has passed
 * isolated RLS/contract QA and has been deployed. The UI keeps this off by
 * default using NEXT_PUBLIC_SEARCH01_INBOX_RPC.
 *
 * Server-side keyset pagination preserves results past PostgREST's 1,000
 * row cap. The SQL RPC orders by last_message_at DESC NULLS LAST, id ASC.
 * Each call advances using the final row's timestamp + unique UUID, so
 * identical timestamps never cause OFFSET loss or work proportional to
 * the page number. The SQL search still needs an RLS performance gate.
 */
export async function fetchInboxSearchViaRpc(
  supabase: SupabaseClient,
  term: string,
  signal: AbortSignal,
  onRequest: () => void = () => {},
): Promise<Parameters<typeof normalizeConversations>[0]> {
  if (!term.trim() || signal.aborted) return [];

  const rows: Parameters<typeof normalizeConversations>[0] = [];
  const seenIds = new Set<string>();
  let cursorLastMessageAt: string | null = null;
  let cursorId: string | null = null;

  for (;;) {
    if (signal.aborted) return [];
    onRequest();

    const { data, error } = await supabase
      .rpc("search_inbox_conversations_page", {
        p_search: term.trim(),
        p_cursor_last_message_at: cursorLastMessageAt,
        p_cursor_id: cursorId,
        p_page_size: INBOX_SEARCH_PAGE_SIZE,
      })
      .select(INBOX_CONVERSATION_SELECT)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true })
      .abortSignal(signal);

    if (signal.aborted) return [];
    if (error) throw error;

    const page = (data ?? []) as unknown as Parameters<typeof normalizeConversations>[0];
    if (page.length > INBOX_SEARCH_PAGE_SIZE) {
      throw new Error("Inbox search RPC returned more than the allowed page size");
    }

    // A page response must have stable UUIDs. A duplicate across calls
    // signals a cursor/ordering contract regression; fail rather than
    // silently dropping or duplicating conversations.
    for (const row of page) {
      if (!row.id || seenIds.has(row.id)) {
        throw new Error("Inbox search RPC returned a missing or repeated conversation ID");
      }
      seenIds.add(row.id);
    }
    rows.push(...page);
    if (page.length < INBOX_SEARCH_PAGE_SIZE) return rows;

    const last = page[page.length - 1];
    const nextAt = last.last_message_at ?? null;
    if (cursorId === last.id && cursorLastMessageAt === nextAt) {
      throw new Error("Inbox search RPC cursor did not advance");
    }
    cursorId = last.id;
    cursorLastMessageAt = nextAt;
  }
}

/**
 * Preserve the existing name/phone/wa_username/last-message filter and
 * retain the additive exact normalized-phone match from the RPC.
 * No phone-number identity is inferred for BSUID-only contacts.
 */
export function matchesInboxRpcSearch(
  conversation: Conversation,
  term: string,
): boolean {
  const q = term.trim().toLowerCase();
  if (!q) return true;

  const contact = conversation.contact;
  if ((contact?.name?.toLowerCase() ?? "").includes(q)) return true;
  if (contactSearchText(contact).includes(q)) return true;
  if ((conversation.last_message_text?.toLowerCase() ?? "").includes(q)) return true;

  if (!PHONE_LOOKING_TERM.test(q)) return false;
  const digits = normalizePhone(q);
  return digits.length >= 7 && normalizePhone(contact?.phone ?? "") === digits;
}
