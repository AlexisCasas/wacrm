"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, History, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { useTranslations } from "next-intl";
import type { Profile } from "@/types";
import type { CallingCallRecord } from "@/hooks/use-whatsapp-calling";

interface CallHistoryProps {
  conversationId: string;
  profilesByUserId: Map<string, Profile>;
  currentUserId?: string;
  refreshToken?: number;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds < 0) return "—";
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

export function CallHistory({
  conversationId,
  profilesByUserId,
  currentUserId,
  refreshToken = 0,
}: CallHistoryProps) {
  const t = useTranslations("Inbox.callControls");
  const [calls, setCalls] = useState<CallingCallRecord[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);

  const loadHistory = useCallback(async () => {
    if (!conversationId) return;
    setLoading(true);
    try {
      const response = await fetch(
        `/api/whatsapp/calls?conversation_id=${encodeURIComponent(conversationId)}`,
        { cache: "no-store" },
      );
      if (!response.ok) return;
      const payload = await response.json().catch(() => ({}));
      setCalls(Array.isArray(payload.calls) ? payload.calls as CallingCallRecord[] : []);
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const response = await fetch(
          `/api/whatsapp/calls?conversation_id=${encodeURIComponent(conversationId)}`,
          { cache: "no-store" },
        );
        if (!response.ok || cancelled) return;
        const payload = await response.json().catch(() => ({}));
        if (!cancelled) setCalls(Array.isArray(payload.calls) ? payload.calls as CallingCallRecord[] : []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    setLoading(true);
    void load();
    const interval = window.setInterval(() => void load(), 15_000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [conversationId, refreshToken]);

  if (!calls.length && !loading) return null;

  return (
    <div className="shrink-0 border-b border-border bg-card/80 px-3 py-1.5 sm:px-4" data-testid="call-history">
      <div className="flex items-center justify-between">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="text-muted-foreground"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {loading ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <History className="mr-1.5 h-3 w-3" />}
          {t("history")} {calls.length > 0 ? `(${calls.length})` : ""}
        </Button>
        {expanded && (
          <Button type="button" variant="ghost" size="xs" onClick={() => void loadHistory()} disabled={loading}>
            {t("refreshHistory")}
          </Button>
        )}
      </div>
      {expanded && calls.length > 0 && (
        <ul className="max-h-40 space-y-2 overflow-y-auto pb-2 pt-1">
          {calls.map((call) => {
            const agentId = call.direction === "BUSINESS_INITIATED"
              ? call.initiated_by_user_id
              : call.accepted_by_user_id ?? call.rejected_by_user_id;
            const agent = agentId === currentUserId
              ? t("you")
              : (agentId ? profilesByUserId.get(agentId)?.full_name : null) || t("unknownAgent");
            const isOutbound = call.direction === "BUSINESS_INITIATED";
            const status = call.state === "connected" || call.state === "terminated"
              ? (call.duration_seconds && call.duration_seconds > 0 ? t("completed") : t("ended"))
              : call.state === "rejected" ? t("rejected")
              : call.state === "failed" ? t("failed")
              : t("notConnected");
            return (
              <li key={call.call_id} className="flex items-center justify-between gap-3 text-xs">
                <div className="flex min-w-0 items-center gap-2">
                  {isOutbound
                    ? <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-primary" />
                    : <ArrowDownLeft className="h-3.5 w-3.5 shrink-0 text-emerald-500" />}
                  <div className="min-w-0">
                    <p className="truncate text-foreground">
                      {isOutbound ? t("outgoing") : t("incoming")} · {agent}
                    </p>
                    <p className="text-muted-foreground">
                      {format(new Date(call.started_at || call.created_at), "dd/MM/yyyy HH:mm")}
                    </p>
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-foreground">{status}</p>
                  <p className="text-muted-foreground">{formatDuration(call.duration_seconds)}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
