"use client";

import { useEffect, useRef, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import type { RoutingState } from "@/lib/conversations/routing-types";

/**
 * Operational stage of the open conversation (commercial | logistics | shared) for the Inbox sidebar, from GET /api/conversations/[id]/routing.
 * It refreshes by itself when the routing row changes (Realtime `postgres_changes` on conversation_routing, filtered by RLS like everything else),
 * so a "Derivar a Comercial" done in another tab, or by a supervisor, shows up without F5. `null` while unknown; `{ enabled: false }` (flag OFF)
 * and any failure render nothing: the legacy Inbox is untouched.
 */
export function useConversationRouting(conversationId: string | null | undefined): { state: RoutingState | null; refresh: () => void } {
  const [answer, setAnswer] = useState<{ id: string; state: RoutingState | null } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    let latest = 0;
    const run = async () => {
      const mine = ++latest;
      let state: RoutingState | null = null;
      try {
        const res = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/routing`, { cache: "no-store" });
        if (res.ok) state = (await res.json()) as RoutingState;
      } catch {
        state = null;
      }
      if (!cancelled && mine === latest) setAnswer({ id: conversationId, state });
    };
    void run();
    const supabase = createClient();
    const channel = supabase
      .channel(`routing:${conversationId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "conversation_routing", filter: `conversation_id=eq.${conversationId}` }, () => void run())
      .subscribe();
    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [conversationId, tick]);

  // An answer belongs to ONE conversation: never show another conversation's stage.
  return { state: conversationId && answer?.id === conversationId ? answer.state : null, refresh: () => setTick((t) => t + 1) };
}

/**
 * Inbox list: a conversation that becomes `shared` is announced to Comercial through its routing row (Realtime evaluates the policy on the NEW
 * row version, so the commercial user starts receiving it). `onChange` receives the conversation id so the page can hydrate it into the list.
 * Rows that stop being visible (commercial -> logistics) are not announced by Realtime; the confirm flow already removes them (see
 * useHandoffConversationGuard).
 */
export function useRoutingStageEvents(onChange: (conversationId: string) => void): void {
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("routing-stage-events")
      .on("postgres_changes", { event: "*", schema: "public", table: "conversation_routing" }, (payload) => {
        const row = payload.new as { conversation_id?: string } | null;
        if (row && typeof row.conversation_id === "string") latest.current(row.conversation_id);
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, []);
}
