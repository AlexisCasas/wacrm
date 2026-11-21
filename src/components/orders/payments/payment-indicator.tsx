"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";

import { PAYMENTS_CHANGED_EVENT, soles, type PaymentSummaryData } from "@/components/orders/payments/api";

// The FINANCIAL chip of a LIST row (PR-06): Pendiente / Parcial / Pagado (+ the balance) next to the logistic status. Rows are asked for LAZILY (only when they become
// visible), in batches. No access (401 / 403 / 404: Commercial, flag OFF, other area…) is remembered for the session so the list never asks again; orders that are not tracked
// (historical) simply show nothing. Without IntersectionObserver nothing is asked.

const MAX_IDS = 50;

let allowed = true;
let version = 0;
const cache = new Map<string, PaymentSummaryData | null>(); // null = asked, not tracked
const requested = new Set<string>();
const pending = new Set<string>();
let scheduled = false;
const listeners = new Set<() => void>();
const bump = () => {
  version += 1;
  listeners.forEach((l) => l());
};

export function __resetPaymentSummaryStore() {
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
    let summaries: Record<string, PaymentSummaryData> | null = null;
    try {
      const res = await fetch(`/api/orders/payments/summary?ids=${chunk.join(",")}`, { cache: "no-store" });
      if (res.status === 401 || res.status === 403 || res.status === 404) allowed = false;
      else if (res.ok) {
        const body = (await res.json().catch(() => null)) as { summaries?: Record<string, PaymentSummaryData> } | null;
        if (body && typeof body.summaries === "object" && body.summaries) summaries = body.summaries;
      }
    } catch {
      summaries = null;
    }
    for (const id of chunk) {
      if (summaries) cache.set(id, summaries[id] ?? null);
      else requested.delete(id);
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
    if (listeners.size === 0) __resetPaymentSummaryStore();
  };
};
const getVersion = () => version;

export function PaymentChip({ orderId }: { orderId: string }) {
  const t = useTranslations("OrderPayments");
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
    window.addEventListener(PAYMENTS_CHANGED_EVENT, onChange);
    return () => {
      io.disconnect();
      window.removeEventListener(PAYMENTS_CHANGED_EVENT, onChange);
    };
  }, [orderId]);

  return (
    <>
      <span ref={mark} aria-hidden className="block h-0" />
      {summary ? (
        <span className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
          <span className={summary.financial_status === "paid" ? "font-medium text-emerald-400" : summary.financial_status === "partially_paid" ? "font-medium text-amber-300" : "font-medium text-foreground"}>{t(`chip.${summary.financial_status}`)}</span>
          {summary.financial_status !== "paid" ? <span>· {t("chipBalance", { balance: soles(summary.pending_balance) })}</span> : null}
        </span>
      ) : null}
    </>
  );
}
