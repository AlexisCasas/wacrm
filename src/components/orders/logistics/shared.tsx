"use client";

import { useTranslations } from "next-intl";
import { Check } from "lucide-react";

import type { LogisticsStatus } from "@/components/orders/logistics/api";

// Shared bits of the PR-04 logistics UI: the 4-step visible status, error wording and date formatting (America/Lima, like the rest of the workspace).

export const STATUS_ORDER: LogisticsStatus[] = ["pending_voucher", "voucher_validated", "packing", "ready_for_dispatch"];

export function useErrorText() {
  const t = useTranslations("OrderLogistics");
  return (code?: string | null) => (code && t.has(`err.${code}`) ? t(`err.${code}`) : t("err.generic"));
}

export function limaDateTime(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const zone = { timeZone: "America/Lima" } as const;
  const date = new Intl.DateTimeFormat(locale, { ...zone, day: "numeric", month: "short" }).format(d).replace(/\./g, "");
  const time = new Intl.DateTimeFormat(locale, { ...zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return `${date} · ${time}`;
}

/** The four visible logistic states as a compact stepper. Technical states (OCR, upload, template send) are never shown here. */
export function StatusStepper({ status }: { status: LogisticsStatus }) {
  const t = useTranslations("OrderLogistics");
  const current = STATUS_ORDER.indexOf(status);
  return (
    <ol className="grid grid-cols-4 gap-1" aria-label={t("statusLabel")}>
      {STATUS_ORDER.map((s, i) => {
        const done = i < current || (status === "ready_for_dispatch" && i === current);
        const active = i === current && !done;
        return (
          <li key={s} aria-current={active ? "step" : undefined} className="min-w-0">
            <div className={`h-1.5 rounded-full ${done ? "bg-emerald-500" : active ? "bg-primary" : "bg-muted"}`} />
            <p className={`mt-1.5 flex items-start gap-0.5 text-[10px] leading-tight ${active ? "font-semibold text-foreground" : done ? "text-emerald-400" : "text-muted-foreground"}`}>
              {done ? <Check className="mt-px size-3 shrink-0" aria-hidden /> : null}
              <span>{t(`status.${s}`)}</span>
            </p>
          </li>
        );
      })}
    </ol>
  );
}
