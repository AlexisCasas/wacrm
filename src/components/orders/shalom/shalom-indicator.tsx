"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { BellRing, Truck } from "lucide-react";

import { LOGISTICS_CHANGED_EVENT } from "@/components/orders/logistics/api";
import { VoucherIndicator } from "@/components/orders/logistics/voucher-indicator";
import { SHIPMENT_CHANGED_EVENT, type ShipmentSummaryData } from "@/components/orders/shalom/api";

// The derived logistic status of a LIST row (PR-05): when the order has a Shalom shipment the PR-05 status is shown (En origen / En tránsito / En destino /
// Entregado); otherwise the PR-04 indicator (voucher / packaging / Listo para despacho) stays exactly as it was. PR-04's component is wrapped, never edited.
// Rows are asked for LAZILY (only when they become visible), in batches. No access (401 / 403 / 404: Commercial, flag OFF, other area…) is remembered for
// the session so the list never asks again, and nothing extra is shown. Without IntersectionObserver nothing is asked and nothing changes.

const MAX_IDS = 50;

let allowed = true;
let version = 0;
const cache = new Map<string, ShipmentSummaryData | null>(); // null = asked, no shipment
const requested = new Set<string>();
const pending = new Set<string>();
let scheduled = false;
const listeners = new Set<() => void>();
const bump = () => {
  version += 1;
  listeners.forEach((l) => l());
};

/** Test helper: forget everything (a new screen / a different user must never be served stale data). */
export function __resetShipmentSummaryStore() {
  allowed = true;
  cache.clear();
  requested.clear();
  pending.clear();
  scheduled = false;
  bump();
}

async function flush() {
  scheduled = false;
  const ids = [...pending];
  pending.clear();
  for (let i = 0; i < ids.length; i += MAX_IDS) {
    const chunk = ids.slice(i, i + MAX_IDS);
    let summaries: Record<string, ShipmentSummaryData> | null = null;
    try {
      const res = await fetch(`/api/orders/shalom/summary?ids=${chunk.join(",")}`, { cache: "no-store" });
      if (res.status === 401 || res.status === 403 || res.status === 404) allowed = false;
      else if (res.ok) {
        const body = (await res.json().catch(() => null)) as { summaries?: Record<string, ShipmentSummaryData> } | null;
        if (body && typeof body.summaries === "object" && body.summaries) summaries = body.summaries;
      }
    } catch {
      summaries = null;
    }
    for (const id of chunk) {
      if (summaries) cache.set(id, summaries[id] ?? null);
      else requested.delete(id); // not answered: a later render may ask again
    }
    bump();
  }
}

function want(id: string) {
  if (!allowed || requested.has(id)) return;
  requested.add(id);
  pending.add(id);
  if (!scheduled) {
    scheduled = true;
    queueMicrotask(() => void flush());
  }
}

function forget(orderId: string | null) {
  if (orderId) {
    cache.delete(orderId);
    requested.delete(orderId);
  } else {
    cache.clear();
    requested.clear();
  }
  bump();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) __resetShipmentSummaryStore();
  };
};
const getVersion = () => version;

export function DerivedLogisticsIndicator({ orderId }: { orderId: string }) {
  const t = useTranslations("OrderShipments");
  const mark = useRef<HTMLSpanElement | null>(null);
  const visible = useRef(false);
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const summary = cache.get(orderId) ?? null;

  useEffect(() => {
    const el = mark.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          visible.current = true;
          want(orderId);
        }
      }
    });
    io.observe(el);
    const onChange = (ev: Event) => {
      const id = (ev as CustomEvent<{ orderId: string | null }>).detail?.orderId ?? null;
      if (id && id !== orderId) return;
      forget(id);
      if (visible.current) want(orderId);
    };
    window.addEventListener(SHIPMENT_CHANGED_EVENT, onChange);
    window.addEventListener(LOGISTICS_CHANGED_EVENT, onChange);
    return () => {
      io.disconnect();
      window.removeEventListener(SHIPMENT_CHANGED_EVENT, onChange);
      window.removeEventListener(LOGISTICS_CHANGED_EVENT, onChange);
    };
  }, [orderId]);

  return (
    <>
      <span ref={mark} aria-hidden className="block h-0" />
      {summary ? (
        <span className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
          <Truck className="size-3 shrink-0" aria-hidden />
          <span className={summary.logistic_status === "delivered" ? "font-medium text-emerald-400" : "font-medium text-foreground"}>
            {summary.logistic_status ? t(`status.${summary.logistic_status}`) : t("awaitingFirst")}
          </span>
          {summary.alert_open ? <BellRing className="size-3 shrink-0 text-amber-400" aria-label={t("alertTitle")} /> : null}
          {summary.pickup_state === "abandoned" ? (
            <span className="font-semibold text-red-400">· {t("abandonedShort", { days: summary.days_at_destination ?? 20 })}</span>
          ) : summary.pickup_state === "alerted_15d" ? (
            <span className="text-amber-300">· {t("alert15Short")}</span>
          ) : null}
          {summary.needs_attention ? <span className="text-amber-300">· {t("needsAttentionShort")}</span> : null}
        </span>
      ) : (
        <VoucherIndicator orderId={orderId} />
      )}
    </>
  );
}
