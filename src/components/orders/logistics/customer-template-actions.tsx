"use client";

import { useEffect, useMemo, useState } from "react";
import { FileImage, Loader2, MessageSquareText, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { postJson, type CustomerTemplateDispatchView, type DocumentView } from "@/components/orders/logistics/api";
import { useErrorText } from "@/components/orders/logistics/shared";

type Kind = "summary" | "voucher";

export function CustomerTemplateActions({
  orderId,
  voucherDocumentId,
  vouchers,
  dispatches,
  onChanged,
}: {
  orderId: string;
  voucherDocumentId: string | null;
  vouchers: DocumentView[];
  dispatches: CustomerTemplateDispatchView[];
  onChanged: () => void;
}) {
  const t = useTranslations("OrderLogistics");
  const errorText = useErrorText();
  const [busy, setBusy] = useState<Kind | "resolve" | null>(null);
  const [nowMs, setNowMs] = useState(0);

  useEffect(() => {
    const tick = () => setNowMs(Date.now());
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const voucher = useMemo(
    () => vouchers.find((v) => v.id === voucherDocumentId && v.status === "validated") ?? null,
    [vouchers, voucherDocumentId],
  );
  const stateFor = (kind: Kind) =>
    dispatches.find((d) => d.kind === kind && d.voucher_document_id === voucherDocumentId) ?? null;
  const summary = stateFor("summary");
  const voucherSend = stateFor("voucher");
  const ready = !!voucher;

  const send = async (kind: Kind) => {
    setBusy(kind);
    const r = await postJson<{ status?: string }>(
      `/api/orders/logistics/orders/${orderId}/customer-templates`,
      { action: kind === "summary" ? "send_summary" : "send_voucher" },
    );
    setBusy(null);
    if (r.ok) toast.success(t(kind === "summary" ? "customerSummarySent" : "customerVoucherSent"));
    else if (r.body.error === "send_uncertain" || r.body.error === "uncertain") toast.warning(t("customerSendUncertain"));
    else toast.error(errorText(r.body.error));
    onChanged();
  };

  const resolve = async (dispatch: CustomerTemplateDispatchView, resolution: "confirmed_sent" | "confirmed_not_sent") => {
    setBusy("resolve");
    const r = await postJson(`/api/orders/logistics/orders/${orderId}/customer-templates`, {
      action: "resolve",
      dispatch_id: dispatch.id,
      resolution,
    });
    setBusy(null);
    if (!r.ok) toast.error(errorText(r.body.error));
    onChanged();
  };

  const isStaleInFlight = (d: CustomerTemplateDispatchView | null) => {
    if (!d || (d.status !== "claimed" && d.status !== "sending")) return false;
    const startedAt = d.sending_at ?? d.claimed_at;
    const startedMs = Date.parse(startedAt);
    return Number.isFinite(startedMs) && nowMs - startedMs >= 10 * 60 * 1000;
  };

  const blocksSend = (d: CustomerTemplateDispatchView | null) =>
    d?.status === "sent" ||
    d?.status === "uncertain" ||
    ((d?.status === "claimed" || d?.status === "sending") && !isStaleInFlight(d));

  const label = (kind: Kind, d: CustomerTemplateDispatchView | null) => {
    if (d?.status === "sent") return t(kind === "summary" ? "customerSummarySentLabel" : "customerVoucherSentLabel");
    if (d?.status === "failed") return t(kind === "summary" ? "customerRetrySummary" : "customerRetryVoucher");
    return t(kind === "summary" ? "customerSendSummary" : "customerSendVoucher");
  };

  return (
    <section className="space-y-3 rounded-lg border border-border p-3" aria-label={t("customerMessagesTitle")}>
      <div>
        <h5 className="text-xs font-semibold text-foreground">{t("customerMessagesTitle")}</h5>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {ready ? t("customerMessagesReady") : t("customerMessagesNeedsVoucher")}
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5"
          disabled={!ready || busy !== null || blocksSend(summary)}
          onClick={() => void send("summary")}>
          {busy === "summary" ? <Loader2 className="size-3.5 animate-spin" /> : <MessageSquareText className="size-3.5" aria-hidden />}
          {label("summary", summary)}
        </Button>
        <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5"
          disabled={!ready || busy !== null || blocksSend(voucherSend)}
          onClick={() => void send("voucher")}>
          {busy === "voucher" ? <Loader2 className="size-3.5 animate-spin" /> : <FileImage className="size-3.5" aria-hidden />}
          {label("voucher", voucherSend)}
        </Button>
      </div>
      {[summary, voucherSend].filter((d): d is CustomerTemplateDispatchView => d?.status === "uncertain").map((d) => (
        <div key={d.id} className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2">
          <p className="flex items-center gap-1.5 text-[11px] text-amber-200">
            <TriangleAlert className="size-3.5" aria-hidden />
            {t("customerSendUncertain")}
          </p>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy !== null} onClick={() => void resolve(d, "confirmed_sent")}>{t("confirmedSent")}</Button>
            <Button type="button" size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy !== null} onClick={() => void resolve(d, "confirmed_not_sent")}>{t("confirmedNotSent")}</Button>
          </div>
        </div>
      ))}
    </section>
  );
}
