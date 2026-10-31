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

// Shown only where the feature is set up: the account must have at least one active seller (the catalogue is the opt-in), so accounts that never
// configured "Confirmar pedido" see no new button. A failed lookup also hides it rather than offering an action that cannot complete.
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
        const body = (await res.json()) as { sellers?: OrderSeller[] };
        if (!cancelled) setSellers(body.sellers ?? []);
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
