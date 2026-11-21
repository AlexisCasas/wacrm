"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { CircleCheck, Image as ImageIcon, Loader2, PackageOpen, Send, TriangleAlert, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ACCEPTED_FILES, api, newRequestKey, notifyLogisticsChanged, postJson, type DispatchView, type DocumentView, type LogisticsStatus } from "@/components/orders/logistics/api";
import { useErrorText } from "@/components/orders/logistics/shared";

// PACKAGING of one order: start it, UPLOAD the packaging evidence from the operator's device (primary way; the chat may have no file at all) or, when
// the chat has reusable files, pick one FROM THE SAME CHAT (optional alternative), send the operational
// WhatsApp template and — only when the send is CONFIRMED — the order becomes "Listo para despacho". The request key of a send is kept while the
// operation is the same (a retry never duplicates) and renewed only for a new, deliberate send.

interface ChatMedia {
  message_id: string
  content_type: string
  created_at: string
  available: boolean
  preview_url: string | null
}

export function PackagingSection({
  orderId,
  status,
  remotePackaging,
  evidence,
  dispatches,
  onChanged,
}: {
  orderId: string
  status: LogisticsStatus
  remotePackaging: { status: 'completed'; source_system: 'inkaclick'; customer_message_sent: boolean; completed_at: string } | null
  evidence: DocumentView | null
  dispatches: DispatchView[]
  onChanged: () => void
}) {
  const t = useTranslations("OrderLogistics");
  const errorText = useErrorText();
  const sendKey = useRef(newRequestKey());
  const [busy, setBusy] = useState<null | "start" | "send" | "resolve" | "upload">(null);
  const [picking, setPicking] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  // One key per upload INTENT: a double click or a retry of the same file reuses it (the server answers the same evidence).
  const pendingUpload = useRef<{ file: File; key: string } | null>(null);
  const [chatCount, setChatCount] = useState(0);
  const [resolvedUrl, setResolvedUrl] = useState<{ id: string; url: string } | null>(null);
  const evidenceUrl = evidence && resolvedUrl?.id === evidence.id ? resolvedUrl.url : null;

  const uncertain = dispatches.find((d) => d.status === "uncertain");
  const completedElsewhere = remotePackaging?.status === "completed";
  const done = () => {
    onChanged();
    notifyLogisticsChanged(orderId);
  };

  useEffect(() => {
    let cancelled = false;
    if (!evidence || !evidence.mime_type.startsWith("image/")) return;
    void (async () => {
      const r = await api<{ url?: string }>(`/api/orders/logistics/documents/${evidence.id}/url`);
      if (!cancelled && r.ok && r.body.url) setResolvedUrl({ id: evidence.id, url: r.body.url });
    })();
    return () => {
      cancelled = true;
    };
  }, [evidence]);

  // The chat alternative is offered only when the conversation has at least one reusable file (the upload works with or without it).
  useEffect(() => {
    if (status !== "packing") return;
    let cancelled = false;
    void (async () => {
      const r = await api<{ media?: ChatMedia[] }>(`/api/orders/logistics/orders/${orderId}/chat-media`);
      if (!cancelled) setChatCount(r.ok ? (r.body.media ?? []).filter((m) => m.available).length : 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [orderId, status]);

  const upload = async (file: File | undefined) => {
    if (!file || busy !== null) return;
    if (pendingUpload.current?.file.name !== file.name || pendingUpload.current.file.size !== file.size) pendingUpload.current = { file, key: newRequestKey() };
    const { key } = pendingUpload.current;
    setBusy("upload");
    const form = new FormData();
    form.set("file", file);
    form.set("request_key", key);
    let res: Response | null = null;
    try {
      res = await fetch(`/api/orders/logistics/orders/${orderId}/evidence/upload`, { method: "POST", body: form });
    } catch {
      res = null;
    }
    setBusy(null);
    const body = res ? ((await res.json().catch(() => ({}))) as { error?: string }) : { error: "network_error" };
    if (res?.ok) {
      pendingUpload.current = null;
      toast.success(t("evidenceUploadedToast"));
      done();
      return;
    }
    toast.error(errorText(body.error));
  };

  const start = async () => {
    setBusy("start");
    const r = await postJson(`/api/orders/logistics/orders/${orderId}/packaging`, { action: "start" });
    setBusy(null);
    if (!r.ok) return void toast.error(errorText(r.body.error));
    done();
  };

  const send = async () => {
    setBusy("send");
    const r = await postJson<{ status?: string }>(`/api/orders/logistics/orders/${orderId}/packaging`, { action: "send_template", request_key: sendKey.current });
    setBusy(null);
    if (r.ok) {
      toast.success(t("sentToast"));
      sendKey.current = newRequestKey();
    } else if (r.body.error === "send_uncertain" || r.body.error === "uncertain") {
      toast.warning(t("uncertainToast"));
    } else {
      toast.error(errorText(r.body.error));
    }
    done();
  };

  const resolve = async (resolution: "confirmed_sent" | "confirmed_not_sent") => {
    if (!uncertain || !window.confirm(t(resolution === "confirmed_sent" ? "confirmSentAsk" : "confirmNotSentAsk"))) return;
    setBusy("resolve");
    const r = await postJson(`/api/orders/logistics/orders/${orderId}/packaging`, { action: "resolve", dispatch_id: uncertain.id, resolution });
    setBusy(null);
    if (!r.ok) return void toast.error(errorText(r.body.error));
    sendKey.current = newRequestKey(); // a new send after "it was not delivered" is a NEW operation
    done();
  };

  return (
    <section className="space-y-3" aria-labelledby={`pack-${orderId}`}>
      <h4 id={`pack-${orderId}`} className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <PackageOpen className="size-4 text-muted-foreground" aria-hidden />
        {t("packagingTitle")}
      </h4>

      {completedElsewhere ? (
        <p className="flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-400">
          <CircleCheck className="size-4" aria-hidden />
          {t("remotePackagingBanner")}
        </p>
      ) : null}

      {!completedElsewhere && status === "pending_voucher" ? <p className="text-xs text-muted-foreground">{t("packagingNeedsVoucher")}</p> : null}

      {!completedElsewhere && status === "voucher_validated" ? (
        <Button type="button" size="sm" className="h-8 gap-1.5" disabled={busy !== null} onClick={() => void start()}>
          {busy === "start" ? <Loader2 className="size-3.5 animate-spin" /> : <PackageOpen className="size-3.5" aria-hidden />}
          {t("startPackaging")}
        </Button>
      ) : null}

      {!completedElsewhere && (status === "packing" || status === "ready_for_dispatch") ? (
        <div className="space-y-3">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-foreground">{t("evidenceTitle")}</p>
              {status === "packing" && !uncertain ? (
                <div className="flex flex-wrap justify-end gap-1.5">
                  <input
                    ref={fileInput}
                    type="file"
                    accept={ACCEPTED_FILES}
                    className="sr-only"
                    aria-label={t("uploadEvidence")}
                    onChange={(e) => {
                      void upload(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                  <Button type="button" size="sm" variant="outline" className="h-7 gap-1 text-[11px]" disabled={busy !== null} onClick={() => fileInput.current?.click()}>
                    {busy === "upload" ? <Loader2 className="size-3 animate-spin" /> : <Upload className="size-3" aria-hidden />}
                    {evidence ? t("replaceEvidence") : t("uploadEvidence")}
                  </Button>
                  {chatCount > 0 ? (
                    <Button type="button" size="sm" variant="outline" className="h-7 gap-1 text-[11px]" disabled={busy !== null} onClick={() => setPicking(true)}>
                      <ImageIcon className="size-3" aria-hidden />
                      {t("pickFromChat")}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
            {evidence ? (
              <div className="flex items-center gap-3 rounded-lg border border-border p-2">
                {evidenceUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={evidenceUrl} alt={t("evidenceAlt")} className="size-14 rounded object-cover" />
                ) : (
                  <span className="flex size-14 items-center justify-center rounded bg-muted text-muted-foreground">
                    <ImageIcon className="size-5" aria-hidden />
                  </span>
                )}
                <p className="min-w-0 truncate text-xs text-muted-foreground">{evidence.original_filename}</p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t("noEvidence")}</p>
            )}
          </div>

          {status === "packing" && !uncertain ? (
            <Button type="button" size="sm" className="h-8 gap-1.5" disabled={busy !== null || !evidence} onClick={() => void send()}>
              {busy === "send" ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" aria-hidden />}
              {dispatches.some((d) => d.status === "failed") ? t("retrySend") : t("sendTemplate")}
            </Button>
          ) : null}

          {uncertain ? (
            <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3" role="alert">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-300">
                <TriangleAlert className="size-3.5" aria-hidden />
                {t("uncertainTitle")}
              </p>
              <p className="text-xs text-amber-200/90">{t("uncertainBody")}</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy !== null} onClick={() => void resolve("confirmed_sent")}>
                  {t("confirmedSent")}
                </Button>
                <Button type="button" size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy !== null} onClick={() => void resolve("confirmed_not_sent")}>
                  {t("confirmedNotSent")}
                </Button>
              </div>
            </div>
          ) : null}

          {status === "ready_for_dispatch" ? (
            <p className="flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-400">
              <CircleCheck className="size-4" aria-hidden />
              {t("readyBanner")}
            </p>
          ) : null}
        </div>
      ) : null}

      <EvidencePicker orderId={orderId} open={picking} onClose={() => setPicking(false)} onSelected={done} />
    </section>
  );
}

function EvidencePicker({ orderId, open, onClose, onSelected }: { orderId: string; open: boolean; onClose: () => void; onSelected: () => void }) {
  const t = useTranslations("OrderLogistics");
  const errorText = useErrorText();
  const [items, setItems] = useState<ChatMedia[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setItems(null);
    setError(null);
    void (async () => {
      const r = await api<{ media?: ChatMedia[] }>(`/api/orders/logistics/orders/${orderId}/chat-media`);
      if (cancelled) return;
      if (!r.ok) return void setError(errorText(r.body.error));
      setItems(r.body.media ?? []);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, orderId]);

  const choose = async (messageId: string) => {
    setSelecting(messageId);
    if (!keys.current.has(messageId)) keys.current.set(messageId, newRequestKey());
    const r = await postJson(`/api/orders/logistics/orders/${orderId}/evidence`, { message_id: messageId, request_key: keys.current.get(messageId) });
    setSelecting(null);
    if (!r.ok) return void toast.error(errorText(r.body.error));
    toast.success(t("evidenceSelectedToast"));
    onSelected();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("pickEvidence")}</DialogTitle>
          <DialogDescription>{t("pickEvidenceHint")}</DialogDescription>
        </DialogHeader>
        {error ? <p className="py-6 text-center text-sm text-muted-foreground">{error}</p> : items === null ? (
          <div className="flex justify-center py-8" role="status" aria-label={t("loading")}>
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("chatMediaEmpty")}</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {items.map((m) => (
              <li key={m.message_id} className="space-y-1.5">
                <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/30">
                  {m.preview_url && m.content_type === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={m.preview_url} alt="" className="size-full object-cover" />
                  ) : (
                    <ImageIcon className="size-6 text-muted-foreground" aria-hidden />
                  )}
                </div>
                <Button type="button" size="sm" variant="outline" className="h-7 w-full text-[11px]" disabled={!m.available || selecting !== null} onClick={() => void choose(m.message_id)}>
                  {selecting === m.message_id ? <Loader2 className="size-3 animate-spin" /> : null}
                  {m.available ? t("useThis") : t("notAvailable")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
