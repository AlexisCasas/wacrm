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
 * Paging preserves results beyond PostgREST's 1,000-row default cap. A
 * deterministic ID tiebreaker avoids skipping tied last_message_at rows.
 */
export async function fetchInboxSearchViaRpc(
  supabase: SupabaseClient,
  term: string,
  signal: AbortSignal,
  onRequest: () => void = () => {},
): Promise<Parameters<typeof normalizeConversations>[0]> {
  if (!term.trim() || signal.aborted) return [];

  const rows: Parameters<typeof normalizeConversations>[0] = [];
  for (let from = 0; ; from += INBOX_SEARCH_PAGE_SIZE) {
    if (signal.aborted) return rows;
    onRequest();

    const { data, error } = await supabase
      .rpc("search_inbox_conversations", { p_search: term.trim() })
      .select(INBOX_CONVERSATION_SELECT)
      .order("last_message_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + INBOX_SEARCH_PAGE_SIZE - 1)
      .abortSignal(signal);

    if (error) throw error;
    const page = (data ?? []) as unknown as Parameters<typeof normalizeConversations>[0];
    rows.push(...page);
    if (page.length < INBOX_SEARCH_PAGE_SIZE) return rows;
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
