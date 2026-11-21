"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowLeft, FileUp, Loader2, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ACCEPTED_FILES, api, newRequestKey, notifyLogisticsChanged, postJson, type CandidateSummary, type DocumentView } from "@/components/orders/logistics/api";
import { limaDateTime, useErrorText } from "@/components/orders/logistics/shared";
import { VoucherReviewDialog } from "@/components/orders/logistics/voucher-review-dialog";

// BULK vouchers: choose N files -> each is stored, read (OCR when a reader exists) and matched with the CONSERVATIVE rule. A single safe match is
// associated automatically; anything ambiguous stays "pendiente de asociar" and a person picks the order. Nothing is validated automatically: every
// voucher still goes through the review. Everything is persisted per document, so closing this screen loses nothing: the list below is rebuilt from the
// server on every visit and "Procesar pendientes" continues where it stopped.

type Outcome =
  | { outcome: "associated"; order_id: string }
  | { outcome: "already_associated" }
  | { outcome: "pending"; reason: string; ocr_error_code: string | null; candidates: CandidateSummary[] };

interface Row {
  doc: DocumentView
  note?: { kind: "processing" | "associated" | "pending" | "error"; reason?: string }
  candidates: CandidateSummary[]
}

const CONCURRENCY = 3;

export function BulkVouchers() {
  const t = useTranslations("OrderLogistics");
  const locale = useLocale();
  const errorText = useErrorText();
  const input = useRef<HTMLInputElement | null>(null);
  const keys = useRef(new Map<string, string>());
  const [rows, setRows] = useState<Row[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "denied" | "error">("loading");
  const [working, setWorking] = useState(false);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await api<{ documents?: DocumentView[] }>("/api/orders/logistics/documents?kind=voucher&status=pending_review&limit=100");
    if (r.status === 403 || r.status === 401) return void setState("denied");
    if (!r.ok) return void setState("error");
    setRows((prev) => {
      const old = new Map(prev.map((p) => [p.doc.id, p]));
      return (r.body.documents ?? []).map((doc) => ({ doc, note: old.get(doc.id)?.note, candidates: old.get(doc.id)?.candidates ?? [] }));
    });
    setState("ready");
  }, []);

  useEffect(() => {
    const id = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(id);
  }, [refresh]);

  const patch = (id: string, change: Partial<Row>) => setRows((rs) => rs.map((r) => (r.doc.id === id ? { ...r, ...change } : r)));

  const processOne = useCallback(
    async (id: string) => {
      patch(id, { note: { kind: "processing" } });
      const r = await postJson<Outcome>(`/api/orders/logistics/documents/${id}/process`, {});
      if (!r.ok) return void patch(id, { note: { kind: "error", reason: r.body.error } });
      const body = r.body as Outcome;
      if (body.outcome === "associated" || body.outcome === "already_associated") patch(id, { note: { kind: "associated" } });
      else patch(id, { note: { kind: "pending", reason: body.reason }, candidates: body.candidates });
    },
    [],
  );

  const runPool = async (ids: string[]) => {
    const queue = [...ids];
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) await processOne(id);
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
    await refresh();
    notifyLogisticsChanged(null);
  };

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || working) return;
    setWorking(true);
    const batch = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : newRequestKey();
    const uploaded: string[] = [];
    let queue = [...files];
    const worker = async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        const id = `${file.name}:${file.size}:${file.lastModified}`;
        if (!keys.current.has(id)) keys.current.set(id, newRequestKey());
        const form = new FormData();
        form.set("file", file);
        form.set("request_key", keys.current.get(id) as string);
        form.set("batch_id", batch);
        let res: Response | null = null;
        try {
          res = await fetch("/api/orders/logistics/documents", { method: "POST", body: form });
        } catch {
          res = null;
        }
        const body = res ? ((await res.json().catch(() => ({}))) as { error?: string; document?: DocumentView }) : { error: "network_error" };
        if (res?.ok && body.document) uploaded.push(body.document.id);
        else toast.error(`${file.name}: ${errorText(body.error)}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    queue = [];
    await refresh();
    await runPool(uploaded);
    setWorking(false);
  };

  const pendingWork = useMemo(() => rows.filter((r) => r.doc.association === "pending" && r.doc.ocr_status !== "done" && r.doc.ocr_status !== "pending").map((r) => r.doc.id), [rows]);

  const processPending = async () => {
    setWorking(true);
    await runPool(pendingWork);
    setWorking(false);
  };

  return (
    <section className="space-y-4" aria-labelledby="bulk-vouchers-title">
      <Link href="/confirmed-orders" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" aria-hidden />
        {t("backToOrders")}
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id="bulk-vouchers-title" className="text-xl font-semibold leading-tight text-foreground">
            {t("bulkTitle")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("bulkSubtitle")}</p>
        </div>
        <div className="flex gap-2">
          <input ref={input} type="file" multiple accept={ACCEPTED_FILES} className="sr-only" aria-label={t("selectFiles")} onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }} />
          {pendingWork.length > 0 ? (
            <Button type="button" variant="outline" disabled={working} onClick={() => void processPending()}>
              {t("processPending", { count: pendingWork.length })}
            </Button>
          ) : null}
          <Button type="button" disabled={working || state !== "ready"} onClick={() => input.current?.click()} className="gap-2">
            {working ? <Loader2 className="size-4 animate-spin" /> : <FileUp className="size-4" aria-hidden />}
            {t("selectFiles")}
          </Button>
        </div>
      </div>

      {state === "loading" ? (
        <div className="flex justify-center py-10" role="status" aria-label={t("loading")}>
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      ) : null}
      {state === "denied" ? <Notice text={t("bulkDenied")} /> : null}
      {state === "error" ? <Notice text={t("loadError")} /> : null}
      {state === "ready" && rows.length === 0 ? <Notice text={t("bulkEmpty")} /> : null}

      {state === "ready" && rows.length > 0 ? (
        <Card className="gap-0 overflow-hidden rounded-xl py-0">
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {rows.map(({ doc, note }) => {
                const associated = doc.association !== "pending";
                return (
                  <li key={doc.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-foreground">{doc.original_filename}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {limaDateTime(doc.created_at, locale)} · {associated ? t(`association.${doc.association}`) : t("association.pending")}
                        {note?.kind === "pending" && note.reason ? ` · ${t.has(`reason.${note.reason}`) ? t(`reason.${note.reason}`) : note.reason}` : ""}
                        {note?.kind === "error" ? ` · ${errorText(note.reason)}` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {note?.kind === "processing" ? <Loader2 className="size-4 animate-spin text-primary" aria-label={t("processing")} /> : null}
                      {!associated ? (
                        <Button type="button" size="sm" variant="outline" className="h-7 text-[11px]" disabled={working || note?.kind === "processing"} onClick={() => setChoosing(doc.id)}>
                          {t("chooseOrder")}
                        </Button>
                      ) : null}
                      <Button type="button" size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => setReviewing(doc.id)}>
                        {associated ? t("reviewAndValidate") : t("view")}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <OrderChooser
        key={choosing ?? "none"}
        document={rows.find((r) => r.doc.id === choosing) ?? null}
        onClose={() => setChoosing(null)}
        onAssociated={async () => {
          setChoosing(null);
          await refresh();
          notifyLogisticsChanged(null);
        }}
      />
      <VoucherReviewDialog documentId={reviewing} onClose={() => setReviewing(null)} onChanged={() => void refresh()} />
    </section>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <Card className="rounded-xl">
      <CardContent className="py-8 text-center text-sm text-muted-foreground">{text}</CardContent>
    </Card>
  );
}

/** A person chooses the order of a voucher the rule could not (or would not) decide: suggestions first, then a search among the orders still waiting. */
function OrderChooser({ document, onClose, onAssociated }: { document: Row | null; onClose: () => void; onAssociated: () => Promise<void> }) {
  const t = useTranslations("OrderLogistics");
  const errorText = useErrorText();
  const [q, setQ] = useState("");
  const [found, setFound] = useState<CandidateSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [associating, setAssociating] = useState<string | null>(null);
  const id = document?.doc.id ?? null;

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      setSearching(true);
      const r = await api<{ orders?: CandidateSummary[] }>(`/api/orders/logistics/orders/pending?q=${encodeURIComponent(q.trim())}`);
      if (!cancelled) {
        setSearching(false);
        setFound(r.ok ? (r.body.orders ?? []) : []);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [id, q]);

  const associate = async (orderId: string) => {
    if (!id) return;
    setAssociating(orderId);
    const r = await postJson(`/api/orders/logistics/documents/${id}/associate`, { order_id: orderId });
    setAssociating(null);
    if (!r.ok) return void toast.error(errorText(r.body.error));
    toast.success(t("associatedToast"));
    await onAssociated();
  };

  const suggestions = document?.candidates ?? [];
  const list = (candidates: CandidateSummary[]) => (
    <ul className="space-y-1.5">
      {candidates.map((c) => (
        <li key={c.order_id} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-foreground">{c.customer_name}</p>
            <p className="truncate text-[11px] text-muted-foreground">
              {c.product_summary} · {c.destination}
              {c.signals.length > 0 ? ` · ${t("sharedSignals", { signals: c.signals.join(", ") })}` : ""}
            </p>
          </div>
          <Button type="button" size="sm" className="h-7 text-[11px]" disabled={associating !== null} onClick={() => void associate(c.order_id)}>
            {associating === c.order_id ? <Loader2 className="size-3 animate-spin" /> : null}
            {t("associate")}
          </Button>
        </li>
      ))}
    </ul>
  );

  return (
    <Dialog open={document !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("chooseOrder")}</DialogTitle>
          <DialogDescription>{t("chooseOrderHint")}</DialogDescription>
        </DialogHeader>
        {suggestions.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-foreground">{t("suggested")}</p>
            {list(suggestions)}
          </div>
        ) : null}
        <div className="space-y-2">
          <p className="text-xs font-semibold text-foreground">{t("searchOrders")}</p>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("searchOrdersPlaceholder")} aria-label={t("searchOrders")} maxLength={80} className="h-9 pl-9" />
          </div>
          {searching ? <Loader2 className="mx-auto size-4 animate-spin text-primary" aria-label={t("loading")} /> : found.length === 0 ? <p className="py-3 text-center text-xs text-muted-foreground">{t("noPendingOrders")}</p> : list(found)}
        </div>
      </DialogContent>
    </Dialog>
  );
}
