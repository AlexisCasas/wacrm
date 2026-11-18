"use client";

import { useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { FileText, Loader2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ACCEPTED_FILES, newRequestKey, notifyLogisticsChanged, type DocumentView, type LogisticsStatus } from "@/components/orders/logistics/api";
import { limaDateTime, useErrorText } from "@/components/orders/logistics/shared";
import { VoucherReviewDialog } from "@/components/orders/logistics/voucher-review-dialog";

// VOUCHER of one order. Uploading from the order means the order is KNOWN: no matching, the voucher is associated directly and the automatic
// reading only helps to check it. Once packaging starts the voucher is closed (the server refuses new ones too).

const TONE: Record<DocumentView["status"], string> = {
  pending_review: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  validated: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
  rejected: "border-red-500/30 bg-red-500/10 text-red-300",
  superseded: "border-border bg-muted/60 text-muted-foreground",
  active: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
};

export function VoucherSection({ orderId, status, vouchers, onChanged }: { orderId: string; status: LogisticsStatus; vouchers: DocumentView[]; onChanged: () => void }) {
  const t = useTranslations("OrderLogistics");
  const locale = useLocale();
  const errorText = useErrorText();
  const input = useRef<HTMLInputElement | null>(null);
  // One key per upload INTENT: a double click or a retry of the same file reuses it (the server answers the same document).
  const pending = useRef<{ file: File; key: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const locked = status === "packing" || status === "ready_for_dispatch";

  const send = async (file: File, key: string, allowDuplicate: boolean) => {
    setUploading(true);
    const form = new FormData();
    form.set("file", file);
    form.set("request_key", key);
    form.set("order_id", orderId);
    if (allowDuplicate) form.set("allow_duplicate", "true");
    let res: Response | null = null;
    try {
      res = await fetch("/api/orders/logistics/documents", { method: "POST", body: form });
    } catch {
      res = null;
    }
    setUploading(false);
    const body = res ? ((await res.json().catch(() => ({}))) as { error?: string; document?: DocumentView }) : { error: "network_error" };
    if (res?.ok && body.document) {
      pending.current = null;
      toast.success(t("uploadedToast"));
      onChanged();
      notifyLogisticsChanged(orderId);
      setReviewing(body.document.id);
      return;
    }
    if (body.error === "duplicate" && !allowDuplicate && window.confirm(t("duplicateConfirm"))) {
      await send(file, key, true);
      return;
    }
    toast.error(errorText(body.error));
  };

  const onPick = (file: File | undefined) => {
    if (!file || uploading) return;
    if (pending.current?.file.name !== file.name || pending.current.file.size !== file.size) pending.current = { file, key: newRequestKey() };
    void send(file, pending.current.key, false);
  };

  return (
    <section className="space-y-3" aria-labelledby={`voucher-${orderId}`}>
      <div className="flex items-center justify-between gap-2">
        <h4 id={`voucher-${orderId}`} className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <FileText className="size-4 text-muted-foreground" aria-hidden />
          {t("voucherTitle")}
        </h4>
        {!locked ? (
          <>
            <input
              ref={input}
              type="file"
              accept={ACCEPTED_FILES}
              className="sr-only"
              aria-label={t("uploadVoucher")}
              onChange={(e) => {
                onPick(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <Button type="button" size="sm" variant="outline" className="h-7 gap-1 text-[11px]" disabled={uploading} onClick={() => input.current?.click()}>
              {uploading ? <Loader2 className="size-3 animate-spin" /> : <Upload className="size-3" aria-hidden />}
              {t("uploadVoucher")}
            </Button>
          </>
        ) : null}
      </div>

      {vouchers.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("noVouchers")}</p>
      ) : (
        <ul className="space-y-1.5">
          {vouchers.map((v) => (
            <li key={v.id} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-foreground">{v.original_filename}</p>
                <p className="text-[11px] text-muted-foreground">
                  {v.version ? `${t("version", { n: v.version })} · ` : ""}
                  {limaDateTime(v.created_at, locale)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONE[v.status]}`}>{t(`docStatus.${v.status}`)}</span>
                <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => setReviewing(v.id)}>
                  {v.status === "pending_review" ? t("review") : t("view")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {locked ? <p className="text-[11px] text-muted-foreground">{t("vouchersClosed")}</p> : null}

      <VoucherReviewDialog documentId={reviewing} onClose={() => setReviewing(null)} onChanged={onChanged} />
    </section>
  );
}
