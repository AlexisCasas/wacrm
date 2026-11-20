"use client";

import { useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useConversationRouting } from "@/hooks/use-conversation-routing";
import { formatLimaDateTime } from "@/lib/orders/history";

interface Props {
  conversationId?: string | null;
}

/**
 * "Derivar a Comercial" (logistics / supervisor, only while the chat is in the logistics stage): hands the SAME chat to Comercial for a NEW sale
 * (logistics -> shared). Logistica keeps access because it still manages the existing order; no order or message is touched. The server
 * (POST /api/conversations/[id]/derive-to-commercial -> derive_conversation_to_commercial) is the authority; this component only offers the action when
 * the server says the caller may, and shows who derived it once the chat is shared. With the feature off (or unknown) it renders nothing.
 */
export function DeriveToCommercial({ conversationId }: Props) {
  const t = useTranslations("Routing");
  const locale = useLocale();
  const { state, refresh } = useConversationRouting(conversationId);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false); // synchronous guard: two clicks in the same tick still send ONE request

  if (!conversationId || !state || !state.enabled) return null;

  const derive = async () => {
    if (inFlight.current) return; // a double click is a single request
    inFlight.current = true;
    setBusy(true);
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/derive-to-commercial`, { method: "POST" });
      if (res.ok) {
        toast.success(t("derivedToast"));
        setOpen(false);
        refresh(); // shows the shared state at once, no reload
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(res.status === 409 ? t("invalidTransition") : body.error || t("deriveError"));
    } catch {
      toast.error(t("deriveError"));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 w-full space-y-2">
      {state.stage === "shared" ? (
        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-left text-xs" data-testid="routing-shared">
          <p className="flex items-center gap-1.5 font-medium text-foreground">
            <Users className="size-3.5 text-primary" aria-hidden />
            {t("sharedBadge")}
          </p>
          {state.derived ? (
            <p className="mt-0.5 text-muted-foreground">{t("derivedBy", { name: state.derived.by, when: formatLimaDateTime(state.derived.at, locale) })}</p>
          ) : null}
        </div>
      ) : null}

      {state.can_derive ? (
        <>
          <Button variant="outline" size="sm" className="w-full" onClick={() => setOpen(true)}>
            <Users className="mr-1 size-4" aria-hidden />
            {t("derive")}
          </Button>
          <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>{t("deriveTitle")}</DialogTitle>
                <DialogDescription>{t("deriveDescription")}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
                  {t("cancel")}
                </Button>
                <Button onClick={() => void derive()} disabled={busy}>
                  {busy ? <Loader2 className="mr-1 size-4 animate-spin" aria-hidden /> : null}
                  {t("confirm")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      ) : null}
    </div>
  );
}
