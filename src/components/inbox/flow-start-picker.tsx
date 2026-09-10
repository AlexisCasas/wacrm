"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Loader2, Zap } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface FlowListRow {
  id: string;
  name: string;
  status: "draft" | "active" | "archived";
  trigger_type: "keyword" | "first_inbound_message" | "manual";
}

interface FlowStartPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  contactDisplayName: string;
  /** Best-effort refresh — fired after a successful start. */
  onStarted?: () => void;
}

/**
 * "Iniciar Flow" — P0 manual flow start from the Inbox. Lists every
 * ACTIVE flow for the account regardless of trigger_type (keyword,
 * manual, first_inbound_message all appear — only draft/archived are
 * excluded), lets the agent search + pick one, confirms, then starts
 * it for the open conversation's contact via
 * POST /api/flows/[id]/start.
 *
 * Reuses GET /api/flows and filters client-side rather than adding a
 * status filter server-side — the account's flow count (tens, not
 * thousands) makes that unnecessary.
 */
export function FlowStartPicker({
  open,
  onOpenChange,
  conversationId,
  contactDisplayName,
  onStarted,
}: FlowStartPickerProps) {
  const t = useTranslations("Inbox.flowStartPicker");
  const [flows, setFlows] = useState<FlowListRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<FlowListRow | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(null);
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await fetch("/api/flows", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok) {
          setFlows((data.flows as FlowListRow[]) ?? []);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const activeFlows = useMemo(
    () => flows.filter((f) => f.status === "active"),
    [flows],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return activeFlows;
    return activeFlows.filter((f) => f.name.toLowerCase().includes(q));
  }, [activeFlows, query]);

  async function handleConfirm() {
    if (!selected || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/flows/${selected.id}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.code === "active_flow_exists") {
          toast.error(
            t("errorActiveFlow", { flowName: data.active_flow_name ?? "" }),
          );
        } else if (data.code === "service_window_expired") {
          toast.error(t("errorServiceWindow"));
        } else if (data.code === "contact_blocked") {
          // P0 contact blocking — a stale Inbox tab picked a Flow for
          // a contact that got blocked meanwhile. Never confirm as if
          // it started.
          toast.error(t("errorContactBlocked"));
        } else if (data.code === "flow_failed_immediately") {
          // P1 bug #2 — the run WAS created and DID run (it's kept for
          // audit server-side), but it ended in status='failed' before
          // ever suspending. Never show the success toast, never call
          // onStarted(), never close the dialog — the agent stays on
          // the confirm screen so they can see something went wrong
          // and decide whether to retry or pick a different flow. No
          // internal detail (end_reason, exception, Meta error) is
          // available here — the route never sends it.
          toast.error(t("errorFailedImmediately"));
        } else {
          toast.error(t("errorGeneric"));
        }
        return;
      }
      toast.success(t("successToast", { flowName: data.flow_name ?? selected.name }));
      onOpenChange(false);
      onStarted?.();
    } catch {
      toast.error(t("errorGeneric"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {selected && (
              <button
                type="button"
                onClick={() => setSelected(null)}
                aria-label={t("back")}
                className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            {t("title")}
          </DialogTitle>
        </DialogHeader>

        {selected ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-foreground">
              {t("confirmDescription", {
                flowName: selected.name,
                contactName: contactDisplayName,
              })}
            </p>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setSelected(null)}
                disabled={submitting}
              >
                {t("cancel")}
              </Button>
              <Button type="button" onClick={handleConfirm} disabled={submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t("starting")}
                  </>
                ) : (
                  t("confirm")
                )}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("searchPlaceholder")}
              autoFocus
            />
            <div className="max-h-[60vh] overflow-y-auto">
              {loading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : filtered.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {t("empty")}
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {filtered.map((flow) => (
                    <li key={flow.id}>
                      <button
                        type="button"
                        onClick={() => setSelected(flow)}
                        className="flex w-full items-center gap-2 rounded-md border border-border bg-muted/40 p-2.5 text-left hover:border-primary/50 hover:bg-muted"
                      >
                        <Zap className="h-4 w-4 shrink-0 text-primary" />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                          {flow.name}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
