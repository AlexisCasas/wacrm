"use client";

import { useEffect, useState } from "react";
import { PhoneIncoming } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCan } from "@/hooks/use-can";

type IncomingAlert = {
  conversation_id: string;
  customer_name: string | null;
  created_at: string;
  expires_at: string;
};

interface GlobalIncomingCallAlertProps {
  activeConversationId: string | null;
  onOpenConversation: (conversationId: string) => void;
  /** Test seam: only overrides polling transport; no signaling or microphone. */
  fetchCalls?: typeof fetch;
}

const POLL_MS = 2_500;
// The incoming offer is short-lived. Never prompt the agent to switch
// conversations if the remaining lifetime cannot cover mic acquisition
// plus the safety margin enforced by CallingPanel.
const MIN_REMAINING_MS = 20_000;

export function GlobalIncomingCallAlert({
  activeConversationId,
  onOpenConversation,
  fetchCalls,
}: GlobalIncomingCallAlertProps) {
  const t = useTranslations("Inbox.calling");
  const canUseCalling = useCan("send-messages");
  const [calls, setCalls] = useState<IncomingAlert[]>([]);
  const [checkedAt, setCheckedAt] = useState(0);

  useEffect(() => {
    if (!canUseCalling) return;
    let mounted = true;
    let busy = false;

    const poll = async () => {
      if (busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const response = await (fetchCalls ?? fetch)("/api/whatsapp/calls?inbox_alerts=1", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) throw new Error("inbox_call_alert_request_failed");
        const data: unknown = await response.json();
        const list = typeof data === "object" && data !== null && "calls" in data
          ? (data as { calls: unknown }).calls : null;
        if (mounted) {
          setCalls(Array.isArray(list) ? list as IncomingAlert[] : []);
          setCheckedAt(Date.now());
        }
      } catch {
        // Transient failure: do not surface an old offer as a fresh call.
        if (mounted) {
          setCalls([]);
          setCheckedAt(Date.now());
        }
      } finally {
        busy = false;
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      mounted = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [canUseCalling, fetchCalls]);

  if (!canUseCalling) return null;

  const next = calls.find((call) =>
    typeof call?.conversation_id === "string" &&
    call.conversation_id !== activeConversationId &&
    typeof call.expires_at === "string" &&
    Number.isFinite(Date.parse(call.expires_at)) &&
    Date.parse(call.expires_at) - checkedAt >= MIN_REMAINING_MS
  );

  if (!next) return null;

  const name = next.customer_name?.trim() || t("incomingCall");

  return (
    <div role="alert" aria-live="polite" className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-emerald-500/40 bg-emerald-500/10 px-4 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <PhoneIncoming aria-hidden="true" className="h-5 w-5 shrink-0 animate-pulse text-emerald-500" />
        <span className="truncate text-sm font-medium">
          {t("incomingCall")}: {name}
        </span>
      </div>
      <button
        type="button"
        onClick={() => onOpenConversation(next.conversation_id)}
        className="shrink-0 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
      >
        {t("openIncomingConversation")}
      </button>
    </div>
  );
}
