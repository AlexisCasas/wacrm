"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { CircleDollarSign } from "lucide-react";

import { soles, type ConversationFinancialData } from "@/components/orders/payments/api";

// READ-ONLY financial summary of the orders of the open chat (PR-06): Total / Pagado / Saldo / Estado. Shown to whoever the SERVER lets read it (Comercial for a chat it can
// work, Logistica, Supervisor); it has NO buttons, never lists payments, evidence or audit, and gives no access to Pedidos Confirmados. With the feature off, without access or
// without tracked orders it renders nothing.

export function ConversationFinancials({ conversationId }: { conversationId?: string | null }) {
  const t = useTranslations("OrderPayments");
  const [orders, setOrders] = useState<ConversationFinancialData[] | null>(null);

  useEffect(() => {
    if (!conversationId) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`/api/orders/payments/conversation?conversation_id=${encodeURIComponent(conversationId)}`, { cache: "no-store" });
        if (!alive || !res.ok) return;
        const body = (await res.json().catch(() => null)) as { orders?: ConversationFinancialData[] } | null;
        if (alive && Array.isArray(body?.orders)) setOrders(body.orders);
      } catch {
        // nothing to show
      }
    })();
    return () => {
      alive = false;
    };
  }, [conversationId]);

  if (!orders || orders.length === 0) return null;
  return (
    <section className="mt-3 w-full space-y-2 rounded-lg border border-border bg-muted/30 p-3 text-left" aria-label={t("chatTitle")} data-testid="conversation-financials">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
        <CircleDollarSign className="size-3.5 text-muted-foreground" aria-hidden />
        {t("chatTitle")}
      </p>
      {orders.map((o) => (
        <div key={o.order_id} className="space-y-0.5 text-[11px]">
          {orders.length > 1 ? <p className="truncate font-medium text-foreground">{o.product}</p> : null}
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
            <dt className="text-muted-foreground">{t("total")}</dt>
            <dd className="text-foreground">{soles(o.total)}</dd>
            <dt className="text-muted-foreground">{t("paid")}</dt>
            <dd className="text-foreground">{soles(o.paid_confirmed)}</dd>
            <dt className="text-muted-foreground">{t("balance")}</dt>
            <dd className={o.pending_balance > 0 ? "font-semibold text-amber-300" : "font-semibold text-emerald-400"}>{soles(o.pending_balance)}</dd>
            <dt className="text-muted-foreground">{t("statusLabel")}</dt>
            <dd className="text-foreground">{t(`status.${o.financial_status}`)}</dd>
          </dl>
        </div>
      ))}
    </section>
  );
}
