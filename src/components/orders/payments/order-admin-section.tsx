"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Ban, Loader2, Pencil, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { postJson } from "@/components/orders/logistics/api";
import { limaDateTime } from "@/components/orders/logistics/shared";
import { soles, type PaymentsPanelData } from "@/components/orders/payments/api";

// Autonomous operation of a confirmed order: EDIT (buyer / recipient data, destination, agency, products, quantities, prices) and CANCEL (anulacion).
// Every action is a POST to the payments endpoint; the database re-validates role, flags and order state and writes the audit. The browser never sends money as a balance:
// the new total of an edit is derived from the lines by the database, and a cancellation never deletes a payment (it flags the refund).

type Line = { product_name: string; quantity: string; unit_price: string; item_type: 'product' | 'accessory'; catalog_product_id: string | null };
const TEXT_FIELDS = ["customer_name", "dni", "phone", "destination", "agency", "department", "order_description"] as const;
type TextField = (typeof TEXT_FIELDS)[number];

export function OrderAdminSection({ orderId, panel, onChanged }: { orderId: string; panel: PaymentsPanelData; onChanged: () => Promise<void> }) {
  const t = useTranslations("OrderAdmin");
  const locale = useLocale();
  const [mode, setMode] = useState<null | "edit" | "cancel">(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [ack, setAck] = useState(false);
  const [text, setText] = useState<Record<TextField, string>>({ customer_name: "", dni: "", phone: "", destination: "", agency: "", department: "", order_description: "" });
  const [product, setProduct] = useState("");
  const [quantity, setQuantity] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [showEdits, setShowEdits] = useState(false);

  const order = panel.order;
  if (!order) return null;
  const items = panel.items ?? [];
  const cancelled = panel.cancellation ?? null;
  const closed = panel.delivery.delivered || panel.finalization !== null;
  const paid = Number(panel.paid_confirmed);
  const hasItems = items.length > 0;

  const errText = (code: string) => (t.has(`err.${code}`) ? t(`err.${code}`) : t("err.generic"));
  const post = async (payload: unknown, ok: string) => {
    setBusy(true);
    const r = await postJson<{ paid_confirmed?: number }>(`/api/orders/payments/orders/${orderId}`, payload);
    setBusy(false);
    if (!r.ok) {
      toast.error(r.body.error === "below_paid" && typeof r.body.paid_confirmed === "number" ? t("err.below_paid_with", { paid: soles(r.body.paid_confirmed) }) : errText(String(r.body.error)));
      return false;
    }
    toast.success(ok);
    setMode(null);
    setReason("");
    setAck(false);
    await onChanged();
    return true;
  };

  const openEdit = () => {
    setText({ customer_name: order.customer_name, dni: order.dni ?? "", phone: order.phone, destination: order.destination, agency: order.agency, department: order.department ?? "", order_description: order.order_description ?? "" });
    setProduct(order.product);
    setQuantity(String(order.quantity));
    setLines(items.map((i) => ({ product_name: i.product_name, quantity: String(i.quantity), unit_price: i.unit_price.toFixed(2), item_type: i.item_type ?? 'product', catalog_product_id: i.catalog_product_id })));
    setReason("");
    setMode("edit");
  };

  const submitEdit = () => {
    const fields: Record<string, unknown> = {};
    const base: Record<TextField, string> = { customer_name: order.customer_name, dni: order.dni ?? "", phone: order.phone, destination: order.destination, agency: order.agency, department: order.department ?? "", order_description: order.order_description ?? "" };
    for (const k of TEXT_FIELDS) if (text[k].trim() !== base[k]) fields[k] = text[k].trim();
    if (hasItems) {
      const cur = JSON.stringify(items.map((i) => [i.product_name, String(i.quantity), i.unit_price.toFixed(2), i.item_type ?? 'product']));
      const next = JSON.stringify(lines.map((l) => [l.product_name.trim(), l.quantity.trim(), Number(l.unit_price.replace(",", ".")).toFixed(2), l.item_type]));
      if (cur !== next) fields.items = lines.map((l) => ({ product_name: l.product_name.trim(), quantity: l.quantity.trim(), unit_price: Number(l.unit_price.replace(",", ".")).toFixed(2), item_type: l.item_type, ...(l.catalog_product_id ? { catalog_product_id: l.catalog_product_id } : {}) }));
    } else {
      if (product.trim() !== order.product) fields.product = product.trim();
      if (quantity.trim() !== String(order.quantity)) fields.quantity = quantity.trim();
    }
    if (Object.keys(fields).length === 0) { toast.info(t("noChanges")); return; }
    void post({ action: "edit_order", fields, reason: reason.trim() }, t("editedToast"));
  };

  const linesValid = lines.length > 0 && lines.every((l) => l.product_name.trim() !== "" && /^\d{1,5}$/.test(l.quantity.trim()) && /^\d{1,7}([.,]\d{1,2})?$/.test(l.unit_price.trim()) && Number(l.unit_price.replace(",", ".")) > 0);
  const editValid = reason.trim() !== "" && text.customer_name.trim() !== "" && text.phone.trim() !== "" && text.destination.trim() !== "" && text.agency.trim() !== "" && (hasItems ? linesValid : product.trim() !== "" && /^\d{1,5}$/.test(quantity.trim()));
  const newTotal = hasItems && linesValid ? lines.reduce((sum, l) => sum + Number(l.quantity) * Number(l.unit_price.replace(",", ".")), 0) : null;
  const cancelBlockedByRole = paid > 0 && !panel.is_supervisor;
  const cancelValid = reason.trim() !== "" && !cancelBlockedByRole && (paid === 0 || ack);

  return (
    <section className="space-y-3 rounded-xl border border-border p-4" aria-label={t("title")}>
      <h4 className="flex items-center gap-2 text-sm font-semibold text-foreground"><Pencil className="size-4 text-muted-foreground" aria-hidden />{t("title")}</h4>

      {cancelled ? (
        <div className="space-y-1 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs" role="status">
          <p className="flex items-center gap-1.5 font-semibold text-red-300"><Ban className="size-3.5" aria-hidden />{t("cancelledTitle")}</p>
          <p className="text-muted-foreground">{t("cancelledBy", { who: cancelled.actor_name, at: limaDateTime(cancelled.cancelled_at, locale) })}</p>
          <p className="text-foreground">{cancelled.reason}</p>
          {cancelled.refund_required ? <p className="font-medium text-amber-300">{t("refundRequired", { amount: soles(Number(cancelled.paid_confirmed)) })}</p> : null}
          {cancelled.shipment_stopped ? <p className="text-muted-foreground">{t("shipmentStopped")}</p> : null}
        </div>
      ) : closed ? (
        <p className="text-[11px] text-muted-foreground">{t("closedHint")}</p>
      ) : mode === null ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" className="h-8 text-xs" onClick={openEdit}>{t("edit")}</Button>
          <Button type="button" size="sm" variant="outline" className="h-8 border-red-500/40 text-xs text-red-300" onClick={() => { setReason(""); setAck(false); setMode("cancel"); }}>{t("cancelOrder")}</Button>
        </div>
      ) : mode === "edit" ? (
        <form className="space-y-2" aria-label={t("edit")} onSubmit={(e) => { e.preventDefault(); if (editValid) submitEdit(); }}>
          <div className="grid grid-cols-2 gap-2">
            {TEXT_FIELDS.map((k) => (
              <label key={k} className={`space-y-1 text-[11px] text-muted-foreground ${k === "order_description" ? "col-span-2" : ""}`}>
                {t(`field.${k}`)}
                <Input value={text[k]} onChange={(e) => setText({ ...text, [k]: e.target.value })} maxLength={k === "order_description" ? 1000 : 150} className="h-8 text-xs" />
              </label>
            ))}
          </div>
          {hasItems ? (
            <div className="space-y-1.5">
              <p className="text-[11px] font-medium text-muted-foreground">{t("lines")}</p>
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-[1fr_4rem_5rem_auto] items-center gap-1.5">
                  <Input value={l.product_name} aria-label={t("field.product")} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, product_name: e.target.value, catalog_product_id: null } : x)))} maxLength={150} className="h-8 text-xs" />
                  <Input value={l.quantity} aria-label={t("field.quantity")} inputMode="numeric" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} className="h-8 text-xs" />
                  <Input value={l.unit_price} aria-label={t("field.unit_price")} inputMode="decimal" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unit_price: e.target.value } : x)))} className="h-8 text-xs" />
                  <Button type="button" size="icon" variant="ghost" className="size-8" aria-label={t("removeLine")} disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></Button>
                </div>
              ))}
              <Button type="button" size="sm" variant="outline" className="h-7 text-[11px]" disabled={lines.length >= 20} onClick={() => setLines([...lines, { product_name: "", quantity: "1", unit_price: "", item_type: "product", catalog_product_id: null }])}><Plus className="mr-1 size-3" />{t("addLine")}</Button>
              {newTotal !== null ? <p className="text-[11px] text-muted-foreground">{t("newTotal", { total: soles(newTotal), paid: soles(paid) })}</p> : null}
            </div>
          ) : (
            <div className="grid grid-cols-[1fr_5rem] gap-2">
              <label className="space-y-1 text-[11px] text-muted-foreground">{t("field.product")}<Input value={product} onChange={(e) => setProduct(e.target.value)} maxLength={500} className="h-8 text-xs" /></label>
              <label className="space-y-1 text-[11px] text-muted-foreground">{t("field.quantity")}<Input value={quantity} inputMode="numeric" onChange={(e) => setQuantity(e.target.value)} className="h-8 text-xs" /></label>
              <p className="col-span-2 text-[11px] text-muted-foreground">{t("totalViaCorrection")}</p>
            </div>
          )}
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("reason")} aria-label={t("reason")} maxLength={300} className="h-8 text-xs" />
          <div className="flex gap-2">
            <Button type="submit" size="sm" className="h-8 text-xs" disabled={!editValid || busy}>{busy ? <Loader2 className="size-3.5 animate-spin" /> : null}{t("save")}</Button>
            <Button type="button" size="sm" variant="outline" className="h-8 text-xs" onClick={() => setMode(null)}>{t("back")}</Button>
          </div>
        </form>
      ) : (
        <form className="space-y-2 rounded-lg border border-red-500/30 p-3" aria-label={t("cancelOrder")} onSubmit={(e) => { e.preventDefault(); if (cancelValid && window.confirm(t("cancelConfirm"))) void post({ action: "cancel_order", reason: reason.trim(), acknowledge_paid: ack }, t("cancelledToast")); }}>
          <p className="text-[11px] text-muted-foreground">{t("cancelHint")}</p>
          {paid > 0 ? (
            cancelBlockedByRole ? (
              <p className="text-[11px] font-medium text-amber-300">{t("cancelNeedsSupervisor", { paid: soles(paid) })}</p>
            ) : (
              <label className="flex items-start gap-2 text-[11px] text-amber-300"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />{t("ackRefund", { paid: soles(paid) })}</label>
            )
          ) : null}
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("reason")} aria-label={t("reason")} maxLength={300} className="h-8 text-xs" />
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="destructive" className="h-8 text-xs" disabled={!cancelValid || busy}>{busy ? <Loader2 className="size-3.5 animate-spin" /> : null}{t("confirmCancel")}</Button>
            <Button type="button" size="sm" variant="outline" className="h-8 text-xs" onClick={() => setMode(null)}>{t("back")}</Button>
          </div>
        </form>
      )}

      {(panel.edits ?? []).length > 0 ? (
        <div className="space-y-1.5">
          <button type="button" className="text-[11px] font-medium text-muted-foreground underline-offset-2 hover:underline" onClick={() => setShowEdits((v) => !v)} aria-expanded={showEdits}>{showEdits ? t("hideEdits") : t("showEdits", { count: (panel.edits ?? []).length })}</button>
          {showEdits ? (
            <ul className="space-y-1" aria-label={t("editsTitle")}>
              {(panel.edits ?? []).map((e) => (
                <li key={e.id} className="text-[11px]"><span className="text-foreground">{Object.keys(e.changes).map((k) => (t.has(`field.${k}`) ? t(`field.${k}`) : k)).join(", ")}</span><span className="text-muted-foreground"> · {e.actor_name} · {limaDateTime(e.created_at, locale)} · {e.reason}</span></li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
