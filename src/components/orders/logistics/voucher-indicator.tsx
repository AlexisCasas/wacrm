"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { CircleCheck, Clock, FileUp, Minus } from "lucide-react";

import { Button } from "@/components/ui/button";

import { api, LOGISTICS_CHANGED_EVENT, type LogisticsStatus } from "@/components/orders/logistics/api";

// Compact voucher indicator of the "Pedidos confirmados" list (a check when the order has a validated voucher). It reads ONE separate endpoint for
// the orders on screen (the PR-02 list endpoint is untouched); when the server does not allow it (flag OFF / not logistics) it shows NOTHING, so the
// list is exactly what it was before PR-04.

interface Summary {
  status: LogisticsStatus
  voucher: "none" | "pending_review" | "validated"
}
type SummaryMap = Record<string, Summary>

const SUMMARY_DELAY_MS = 600;

/** Summary of the given order ids; `null` while unknown / not allowed (render nothing). */
export function useLogisticsSummary(orderIds: readonly string[]): SummaryMap | null {
  const [summary, setSummary] = useState<SummaryMap | null>(null);
  const [tick, setTick] = useState(0);
  const key = orderIds.join(",");
  const seq = useRef(0);

  useEffect(() => {
    const onChanged = () => setTick((n) => n + 1);
    window.addEventListener(LOGISTICS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(LOGISTICS_CHANGED_EVENT, onChanged);
  }, []);

  const load = useCallback(async () => {
    if (!key) return;
    const mine = ++seq.current;
    // 50 ids per request (the endpoint's ceiling); the list loads 25 per page.
    const ids = key.split(",");
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
    const merged: SummaryMap = {};
    for (const chunk of chunks) {
      const r = await api<{ summary?: SummaryMap }>(`/api/orders/logistics/summary?ids=${chunk.join(",")}`);
      if (mine !== seq.current) return;
      // Only a real summary object counts: any other answer means "not available" and the list shows nothing new.
      if (!r.ok || !r.body.summary || typeof r.body.summary !== "object") return void setSummary(null);
      Object.assign(merged, r.body.summary);
    }
    setSummary(merged);
  }, [key]);

  // The list loads and paginates first; the indicator follows shortly after (and not at all if the list is replaced meanwhile), so it never competes
  // with the list's own requests. A change made in the logistics panel refreshes it right away.
  useEffect(() => {
    if (!key) return;
    const id = setTimeout(() => void load(), SUMMARY_DELAY_MS);
    return () => clearTimeout(id);
  }, [key, load]);
  useEffect(() => {
    if (tick === 0) return;
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [tick, load]);

  return summary;
}

export function VoucherIndicator({ summary }: { summary: Summary | undefined }) {
  const t = useTranslations("OrderLogistics");
  if (!summary) return null;
  return <div className="mt-1">{indicatorFor(summary, t)}</div>;
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

/** Entry to the bulk-voucher page. Only visible when the server allows the logistics UI at all (`visible`), so a legacy account sees nothing new. */
export function BulkVouchersButton({ visible }: { visible: boolean }) {
  const t = useTranslations("OrderLogistics");
  const router = useRouter();
  if (!visible) return null;
  return (
    <Button type="button" variant="outline" size="sm" className="ml-auto h-9 gap-1.5" onClick={() => router.push("/confirmed-orders/vouchers")}>
      <FileUp className="size-4" aria-hidden />
      {t("bulkTitle")}
    </Button>
  );
}
