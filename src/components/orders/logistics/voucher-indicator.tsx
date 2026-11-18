"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { CircleCheck, Clock, FileUp, Minus } from "lucide-react";

import { Button } from "@/components/ui/button";

import { api, LOGISTICS_CHANGED_EVENT, type LogisticsStatus } from "@/components/orders/logistics/api";

// Compact voucher indicator of the "Pedidos confirmados" list (a check when the order has a validated voucher).
//
// LOADING MODEL (deterministic, no artificial delay): each row reports when it actually BECOMES VISIBLE (IntersectionObserver). The ids that became visible in
// the same tick are fetched together, in ONE request to a separate endpoint (the PR-02 list endpoint is untouched). So the indicator never competes with the
// list's own requests: it only exists for rows the person can see, and rows below the fold cost nothing until scrolled to. Where IntersectionObserver does not
// exist nothing is fetched and nothing is shown (the list is exactly what it was before PR-04). When the server does not allow the logistics UI (flag OFF /
// not logistics) the first answer says so, nothing is rendered and no further request is made.

export interface Summary {
  status: LogisticsStatus
  voucher: "none" | "pending_review" | "validated"
}

const CHUNK = 50;

// ---- tiny external store (module scope, reset when the last indicator unmounts: it never outlives the list screen) ----
let allowed: boolean | null = null;
let cache = new Map<string, Summary>();
let requested = new Set<string>();
let pending = new Set<string>();
let scheduled = false;
let mounted = 0;
let generation = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

async function flush() {
  scheduled = false;
  const ids = [...pending];
  pending = new Set();
  if (ids.length === 0 || allowed === false) return;
  const mine = generation;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const r = await api<{ summary?: Record<string, Summary> }>(`/api/orders/logistics/summary?ids=${ids.slice(i, i + CHUNK).join(",")}`);
    if (mine !== generation) return; // the list screen was left meanwhile
    if (r.status === 401 || r.status === 403 || r.status === 404) {
      allowed = false;
      emit();
      return;
    }
    // Only a real summary object counts: any other answer means "not available" and nothing new is rendered.
    if (!r.ok || !r.body.summary || typeof r.body.summary !== "object") continue;
    allowed = true;
    for (const [id, s] of Object.entries(r.body.summary)) cache.set(id, s);
    emit();
  }
}

function want(id: string) {
  if (allowed === false) return;
  requested.add(id);
  pending.add(id);
  if (!scheduled) {
    scheduled = true;
    queueMicrotask(() => void flush());
  }
}

function mount() {
  mounted += 1;
}
function unmount() {
  mounted -= 1;
  if (mounted <= 0) {
    mounted = 0;
    generation += 1;
    allowed = null;
    cache = new Map();
    requested = new Set();
    pending = new Set();
    scheduled = false;
  }
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Test hook: forget everything (a fresh screen). */
export function __resetLogisticsSummaryStore() {
  mounted = 0;
  unmount();
  listeners.clear();
}

// A change made in the logistics panel refreshes what is on screen right away.
if (typeof window !== "undefined") {
  window.addEventListener(LOGISTICS_CHANGED_EVENT, () => {
    if (allowed === false) return;
    for (const id of requested) want(id);
  });
}

export function VoucherIndicator({ orderId }: { orderId: string }) {
  const t = useTranslations("OrderLogistics");
  const anchor = useRef<HTMLSpanElement | null>(null);
  const summary = useSyncExternalStore(subscribe, () => cache.get(orderId), () => undefined);

  useEffect(() => {
    mount();
    return unmount;
  }, []);

  useEffect(() => {
    const el = anchor.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        want(orderId);
        observer.disconnect();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [orderId]);

  if (!summary) return <span ref={anchor} aria-hidden className="block h-0" />;
  return (
    <div className="mt-1">
      <span ref={anchor} aria-hidden className="hidden" />
      {indicatorFor(summary, t)}
    </div>
  );
}

function indicatorFor(summary: Summary, t: ReturnType<typeof useTranslations>) {
  if (summary.voucher === "validated") {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] font-medium text-emerald-400" title={t("indicator.validated")}>
        <CircleCheck className="size-3.5" aria-hidden />
        <span className="sr-only md:not-sr-only">{t("indicator.validatedShort")}</span>
      </span>
    );
  }
  if (summary.voucher === "pending_review") {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] font-medium text-amber-300" title={t("indicator.pending_review")}>
        <Clock className="size-3.5" aria-hidden />
        <span className="sr-only md:not-sr-only">{t("indicator.pendingShort")}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-muted-foreground" title={t("indicator.none")}>
      <Minus className="size-3.5" aria-hidden />
      <span className="sr-only md:not-sr-only">{t("indicator.noneShort")}</span>
    </span>
  );
}

/** Entry to the bulk-voucher page. It appears only once the server has actually answered that the logistics UI is allowed (a row became visible and the answer was a summary). */
export function BulkVouchersButton() {
  const t = useTranslations("OrderLogistics");
  const router = useRouter();
  const visible = useSyncExternalStore(subscribe, () => allowed === true, () => false);
  if (!visible) return null;
  return (
    <Button type="button" variant="outline" size="sm" className="ml-auto h-9 gap-1.5" onClick={() => router.push("/confirmed-orders/vouchers")}>
      <FileUp className="size-4" aria-hidden />
      {t("bulkTitle")}
    </Button>
  );
}
