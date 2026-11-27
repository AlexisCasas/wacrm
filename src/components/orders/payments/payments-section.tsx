"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { CircleDollarSign, Loader2, PackageCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, newRequestKey, postJson } from "@/components/orders/logistics/api";
import { limaDateTime } from "@/components/orders/logistics/shared";
import { notifyShipmentChanged } from "@/components/orders/shalom/api";
import { OrderAdminSection } from "@/components/orders/payments/order-admin-section";
import { notifyPaymentsChanged, PAYMENT_KINDS, soles, type PaymentKind, type PaymentsPanelData, type PaymentView } from "@/components/orders/payments/api";

// "Pagos" of one order, inside the Pedidos Confirmados detail (PR-06). Total / Pagado / Saldo / Estado, the payments, the audit, the manual delivery and the finalization.
// It reads / writes only through /api/orders/payments/*; the server derives the account and the actor from the session and the database re-validates both flags, the area
// and the role, and COMPUTES the balance: nothing about money is decided here. It renders NOTHING for people without access (Comercial, viewers, no area, flag OFF) and for
// orders that are not tracked (confirmed before PR-06 was activated).

type View = { kind: "loading" } | { kind: "hidden" } | { kind: "error" } | { kind: "ready"; panel: PaymentsPanelData };

const nowLocalInput = () => {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

function useErrorText() {
  const t = useTranslations("OrderPayments");
  return (code?: string | null) => (code && t.has(`err.${code}`) ? t(`err.${code}`) : t("err.generic"));
}

type Draft = { amount: string; kind: PaymentKind; method: string; operation: string; paidAt: string; notes: string; evidenceId: string | null; evidenceName: string | null };
const emptyDraft = (): Draft => ({ amount: "", kind: "advance", method: "", operation: "", paidAt: nowLocalInput(), notes: "", evidenceId: null, evidenceName: null });

// A logical payment attempt keeps the same idempotency key across network failures,
// component remounts and page reloads. A successful response clears the pending key;
// a later intentional payment therefore receives a fresh key.
function stablePaymentRequest(orderId: string, mode: "register" | "correct") {
  // One unresolved logical payment attempt per order/mode. Keep it even if the
  // page reloads and the draft is reconstructed; clear only after server success.
  const storageKey = `wacrm:payment-attempt:${orderId}:${mode}`;
  let requestKey: string;
  try {
    requestKey = sessionStorage.getItem(storageKey) ?? "";
    if (!requestKey) {
      requestKey = newRequestKey();
      sessionStorage.setItem(storageKey, requestKey);
    }
  } catch {
    requestKey = newRequestKey();
  }
  return { requestKey, clear: () => { try { sessionStorage.removeItem(storageKey); } catch { /* storage unavailable */ } } };
}

export function PaymentsSection({ orderId }: { orderId: string }) {
  const t = useTranslations("OrderPayments");
  const locale = useLocale();
  const errorText = useErrorText();
  const [view, setView] = useState<View>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<null | { mode: "register" } | { mode: "correct"; payment: PaymentView }>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [reason, setReason] = useState("");
  const [overReason, setOverReason] = useState("");
  const [requestKey, setRequestKey] = useState(newRequestKey());
  const [acting, setActing] = useState<null | { kind: "void" | "reject" | "confirm-over"; payment: PaymentView }>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [deliveryNote, setDeliveryNote] = useState("");
  const [totalCorrection, setTotalCorrection] = useState<null | { total: string; reason: string }>(null);

  const fetchPanel = useCallback(async (): Promise<View> => {
    const r = await api<PaymentsPanelData>(`/api/orders/payments/orders/${orderId}`);
    if (r.ok) return { kind: "ready", panel: r.body as PaymentsPanelData };
    // No access (flag OFF, other area, viewer, other account) is NOT an error: the section simply does not exist for that person.
    if (r.status === 401 || r.status === 403 || r.status === 404) return { kind: "hidden" };
    return { kind: "error" };
  }, [orderId]);
  const load = useCallback(async () => setView(await fetchPanel()), [fetchPanel]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const next = await fetchPanel();
      if (alive) setView(next);
    })();
    return () => {
      alive = false;
    };
  }, [fetchPanel]);

  if (view.kind === "loading" || view.kind === "hidden") return null;
  if (view.kind === "error") {
    return (
      <section className="space-y-2 rounded-xl border border-border p-4" aria-label={t("title")}>
        <p className="text-xs text-muted-foreground">{t("loadError")}</p>
        <Button type="button" size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => void load()}>{t("retry")}</Button>
      </section>
    );
  }
  const { panel } = view;
  if (!panel.tracked) return null; // historical order: not tracked, nothing to show

  const base = `/api/orders/payments/orders/${orderId}`;
  const when = (iso: string | null) => (iso ? limaDateTime(iso, locale) : "-");
  const run = async (payload: unknown, okMessage?: string) => {
    setBusy(true);
    const r = await postJson<{ pending_balance?: number }>(base, payload);
    setBusy(false);
    if (!r.ok) {
      toast.error(r.body.error === "exceeds_balance" && typeof r.body.pending_balance === "number" ? t("err.exceeds_balance_with", { balance: soles(r.body.pending_balance) }) : errorText(r.body.error));
      return false;
    }
    if (okMessage) toast.success(okMessage);
    await load();
    notifyPaymentsChanged(orderId);
    notifyShipmentChanged(orderId); // the delivery state may have changed the finalization
    return true;
  };

  const startRegister = () => {
    const hint = panel.voucher_candidate?.amount_hint;
    setDraft({ ...emptyDraft(), amount: hint ? hint.toFixed(2) : "", evidenceId: panel.voucher_candidate?.id ?? null, evidenceName: panel.voucher_candidate?.filename ?? null });
    setRequestKey(newRequestKey());
    setForm({ mode: "register" });
  };
  const startCorrect = (p: PaymentView) => {
    setDraft({ amount: p.amount.toFixed(2), kind: p.kind, method: p.method ?? "", operation: p.operation_number ?? "", paidAt: nowLocalInput(), notes: p.notes ?? "", evidenceId: p.evidence_document_id, evidenceName: null });
    setReason("");
    setOverReason("");
    setRequestKey(newRequestKey());
    setForm({ mode: "correct", payment: p });
  };

  const upload = async (file: File) => {
    setBusy(true);
    const body = new FormData();
    body.append("file", file);
    body.append("request_key", newRequestKey());
    try {
      const res = await fetch(`${base}/evidence`, { method: "POST", body });
      const json = (await res.json().catch(() => ({}))) as { proof?: { id: string; original_filename: string }; error?: string };
      if (!res.ok || !json.proof) toast.error(errorText(json.error));
      else setDraft((d) => ({ ...d, evidenceId: json.proof!.id, evidenceName: json.proof!.original_filename }));
    } catch {
      toast.error(errorText("network_error"));
    }
    setBusy(false);
  };

  const submit = async () => {
    const paymentFields = { amount: draft.amount.trim(), kind: draft.kind, method: draft.method.trim() || undefined, operation_number: draft.operation.trim() || undefined, paid_at: new Date(draft.paidAt).toISOString(), evidence_document_id: draft.evidenceId ?? undefined, notes: draft.notes.trim() || undefined };
    const mode = form?.mode === "correct" ? "correct" : "register";
    const attempt = stablePaymentRequest(orderId, mode);
    const payment = { request_key: attempt.requestKey, ...paymentFields };
    const ok =
      form?.mode === "correct"
        ? await run({ action: "correct", payment_id: form.payment.id, expected_version: form.payment.row_version, reason: reason.trim(), overpayment_reason: overReason.trim() || undefined, ...payment }, t("correctedToast"))
        : await run({ action: "register", ...payment }, t("registeredToast"));
    if (ok) {
      attempt.clear();
      setForm(null);
    }
  };

  const validDraft = /^\d{1,7}([.,]\d{1,2})?$/.test(draft.amount.trim()) && Number(draft.amount.replace(",", ".")) > 0 && !Number.isNaN(Date.parse(draft.paidAt)) && (form?.mode !== "correct" || reason.trim() !== "");
  const canConfirmDirect = (p: PaymentView) => p.amount <= panel.pending_balance;
  const statusTone = panel.financial_status === "paid" ? "text-emerald-400" : panel.financial_status === "partially_paid" ? "text-amber-300" : "text-foreground";

  return (
    <>
    <section className="space-y-3 rounded-xl border border-border p-4" aria-labelledby={`payments-${orderId}`}>
      <div className="flex items-center justify-between gap-2">
        <h4 id={`payments-${orderId}`} className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <CircleDollarSign className="size-4 text-muted-foreground" aria-hidden />
          {t("title")}
        </h4>
        {panel.financial_status ? <span className={`rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium ${statusTone}`}>{t(`status.${panel.financial_status}`)}</span> : null}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t("total")}</dt>
        <dd className="font-medium text-foreground">{soles(panel.total)}</dd>
        <dt className="text-muted-foreground">{t("paid")}</dt>
        <dd className="font-medium text-foreground">{soles(panel.paid_confirmed)}</dd>
        <dt className="text-muted-foreground">{t("balance")}</dt>
        <dd className={`font-semibold ${panel.pending_balance > 0 ? "text-amber-300" : "text-emerald-400"}`}>{soles(panel.pending_balance)}</dd>
      </dl>

      {panel.is_supervisor && !panel.delivery.delivered && !panel.finalization ? (
        totalCorrection ? (
          <form className="space-y-2 rounded-lg border border-amber-500/30 p-3" aria-label={t("correctTotalTitle")} onSubmit={(e) => {
            e.preventDefault();
            if (!totalCorrection.total.trim() || !totalCorrection.reason.trim()) return;
            if (window.confirm(t("correctTotalConfirm", { total: soles(Number(totalCorrection.total.replace(",", ".")) || 0) }))) {
              void run({ action: "correct_total", new_total: totalCorrection.total.trim(), reason: totalCorrection.reason.trim() }, t("correctTotalToast")).then((ok) => { if (ok) setTotalCorrection(null); });
            }
          }}>
            <p className="text-xs font-semibold text-foreground">{t("correctTotalTitle")}</p>
            <p className="text-[11px] text-muted-foreground">{t("correctTotalHint", { current: soles(panel.total), balance: soles(panel.pending_balance) })}</p>
            <Input value={totalCorrection.total} onChange={(e) => setTotalCorrection({ ...totalCorrection, total: e.target.value })} inputMode="decimal" aria-label={t("correctTotalAmount")} maxLength={10} className="h-8 text-xs" />
            <Input value={totalCorrection.reason} onChange={(e) => setTotalCorrection({ ...totalCorrection, reason: e.target.value })} aria-label={t("correctReason")} maxLength={300} className="h-8 text-xs" />
            <div className="flex gap-2"><Button type="submit" size="sm" className="h-8 text-xs" disabled={busy}>{t("saveCorrection")}</Button><Button type="button" size="sm" variant="outline" className="h-8 text-xs" onClick={() => setTotalCorrection(null)}>{t("cancel")}</Button></div>
          </form>
        ) : <Button type="button" size="sm" variant="outline" className="h-8 text-xs" disabled={busy} onClick={() => setTotalCorrection({ total: panel.total.toFixed(2), reason: "" })}>{t("correctTotal")}</Button>
      ) : null}

      {panel.finalization ? (
        <p className="flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-400">
          <PackageCheck className="size-4" aria-hidden />
          {t("finalized", { at: when(panel.finalization.finalized_at) })}
        </p>
      ) : panel.delivery.delivered && panel.financial_status !== "paid" ? (
        <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">{t("deliveredWithBalance")}</p>
      ) : panel.financial_status === "paid" && !panel.delivery.delivered ? (
        <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">{t("paidNotDelivered")}</p>
      ) : null}

      <ul className="space-y-2" aria-label={t("paymentsList")}>
        {panel.payments.length === 0 ? <li className="text-xs text-muted-foreground">{t("noPayments")}</li> : null}
        {panel.payments.map((p) => (
          <li key={p.id} className="space-y-1 rounded-lg border border-border/60 p-2.5 text-xs">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium text-foreground">{soles(p.amount)} <span className="font-normal text-muted-foreground">· {t(`kind.${p.kind}`)}{p.method ? ` · ${p.method}` : ""}</span></span>
              <span className={`rounded-full bg-muted px-2 py-0.5 text-[10px] ${p.status === "confirmed" ? "text-emerald-400" : p.status === "voided" || p.status === "rejected" ? "text-muted-foreground line-through" : "text-amber-300"}`}>{t(`pstatus.${p.status}`)}</span>
            </div>
            <p className="text-[11px] text-muted-foreground">{t("paidOn", { at: when(p.paid_at) })} · {t("by", { name: p.registered_by_name })}{p.operation_number ? ` · ${t("operation")} ${p.operation_number}` : ""}</p>
            {p.rejected_reason ? <p className="text-[11px] text-muted-foreground">{t("reasonLine", { reason: p.rejected_reason })}</p> : null}
            {p.voided_reason ? <p className="text-[11px] text-muted-foreground">{t("reasonLine", { reason: p.voided_reason })}</p> : null}
            {p.overpayment_reason ? <p className="text-[11px] text-amber-200/80">{t("overpaymentLine", { reason: p.overpayment_reason })}</p> : null}
            {p.evidence_document_id ? (
              <button type="button" className="text-[11px] font-medium text-primary underline-offset-2 hover:underline" onClick={async () => { const r = await api<{ url: string }>(`/api/orders/payments/documents/${p.evidence_document_id}/url`); if (r.ok && r.body.url) window.open(r.body.url, "_blank", "noopener"); else toast.error(errorText(r.body.error)); }}>
                {t("viewEvidence")}
              </button>
            ) : null}
            <div className="flex flex-wrap gap-2 pt-1">
              {p.status === "recorded" ? (
                <>
                  <Button type="button" size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy} onClick={() => (canConfirmDirect(p) || panel.is_supervisor ? (canConfirmDirect(p) ? void run({ action: "confirm", payment_id: p.id, expected_version: p.row_version }, t("confirmedToast")) : setActing({ kind: "confirm-over", payment: p })) : void run({ action: "confirm", payment_id: p.id, expected_version: p.row_version }))}>{t("confirm")}</Button>
                  <Button type="button" size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy} onClick={() => { setReason(""); setActing({ kind: "reject", payment: p }); }}>{t("reject")}</Button>
                </>
              ) : null}
              {p.status === "confirmed" && panel.is_supervisor ? (
                <>
                  <Button type="button" size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy} onClick={() => startCorrect(p)}>{t("correct")}</Button>
                  <Button type="button" size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy} onClick={() => { setReason(""); setActing({ kind: "void", payment: p }); }}>{t("void")}</Button>
                </>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {acting ? (
        <div className="space-y-2 rounded-lg border border-border p-3" role="group" aria-label={t(`acting.${acting.kind}`)}>
          <p className="text-xs font-medium text-foreground">{t(`acting.${acting.kind}`, { amount: soles(acting.payment.amount) })}</p>
          <Input value={acting.kind === "confirm-over" ? overReason : reason} onChange={(e) => (acting.kind === "confirm-over" ? setOverReason(e.target.value) : setReason(e.target.value))} placeholder={t("reasonPlaceholder")} aria-label={t("reasonPlaceholder")} maxLength={300} className="h-8 text-xs" />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              className="h-8 text-xs"
              disabled={busy || (acting.kind === "confirm-over" ? overReason.trim() === "" : reason.trim() === "")}
              onClick={async () => {
                const p = acting.payment;
                const ok =
                  acting.kind === "void" ? await run({ action: "void", payment_id: p.id, expected_version: p.row_version, reason: reason.trim() }, t("voidedToast"))
                  : acting.kind === "reject" ? await run({ action: "reject", payment_id: p.id, expected_version: p.row_version, reason: reason.trim() }, t("rejectedToast"))
                  : await run({ action: "confirm", payment_id: p.id, expected_version: p.row_version, overpayment_reason: overReason.trim() }, t("confirmedToast"));
                if (ok) setActing(null);
              }}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t("accept")}
            </Button>
            <Button type="button" size="sm" variant="outline" className="h-8 text-xs" onClick={() => setActing(null)}>{t("cancel")}</Button>
          </div>
        </div>
      ) : null}

      {form ? (
        <form className="space-y-2 rounded-lg border border-border p-3" onSubmit={(e) => { e.preventDefault(); if (validDraft) void submit(); }} aria-label={form.mode === "correct" ? t("correctTitle") : t("registerTitle")}>
          <p className="text-xs font-semibold text-foreground">{form.mode === "correct" ? t("correctTitle") : t("registerTitle")}</p>
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1 text-[11px] text-muted-foreground">{t("amount")}<Input value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} inputMode="decimal" autoComplete="off" aria-label={t("amount")} className="h-8 text-xs" /></label>
            <label className="space-y-1 text-[11px] text-muted-foreground">{t("kindLabel")}
              <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as PaymentKind })} aria-label={t("kindLabel")} className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs">
                {PAYMENT_KINDS.map((k) => <option key={k} value={k}>{t(`kind.${k}`)}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-[11px] text-muted-foreground">{t("method")}<Input value={draft.method} onChange={(e) => setDraft({ ...draft, method: e.target.value })} maxLength={40} autoComplete="off" aria-label={t("method")} className="h-8 text-xs" /></label>
            <label className="space-y-1 text-[11px] text-muted-foreground">{t("operation")}<Input value={draft.operation} onChange={(e) => setDraft({ ...draft, operation: e.target.value })} maxLength={60} autoComplete="off" aria-label={t("operation")} className="h-8 text-xs" /></label>
            <label className="col-span-2 space-y-1 text-[11px] text-muted-foreground">{t("paidAtLabel")}<Input type="datetime-local" value={draft.paidAt} onChange={(e) => setDraft({ ...draft, paidAt: e.target.value })} aria-label={t("paidAtLabel")} className="h-8 text-xs" /></label>
            <label className="col-span-2 space-y-1 text-[11px] text-muted-foreground">{t("notes")}<Input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} maxLength={500} aria-label={t("notes")} className="h-8 text-xs" /></label>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">{t("evidence")} <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" aria-label={t("evidence")} className="block text-[11px]" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} /></label>
            {draft.evidenceId ? <p className="text-[11px] text-muted-foreground">{t("evidenceLinked", { name: draft.evidenceName ?? "" })} <button type="button" className="underline" onClick={() => setDraft({ ...draft, evidenceId: null, evidenceName: null })}>{t("unlink")}</button></p> : null}
          </div>
          {form.mode === "correct" ? (
            <>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("correctReason")} aria-label={t("correctReason")} maxLength={300} className="h-8 text-xs" />
              <Input value={overReason} onChange={(e) => setOverReason(e.target.value)} placeholder={t("overReasonOptional")} aria-label={t("overReasonOptional")} maxLength={300} className="h-8 text-xs" />
            </>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" size="sm" className="h-8 text-xs" disabled={!validDraft || busy}>{busy ? <Loader2 className="size-3.5 animate-spin" /> : null}{form.mode === "correct" ? t("saveCorrection") : t("save")}</Button>
            <Button type="button" size="sm" variant="outline" className="h-8 text-xs" onClick={() => setForm(null)}>{t("cancel")}</Button>
          </div>
        </form>
      ) : (
        <Button type="button" size="sm" variant="outline" className="h-8 text-xs" onClick={startRegister} disabled={busy}>{t("register")}</Button>
      )}

      {panel.delivery.delivered ? (
        <p className="text-[11px] text-muted-foreground">{t("deliveredLine", { source: t(`deliverySource.${panel.delivery.source ?? "manual"}`), at: when(panel.delivery.delivered_at) })}</p>
      ) : panel.delivery.can_mark_manual ? (
        <div className="space-y-1.5 rounded-lg border border-border/60 p-2.5">
          <p className="text-[11px] text-muted-foreground">{t("manualDeliveryHint")}</p>
          <Input value={deliveryNote} onChange={(e) => setDeliveryNote(e.target.value)} placeholder={t("deliveryNote")} aria-label={t("deliveryNote")} maxLength={300} className="h-8 text-xs" />
          <Button type="button" size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy} onClick={() => { if (window.confirm(t("manualDeliveryConfirm"))) void run({ action: "mark_delivered", note: deliveryNote.trim() || undefined }, t("deliveredToast")); }}>{t("markDelivered")}</Button>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <button type="button" className="text-[11px] font-medium text-muted-foreground underline-offset-2 hover:underline" onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory}>
          {showHistory ? t("hideHistory") : t("showHistory", { count: panel.events.length })}
        </button>
        {showHistory ? (
          <ul className="space-y-1" aria-label={t("historyTitle")}>
            {panel.events.map((e) => (
              <li key={e.id} className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className="text-foreground">
                  {t.has(`events.${e.event_type}`) ? t(`events.${e.event_type}`) : e.event_type}
                  {e.amount !== null ? ` · ${soles(e.amount)}` : ""}
                  {e.balance_after !== null ? <span className="text-muted-foreground"> · {t("balanceChange", { before: soles(e.balance_before ?? 0), after: soles(e.balance_after) })}</span> : null}
                  <span className="text-muted-foreground"> · {e.actor_name}</span>
                  {e.reason ? <span className="text-muted-foreground"> · {e.reason}</span> : null}
                </span>
                <span className="shrink-0 text-muted-foreground">{limaDateTime(e.created_at, locale)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
      <OrderAdminSection orderId={orderId} panel={panel} onChanged={async () => { await load(); notifyPaymentsChanged(orderId); notifyShipmentChanged(orderId); }} />
    </>
  );
}
