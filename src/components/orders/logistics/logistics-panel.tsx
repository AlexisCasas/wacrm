"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { History, Loader2, Truck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { api, type OrderEventView, type PanelData } from "@/components/orders/logistics/api";
import { PackagingSection } from "@/components/orders/logistics/packaging-section";
import { StatusStepper, limaDateTime } from "@/components/orders/logistics/shared";
import { VoucherSection } from "@/components/orders/logistics/voucher-section";

// The logistics side of ONE confirmed order, rendered inside the existing order detail (PR-02) and only when the server says the caller works
// the logistics stage (flag ON + logistics / supervisor). For anyone else — and with the flag OFF — it renders NOTHING, so the detail is exactly
// what it was before PR-04.

type State = "loading" | "ready" | "hidden" | "error";

export function LogisticsPanel({ orderId }: { orderId: string }) {
  const t = useTranslations("OrderLogistics");
  const [data, setData] = useState<PanelData | null>(null);
  const [state, setState] = useState<State>("loading");
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const r = await api<PanelData>(`/api/orders/logistics/orders/${orderId}`);
    if (mine !== seq.current) return;
    if (r.status === 403 || r.status === 404 || r.status === 401) return void setState("hidden");
    if (!r.ok) return void setState("error");
    // Trust nothing about the shape: anything that is not the logistics panel (an unexpected answer) simply shows nothing.
    const b = r.body as Partial<PanelData>;
    if (!b || typeof b.logistics?.status !== "string" || !Array.isArray(b.vouchers) || !Array.isArray(b.events) || !Array.isArray(b.dispatches)) return void setState("hidden");
    setData(r.body);
    setState("ready");
  }, [orderId]);

  // The panel is keyed by order in the drawer, so every order starts in "loading": no state reset is needed here.
  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => {
      clearTimeout(id);
      seq.current += 1;
    };
  }, [load]);

  if (state === "hidden") return null;

  return (
    <>
      <hr className="border-border" />
      <section className="space-y-4" aria-labelledby={`logistics-${orderId}`}>
        <h4 id={`logistics-${orderId}`} className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Truck className="size-4 text-muted-foreground" aria-hidden />
          {t("title")}
        </h4>

        {state === "loading" ? (
          <div className="flex justify-center py-4" role="status" aria-label={t("loading")}>
            <Loader2 className="size-5 animate-spin text-primary" />
          </div>
        ) : null}

        {state === "error" ? (
          <div className="space-y-2 text-center">
            <p className="text-xs text-muted-foreground">{t("loadError")}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
              {t("retry")}
            </Button>
          </div>
        ) : null}

        {state === "ready" && data ? (
          <div className="space-y-5">
            <StatusStepper status={data.logistics.status} />
            <VoucherSection orderId={orderId} status={data.logistics.status} vouchers={data.vouchers} onChanged={() => void load()} />
            <PackagingSection orderId={orderId} status={data.logistics.status} remotePackaging={data.remote_packaging} evidence={data.evidence} dispatches={data.dispatches} onChanged={() => void load()} />
            <Trace events={data.events} />
          </div>
        ) : null}
      </section>
    </>
  );
}

function Trace({ events }: { events: OrderEventView[] }) {
  const t = useTranslations("OrderLogistics");
  const locale = useLocale();
  const [all, setAll] = useState(false);
  const shown = all ? events : events.slice(0, 5);
  if (events.length === 0) return null;
  return (
    <section className="space-y-2" aria-label={t("traceTitle")}>
      <h5 className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
        <History className="size-3.5 text-muted-foreground" aria-hidden />
        {t("traceTitle")}
      </h5>
      <ol className="space-y-1.5">
        {shown.map((e) => (
          <li key={e.id} className="flex items-start justify-between gap-3 text-[11px] leading-snug">
            <span className={e.outcome === "error" ? "text-amber-300" : "text-foreground"}>
              {t.has(`event.${e.event_type}`) ? t(`event.${e.event_type}`) : e.event_type}
              <span className="text-muted-foreground"> · {e.actor_name}</span>
            </span>
            <span className="shrink-0 text-muted-foreground">{limaDateTime(e.created_at, locale)}</span>
          </li>
        ))}
      </ol>
      {events.length > 5 ? (
        <Button type="button" variant="ghost" size="sm" className="h-6 px-1 text-[11px] text-muted-foreground" onClick={() => setAll((v) => !v)}>
          {all ? t("showLess") : t("showAll", { count: events.length })}
        </Button>
      ) : null}
    </section>
  );
}
