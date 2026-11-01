"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Check, ChevronRight, Copy, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  formatLimaDateTime,
  formatPrice,
  isInFlight,
  statusInfo,
  type OrderHistoryItem,
  type StatusTone,
} from "@/lib/orders/history";

/** Fired by the confirmation dialog after an order is created, so the panel refreshes at once instead of waiting for the next poll. */
export const ORDERS_CHANGED_EVENT = "wacrm:orders-changed";

const POLL_MS = 30_000;

const TONE: Record<StatusTone, string> = {
  neutral: "bg-muted-foreground",
  amber: "bg-amber-500",
  blue: "bg-blue-500",
  green: "bg-emerald-500",
  red: "bg-red-500",
};

interface Props {
  conversationId?: string | null;
}

// Read-only list of the conversation's confirmed orders. It never writes anything and never triggers a delivery. "Confirmed in WACRM" is always
// true for a listed order; "received by InkaClick" is shown ONLY for `acknowledged`. Nothing is rendered while the feature is off for the account,
// the user is not an agent, or the first lookup fails (the "Confirmar pedido" button is unaffected). Remount per conversation (key).
export function OrderHistory({ conversationId }: Props) {
  const t = useTranslations("Orders");
  const locale = useLocale();
  const [orders, setOrders] = useState<OrderHistoryItem[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<OrderHistoryItem | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    if (!conversationId) return;
    const seq = ++requestSeq.current;
    try {
      const res = await fetch(`/api/orders/history?conversation_id=${encodeURIComponent(conversationId)}`);
      if (seq !== requestSeq.current) return;
      if (!res.ok) {
        setFailed(true);
        return;
      }
      const body = (await res.json()) as { enabled?: boolean; orders?: OrderHistoryItem[]; has_more?: boolean };
      if (seq !== requestSeq.current) return;
      if (body.enabled !== true) {
        setHidden(true);
        return;
      }
      setOrders(body.orders ?? []);
      setHasMore(body.has_more === true);
      setFailed(false);
    } catch {
      if (seq === requestSeq.current) setFailed(true);
    }
  }, [conversationId]);

  useEffect(() => {
    // Initial load; the setState calls happen after an await, not synchronously in the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const onChanged = () => void load();
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener(ORDERS_CHANGED_EVENT, onChanged);
    document.addEventListener("visibilitychange", onVisible);
    const seq = requestSeq;
    return () => {
      seq.current++; // drops any answer still in flight for the previous conversation
      window.removeEventListener(ORDERS_CHANGED_EVENT, onChanged);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  // Poll only while some order can still change (not yet received / not terminal) and the tab is visible.
  const watching = orders?.some((o) => isInFlight(o.delivery_status)) ?? false;
  useEffect(() => {
    if (!watching) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [watching, load]);

  if (!conversationId || hidden) return null;
  if (orders === null && !failed) return <p className="mt-3 text-xs text-muted-foreground">{t("historyLoading")}</p>;
  if (orders === null) return null;

  return (
    <section className="mt-3 w-full text-left" aria-label={t("historyTitle")}>
      <div className="flex items-center justify-between px-1">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("historyTitle")} ({orders.length}{hasMore ? "+" : ""})
        </h4>
        <button
          type="button"
          onClick={() => void load()}
          aria-label={t("historyRefresh")}
          className="rounded p-1 text-muted-foreground hover:bg-muted"
        >
          <RefreshCw className="size-3" />
        </button>
      </div>

      {failed && (
        <p className="mt-2 px-1 text-xs text-red-600 dark:text-red-400">
          {t("historyError")}{" "}
          <button type="button" className="underline" onClick={() => void load()}>
            {t("historyRetry")}
          </button>
        </p>
      )}

      {orders.length === 0 ? (
        <p className="mt-2 px-1 text-xs text-muted-foreground">{t("historyEmpty")}</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {orders.map((o) => {
            const info = statusInfo(o.delivery_status);
            return (
              <li key={o.id}>
                <button
                  type="button"
                  onClick={() => setSelected(o)}
                  className="flex w-full items-start gap-2 rounded-lg border border-border bg-background p-2 text-left hover:bg-muted"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground" title={o.product}>
                      {o.product}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("historyQuantity", { count: o.quantity })} · {formatPrice(o.price)}
                    </p>
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-foreground">
                      <span className={`inline-block size-2 shrink-0 rounded-full ${TONE[info.tone]}`} aria-hidden />
                      <span>{t(info.key)}</span>
                    </p>
                    <p className="text-[11px] text-muted-foreground">{formatLimaDateTime(o.confirmed_at, locale)} (Lima)</p>
                  </div>
                  <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {hasMore && <p className="mt-2 px-1 text-[11px] text-muted-foreground">{t("historyMore")}</p>}

      <OrderDetail order={selected} locale={locale} onClose={() => setSelected(null)} />
    </section>
  );
}

function OrderDetail({ order, locale, onClose }: { order: OrderHistoryItem | null; locale: string; onClose: () => void }) {
  const t = useTranslations("Orders");
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!order) return;
    try {
      await navigator.clipboard.writeText(order.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable: the id is still selectable on screen */
    }
  };

  const info = order ? statusInfo(order.delivery_status) : null;
  const when = (iso: string | null) => (iso ? `${formatLimaDateTime(iso, locale)} (Lima)` : t("detailNone"));

  return (
    <Dialog open={order !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        {order && info && (
          <>
            <DialogHeader>
              <DialogTitle>{t("detailTitle")}</DialogTitle>
            </DialogHeader>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{t("detailProduct")}</dt>
              <dd className="break-words">{order.product}</dd>
              <dt className="text-muted-foreground">{t("detailQuantityPrice")}</dt>
              <dd>
                {order.quantity} · {formatPrice(order.price)}
              </dd>
              <dt className="text-muted-foreground">{t("detailConfirmedBy")}</dt>
              <dd>{order.confirmed_by_name}</dd>
              <dt className="text-muted-foreground">{t("detailSeller")}</dt>
              <dd>{order.seller_name}</dd>
              <dt className="text-muted-foreground">{t("detailConfirmedAt")}</dt>
              <dd>{when(order.confirmed_at)}</dd>
              <dt className="text-muted-foreground">{t("detailStatus")}</dt>
              <dd className="flex items-center gap-1.5">
                <span className={`inline-block size-2 rounded-full ${TONE[info.tone]}`} aria-hidden />
                {t(info.key)}
              </dd>
              <dt className="text-muted-foreground">{t("detailSentAt")}</dt>
              <dd>{when(order.sent_at)}</dd>
              <dt className="text-muted-foreground">{t("detailAcknowledgedAt")}</dt>
              <dd>{when(order.acknowledged_at)}</dd>
              <dt className="text-muted-foreground">{t("detailAttempts")}</dt>
              <dd>{order.attempts}</dd>
              <dt className="text-muted-foreground">{t("detailId")}</dt>
              <dd className="flex items-center gap-2">
                <code className="break-all text-xs">{order.id}</code>
                <Button type="button" variant="outline" size="sm" onClick={copy} aria-label={t("detailCopyId")}>
                  {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                </Button>
              </dd>
            </dl>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
