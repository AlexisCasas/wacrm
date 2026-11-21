"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { CircleAlert, CircleCheck, CircleHelp, ExternalLink, Loader2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, notifyLogisticsChanged, postJson, type DocumentDetail, type FieldComparison } from "@/components/orders/logistics/api";
import { useErrorText } from "@/components/orders/logistics/shared";

// Human review of ONE voucher: the original file, the automatic reading (a SUGGESTION, with its confidence), the differences against the order,
// manual correction and the explicit validation. Validating is always a person's action; once validated the data is frozen by the database.

const BASE_FIELDS = ["dni", "phone", "customer_name", "amount"] as const;
const FIELD_LABEL: Record<string, string> = { dni: "fieldDni", phone: "fieldPhone", customer_name: "fieldName", amount: "fieldAmount" };

const COMPARISON_TONE: Record<FieldComparison["status"], string> = {
  match: "text-emerald-400",
  mismatch: "text-red-300",
  missing: "text-muted-foreground",
  not_comparable: "text-amber-300",
};

export function VoucherReviewDialog({
  documentId,
  onClose,
  onChanged,
}: {
  documentId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations("OrderLogistics");
  const errorText = useErrorText();
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<null | "ocr" | "save" | "validate" | "reject">(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!documentId) return;
    setLoading(true);
    setLoadError(null);
    const [d, u] = await Promise.all([api<DocumentDetail>(`/api/orders/logistics/documents/${documentId}`), api<{ url?: string }>(`/api/orders/logistics/documents/${documentId}/url`)]);
    setLoading(false);
    if (!d.ok) {
      setLoadError(errorText(d.body.error));
      return;
    }
    setDetail(d.body);
    setFileUrl(u.ok ? (u.body.url ?? null) : null);
    const source = d.body.reviewed_data ?? Object.fromEntries(Object.entries(d.body.ocr?.fields ?? {}).map(([k, v]) => [k, v.value ?? ""]));
    const keys = new Set<string>([...BASE_FIELDS, ...Object.keys(source)]);
    setForm(Object.fromEntries([...keys].map((k) => [k, String(source[k] ?? "")])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  useEffect(() => {
    if (documentId) void load();
    else {
      setDetail(null);
      setFileUrl(null);
    }
  }, [documentId, load]);

  const doc = detail?.document;
  const editable = doc?.status === "pending_review";
  const fieldKeys = Object.keys(form);

  const run = async (kind: "ocr" | "save" | "validate" | "reject") => {
    if (!doc) return;
    setBusy(kind);
    const reviewed = Object.fromEntries(Object.entries(form).filter(([, v]) => v.trim() !== ""));
    const res =
      kind === "ocr"
        ? await postJson(`/api/orders/logistics/documents/${doc.id}/ocr`, {})
        : await postJson(`/api/orders/logistics/documents/${doc.id}/review`, {
            action: kind === "save" ? "correct" : kind,
            expected_row_version: doc.row_version,
            ...(kind === "save" || kind === "validate" ? { reviewed_data: reviewed } : {}),
          });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.body.error === "stale" ? t("err.stale") : errorText(res.body.error));
      if (res.body.error === "stale") await load();
      return;
    }
    if (kind === "ocr") {
      const body = res.body as { ocr_status?: string; error_code?: string };
      if (body.ocr_status === "failed") toast.message(t("ocrFailedToast", { code: body.error_code ?? "" }));
    } else {
      toast.success(kind === "validate" ? t("validatedToast") : kind === "reject" ? t("rejectedToast") : t("savedToast"));
    }
    notifyLogisticsChanged(doc.order_id);
    onChanged();
    if (kind === "validate" || kind === "reject") onClose();
    else await load();
  };

  const ocrFailed = doc?.ocr_status === "failed";
  const ocrNotConfigured = ocrFailed && doc?.ocr_error_code === "ocr_not_configured";
  const needsAssociation = doc?.association === "pending";

  return (
    <Dialog open={documentId !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("reviewTitle")}</DialogTitle>
          <DialogDescription>{t("reviewHint")}</DialogDescription>
        </DialogHeader>

        {loading && !detail ? (
          <div className="flex justify-center py-10" role="status" aria-label={t("loading")}>
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : loadError ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{loadError}</p>
        ) : doc ? (
          <div className="grid gap-4 md:grid-cols-2">
            <section className="space-y-2">
              <h4 className="text-sm font-semibold text-foreground">{t("originalFile")}</h4>
              <div className="flex min-h-40 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/30">
                {fileUrl && doc.mime_type.startsWith("image/") ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={fileUrl} alt={doc.original_filename} className="max-h-72 w-full object-contain" />
                ) : (
                  <p className="px-3 text-center text-xs text-muted-foreground">{doc.original_filename}</p>
                )}
              </div>
              {fileUrl ? (
                <a href={fileUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                  <ExternalLink className="size-3" aria-hidden />
                  {t("openFile")}
                </a>
              ) : null}
              <p className="text-[11px] text-muted-foreground">
                {doc.version ? t("version", { n: doc.version }) + " · " : ""}
                {t(`docStatus.${doc.status}`)}
                {" · "}
                {t(`association.${doc.association}`)}
              </p>
            </section>

            <section className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h4 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                  <Sparkles className="size-3.5 text-muted-foreground" aria-hidden />
                  {t("ocrTitle")}
                </h4>
                {editable ? (
                  <Button type="button" size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy !== null} onClick={() => void run("ocr")}>
                    {busy === "ocr" ? <Loader2 className="size-3 animate-spin" /> : null}
                    {doc.ocr_status === "none" ? t("runOcr") : t("retryOcr")}
                  </Button>
                ) : null}
              </div>
              {ocrNotConfigured ? <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">{t("ocrNotConfigured")}</p> : null}
              {ocrFailed && !ocrNotConfigured ? <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-300">{t("ocrFailed", { code: doc.ocr_error_code ?? "" })}</p> : null}
              {doc.ocr_status === "none" ? <p className="text-xs text-muted-foreground">{t("ocrNotRun")}</p> : null}
              {needsAssociation && editable ? <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-300">{t("err.association_required")}</p> : null}

              <div className="space-y-2">
                {fieldKeys.map((key) => {
                  const cmp = detail?.comparison.find((c) => c.field === key);
                  const conf = detail?.ocr?.fields[key]?.confidence;
                  const label = FIELD_LABEL[key] ? t(FIELD_LABEL[key]) : key;
                  return (
                    <div key={key} className="space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor={`vf-${key}`} className="text-xs">
                          {label}
                        </Label>
                        <span className="flex items-center gap-2 text-[11px]">
                          {conf !== undefined ? <span className="text-muted-foreground">{t("confidence", { pct: Math.round(conf * 100) })}</span> : null}
                          {cmp ? (
                            <span className={`inline-flex items-center gap-1 ${COMPARISON_TONE[cmp.status]}`}>
                              {cmp.status === "match" ? <CircleCheck className="size-3" aria-hidden /> : cmp.status === "mismatch" ? <CircleAlert className="size-3" aria-hidden /> : <CircleHelp className="size-3" aria-hidden />}
                              {t(`cmp.${cmp.status}`)}
                              {cmp.order_value && cmp.status !== "match" ? ` · ${t("orderHas", { value: cmp.order_value })}` : ""}
                            </span>
                          ) : null}
                        </span>
                      </div>
                      <Input
                        id={`vf-${key}`}
                        value={form[key] ?? ""}
                        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                        disabled={!editable || busy !== null}
                        maxLength={200}
                        className="h-8 text-sm"
                      />
                    </div>
                  );
                })}
              </div>
              {!editable ? <p className="text-xs text-muted-foreground">{doc.status === "validated" ? t("frozenHint") : t("closedHint")}</p> : null}
            </section>
          </div>
        ) : null}

        {editable && doc ? (
          <DialogFooter className="gap-2 sm:justify-between">
            <Button type="button" variant="ghost" className="text-red-300 hover:text-red-200" disabled={busy !== null} onClick={() => void run("reject")}>
              {t("reject")}
            </Button>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void run("save")}>
                {busy === "save" ? <Loader2 className="size-4 animate-spin" /> : null}
                {t("saveCorrection")}
              </Button>
              <Button type="button" disabled={busy !== null || needsAssociation} onClick={() => void run("validate")}>
                {busy === "validate" ? <Loader2 className="size-4 animate-spin" /> : null}
                {t("validate")}
              </Button>
            </div>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
