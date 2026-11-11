"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Pause, Play, Zap } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ORDERS_CHANGED_EVENT } from "@/components/orders/order-history";
import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";

interface ContactAutomationToggleProps {
  contactId: string;
}

/**
 * Inbox sidebar "AUTOMATIZACIONES": pauses/resumes NEW keyword-triggered automation (Flows by keyword + `keyword_match` automations) for this
 * contact only. Read through RLS, written through PUT /api/contacts/[id]/automation-pause (agent+). It never touches running flows or waits.
 * Confirming an order pauses it on the server (create_order_confirmation); the ORDERS_CHANGED_EVENT the confirm dialog already dispatches makes it
 * re-read the state, so "Pausar" turns into "Reanudar" without a reload. The sidebar keys it by contact id and the state also remembers which contact it was loaded for, so a previous contact's state is never shown.
 */
export function ContactAutomationToggle({ contactId }: ContactAutomationToggleProps) {
  const t = useTranslations("Inbox.sidebar");
  const { canSendMessages } = useAuth();
  const supabase = useMemo(() => createClient(), []);

  const [state, setState] = useState<{ contactId: string; paused: boolean } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  // Bumped when an order is confirmed: confirming stops this contact's automations on the server, so the state is read again at once.
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    const onOrderChanged = () => setReloadTick((n) => n + 1);
    window.addEventListener(ORDERS_CHANGED_EVENT, onOrderChanged);
    return () => window.removeEventListener(ORDERS_CHANGED_EVENT, onOrderChanged);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data, error } = await supabase
          .from("contact_automation_settings")
          .select("keyword_automations_paused")
          .eq("contact_id", contactId)
          .maybeSingle();
        if (cancelled) return;
        if (error) {
          setLoadError(true);
          return;
        }
        setLoadError(false);
        setState({ contactId, paused: data?.keyword_automations_paused === true });
      } catch {
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [contactId, supabase, reloadTick]);

  async function toggle(next: boolean) {
    if (busy || !canSendMessages) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/contacts/${contactId}/automation-pause`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: next }),
      });
      if (!res.ok) throw new Error(`status_${res.status}`);
      // Only a confirmed write changes what is shown: no optimistic state.
      setState({ contactId, paused: next });
      toast.success(t(next ? "automationsToastPaused" : "automationsToastResumed"));
    } catch {
      toast.error(t("automationsError"));
    } finally {
      setBusy(false);
    }
  }

  const ready = state !== null && state.contactId === contactId;
  const paused = ready && state.paused;

  return (
    <section aria-label={t("automationsTitle")} data-testid="contact-automations">
      <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <Zap className="h-3 w-3" />
        {t("automationsTitle")}
      </div>
      <div className="mt-2 space-y-2 px-1">
        {loadError ? (
          <p className="text-xs text-destructive">{t("automationsLoadError")}</p>
        ) : !ready ? (
          <div className="flex justify-center py-2" role="status">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground" data-testid="automations-status">
              {t(paused ? "automationsPausedState" : "automationsActive")}
            </p>
            {canSendMessages && (
              <Button type="button" size="sm" variant="outline" className="w-full"
                disabled={busy} onClick={() => toggle(!paused)}>
                {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> :
                  paused ? <Play className="mr-1 h-3.5 w-3.5" /> : <Pause className="mr-1 h-3.5 w-3.5" />}
                {t(paused ? "automationsResume" : "automationsPause")}
              </Button>
            )}
            <p className="text-[10px] text-muted-foreground">{t("automationsHint")}</p>
          </>
        )}
      </div>
    </section>
  );
}
