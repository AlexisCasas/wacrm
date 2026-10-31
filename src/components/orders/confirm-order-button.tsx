"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ClipboardCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmOrderDialog, type OrderSeller } from "./confirm-order-dialog";

interface Props {
  contact: { id: string; name?: string | null; phone?: string | null };
  conversationId?: string | null;
}

// Shown only where the feature has been switched on for the account (`confirm_enabled`, off by default and separate from the InkaClick delivery
// switch) AND there is someone to choose as seller. The roster is the account's real members, so every other account sees no new button, however
// many members it has. A failed lookup also hides it rather than offering an action that cannot complete.
export function ConfirmOrderButton({ contact, conversationId }: Props) {
  const t = useTranslations("Orders");
  const [sellers, setSellers] = useState<OrderSeller[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/orders/sellers");
        if (!res.ok) return;
        const body = (await res.json()) as { enabled?: boolean; sellers?: OrderSeller[] };
        if (!cancelled) setSellers(body.enabled === true ? (body.sellers ?? []) : []);
      } catch {
        /* hidden */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!sellers || sellers.length === 0) return null;
  return (
    <>
      <Button variant="outline" size="sm" className="w-full" onClick={() => setOpen(true)}>
        <ClipboardCheck className="mr-1 size-4" />
        {t("confirmButton")}
      </Button>
      <ConfirmOrderDialog open={open} onOpenChange={setOpen} contact={contact} conversationId={conversationId} sellers={sellers} />
    </>
  );
}
