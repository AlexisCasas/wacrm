"use client";

import { useEffect } from "react";

import { ORDERS_CHANGED_EVENT } from "@/components/orders/order-history";
import { createClient } from "@/lib/supabase/client";

/**
 * Comercial -> Logistica handoff, immediate effect in the Inbox (migration 20261127000000).
 *
 * Confirming an order successfully makes the confirm dialog fire the EXISTING ORDERS_CHANGED_EVENT. From that moment row-level security hides the
 * conversation from a commercial user, but Realtime does not announce rows that merely stop being visible. So, when the event fires, ask the
 * database once more for the open conversation: if it is no longer returned (and the query itself did not fail), `onGone` removes it from the
 * list and closes the thread without a page reload. Logistics, supervisors and accounts without logistics_mvp_enabled still get the row back, so
 * nothing changes for them. The event is only fired after the order was persisted: a failed confirmation never removes the chat.
 */
export function useHandoffConversationGuard(conversationId: string | null | undefined, onGone: (conversationId: string) => void): void {
  useEffect(() => {
    if (!conversationId) return;
    const check = async () => {
      const { data, error } = await createClient().from("conversations").select("id").eq("id", conversationId).maybeSingle();
      if (!error && !data) onGone(conversationId);
    };
    window.addEventListener(ORDERS_CHANGED_EVENT, check);
    return () => window.removeEventListener(ORDERS_CHANGED_EVENT, check);
  }, [conversationId, onGone]);
}
