"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { BellRing, Check, Loader2, MessageSquare, PackageCheck, RefreshCw, Truck, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, LOGISTICS_CHANGED_EVENT, postJson } from "@/components/orders/logistics/api";
import { limaDateTime } from "@/components/orders/logistics/shared";
import { notifyShipmentChanged, SHIPMENT_STEPS, type ShipmentPanelData, type ShipmentView } from "@/components/orders/shalom/api";

// "Tracking Shalom" of one order, inside the Pedidos Confirmados detail (PR-05). It reads / writes only through /api/orders/shalom/*; the server derives the
// account and the actor from the session and the database re-validates both flags, the area and the role. It renders NOTHING for people without access
// (Commercial, viewers, no area, flag OFF) and for orders that PR-04 has not left ready_for_dispatch (and have no guide yet).
// The raw Shalom status is never the UI status: only the normalized WACRM one is shown.

type View = { kind: "loading" } | { kind: "hidden" } | { kind: "error" } | { kind: "ready"; panel: ShipmentPanelData };

const NUMERO = /^[0-9]{6,12}$/;
const CODIGO = /^[A-Z0-9]{3,6}$/;

function useErrorText() {
  const t = useTranslations("OrderShipments");
  return (code?: string | null) => (code && t.has(`err.${code}`) ? t(`err.${code}`) : t("err.generic"));
}

export function ShalomSection({ orderId }: { orderId: string }) {
  const t = useTranslations("OrderShipments");
  const locale = useLocale();
  const errorText = useErrorText();
  const [view, setView] = useState<View>({ kind: "loading" });
  const [busy, setBusy] = useState<null | "register" | "correct" | "refresh" | "stop" | "ack" | "message">(null);
  const [numero, setNumero] = useState("");
  const [codigo, setCodigo] = useState("");
  const [correcting, setCorrecting] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    const r = await api<ShipmentPanelData>(`/api/orders/shalom/orders/${orderId}`);
    if (r.ok) return setView({ kind: "ready", panel: r.body as ShipmentPanelData });
    // No access (flag OFF, other area, viewer, other account) is NOT an error: the section simply does not exist for that person.
    if (r.status === 401 || r.status === 403 || r.status === 404) return setView({ kind: "hidden" });
    setView({ kind: "error" });
  }, [orderId]);

  useEffect(() => {
    void load();
    // PR-04 finishing the packaging (ready_for_dispatch) makes the order eligible: reload when the logistics panel says something changed
    const onChange = (e: Event) => {
      const id = (e as CustomEvent<{ orderId: string | null }>).detail?.orderId;
      if (!id || id === orderId) void load();
    };
    window.addEventListener(LOGISTICS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(LOGISTICS_CHANGED_EVENT, onChange);
  }, [load, orderId]);

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
  const s = panel.shipment;
  if (!s && !panel.eligible) return null;

  const run = async (kind: NonNullable<typeof busy>, path: string, payload: unknown, okMessage?: string) => {
    setBusy(kind);
    const r = await postJson<{ queried?: boolean }>(path, payload);
    setBusy(null);
    if (!r.ok) {
      toast.error(errorText(r.body.error));
      return false;
    }
    if (okMessage) toast.success(okMessage);
    await load();
    notifyShipmentChanged(orderId);
    return true;
  };

  const base = `/api/orders/shalom/orders/${orderId}`;
  const validForm = NUMERO.test(numero.trim()) && CODIGO.test(codigo.trim().toUpperCase());
  const form = (submitLabel: string, onSubmit: () => void, onCancel?: () => void) => (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (validForm) onSubmit();
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1 text-[11px] text-muted-foreground">
          {t("numero")}
          <Input value={numero} onChange={(e) => setNumero(e.target.value)} inputMode="numeric" autoComplete="off" aria-label={t("numero")} className="h-8 text-xs" />
        </label>
        <label className="space-y-1 text-[11px] text-muted-foreground">
          {t("codigo")}
          <Input value={codigo} onChange={(e) => setCodigo(e.target.value)} autoComplete="off" aria-label={t("codigo")} className="h-8 text-xs uppercase" />
        </label>
      </div>
      <p className="text-[11px] text-muted-foreground">{t("formHint")}</p>
      <div className="flex gap-2">
        <Button type="submit" size="sm" className="h-8 text-xs" disabled={!validForm || busy !== null}>
          {busy === "register" || busy === "correct" ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {submitLabel}
        </Button>
        {onCancel ? <Button type="button" size="sm" variant="outline" className="h-8 text-xs" onClick={onCancel}>{t("cancel")}</Button> : null}
      </div>
    </form>
  );

  // ---- no guide yet: register it ----
  if (!s) {
    return (
      <section className="space-y-3 rounded-xl border border-border p-4" aria-labelledby={`shalom-${orderId}`}>
        <h4 id={`shalom-${orderId}`} className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Truck className="size-4 text-muted-foreground" aria-hidden />
          {t("guideTitle")}
        </h4>
        <p className="text-xs text-muted-foreground">{t("registerHint")}</p>
        {form(t("register"), () => void run("register", base, { action: "register", numero_orden: numero.trim(), codigo: codigo.trim() }, t("registeredToast")).then((ok) => ok && (setNumero(""), setCodigo(""))))}
      </section>
    );
  }

  const stepIndex = s.logistic_status ? SHIPMENT_STEPS.indexOf(s.logistic_status) : 0;
  const openAlert = panel.alerts.find((a) => a.status !== "resolved");
  const when = (iso: string | null) => (iso ? limaDateTime(iso, locale) : t("never"));
  const closed = s.tracking_state === "delivered" || s.tracking_state === "stopped";
  // PR-05A/B: the pickup block of the CURRENT En destino episode (or the last one, once delivered). Never a Shalom status.
  const episodeMessage = (panel.messages ?? []).find((m) => m.destination_episode === s.destination_episode) ?? null;
  const episodeAlert = panel.alerts.find((a) => a.destination_episode === s.destination_episode) ?? null;
  const showPickup = (s.pickup_state ?? "none") !== "none" || (s.logistic_status === "at_destination" && s.tracking_state !== "stopped");
  const eventLabel = (type: string, from: string | null, to: string | null) =>
    type === "status_changed" ? t("events.status_changed", { to: to ? t(`status.${to}`) : "-" }) : t.has(`events.${type}`) ? t(`events.${type}`) : type;

  return (
    <section className="space-y-3 rounded-xl border border-border p-4" aria-labelledby={`shalom-${orderId}`}>
      <div className="flex items-center justify-between gap-2">
        <h4 id={`shalom-${orderId}`} className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Truck className="size-4 text-muted-foreground" aria-hidden />
          {t("title")}
        </h4>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">{t(`state.${s.tracking_state}`)}</span>
      </div>

      <ol className="grid grid-cols-5 gap-1" aria-label={t("stepsLabel")}>
        {SHIPMENT_STEPS.map((step, i) => {
          const done = i < stepIndex || (s.tracking_state === "delivered" && i === stepIndex);
          const active = i === stepIndex && !done;
          return (
            <li key={step} aria-current={active ? "step" : undefined} className="min-w-0">
              <div className={`h-1.5 rounded-full ${done ? "bg-emerald-500" : active ? "bg-primary" : "bg-muted"}`} />
              <p className={`mt-1.5 flex items-start gap-0.5 text-[10px] leading-tight ${active ? "font-semibold text-foreground" : done ? "text-emerald-400" : "text-muted-foreground"}`}>
                {done ? <Check className="mt-px size-3 shrink-0" aria-hidden /> : null}
                <span>{t(`status.${step}`)}</span>
              </p>
            </li>
          );
        })}
      </ol>

      {openAlert ? (
        <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3" role="alert">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-300">
            <BellRing className="size-3.5" aria-hidden />
            {t("alertTitle")}
          </p>
          <p className="text-xs text-amber-200/90">{t("alertBody")}</p>
          {openAlert.status === "acknowledged" ? (
            <p className="text-[11px] text-amber-200/80">{t("acknowledged", { at: when(openAlert.acknowledged_at) })}</p>
          ) : (
            <Button type="button" size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy !== null} onClick={() => void run("ack", `/api/orders/shalom/alerts/${openAlert.id}/ack`, {}, t("ackedToast"))}>
              {busy === "ack" ? <Loader2 className="size-3 animate-spin" /> : null}
              {t("ack")}
            </Button>
          )}
        </div>
      ) : null}

      {s.tracking_state === "delivered" ? (
        <p className="flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-400">
          <PackageCheck className="size-4" aria-hidden />
          {t("deliveredBanner")}
        </p>
      ) : null}
      {s.tracking_state === "stopped" ? <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">{t("stoppedBanner", { reason: s.stop_reason ?? "-" })}</p> : null}
      {s.tracking_state === "requires_attention" ? (
        <p className="flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200" role="status">
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          {t("attentionBanner")}
        </p>
      ) : null}
      {s.last_error_kind === "exception" ? <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200" role="status">{t("exceptionBanner")}</p> : null}
      {s.last_error_kind && s.last_error_kind !== "exception" && !closed ? (
        <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground" role="status">{t(`errorKind.${s.last_error_kind}`, { code: s.last_error_code ?? "-" })}</p>
      ) : null}

      {s.pickup_state === "abandoned" ? (
        <div className="space-y-1 rounded-lg border border-red-500/30 bg-red-500/10 p-3" role="status">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-red-300">
            <TriangleAlert className="size-3.5" aria-hidden />
            {t("abandonment")} · {t("abandonmentSince", { at: when(s.pickup_abandoned_at) })}
          </p>
          <p className="text-[11px] text-red-200/80">{t("abandonmentNote")}</p>
        </div>
      ) : null}

      {showPickup ? (
        <div className="space-y-1.5 rounded-lg border border-border p-3" aria-label={t("pickupTitle")}>
          <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <MessageSquare className="size-3.5 text-muted-foreground" aria-hidden />
            {t("pickupTitle")}
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">{t("shalomStatus")}</dt>
            <dd className="text-foreground">{s.logistic_status ? t(`status.${s.logistic_status}`) : t("awaitingFirst")}</dd>
            {panel.days_at_destination !== null ? (
              <>
                <dt className="text-muted-foreground">{t("daysAtDestination")}</dt>
                <dd className="text-foreground">{t("daysValue", { count: panel.days_at_destination })}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">{t("pickupState")}</dt>
            <dd className="text-foreground">{t(`pickupStates.${(s.pickup_state ?? "none")}`)}</dd>
            <dt className="text-muted-foreground">{t("internalAlert")}</dt>
            <dd className="text-foreground">{t(`internalAlertStates.${episodeAlert?.status ?? "none"}`)}</dd>
            <dt className="text-muted-foreground">{t("customerMessage")}</dt>
            <dd className="text-foreground">{t(`customerMessageStatus.${episodeMessage?.status ?? "none"}`)}</dd>
          </dl>
          {episodeMessage && (episodeMessage.status === "failed" || episodeMessage.status === "uncertain") ? (
            <div className="flex flex-wrap gap-2 pt-1">
              {episodeMessage.status === "failed" ? (
                <Button type="button" size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy !== null} onClick={() => void run("message", base, { action: "retry_message", message_id: episodeMessage.id }, t("retriedToast"))}>
                  {busy === "message" ? <Loader2 className="size-3 animate-spin" /> : null}
                  {t("retryMessage")}
                </Button>
              ) : (
                <>
                  <Button type="button" size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy !== null} onClick={() => void run("message", base, { action: "resolve_message", message_id: episodeMessage.id, resolution: "confirmed_sent" }, t("resolvedToast"))}>{t("resolveSent")}</Button>
                  <Button type="button" size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy !== null} onClick={() => void run("message", base, { action: "resolve_message", message_id: episodeMessage.id, resolution: "confirmed_not_sent" }, t("resolvedToast"))}>{t("resolveNotSent")}</Button>
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t("numero")}</dt>
        <dd className="font-medium text-foreground">{s.tracking_number}</dd>
        <dt className="text-muted-foreground">{t("codigo")}</dt>
        <dd className="font-medium text-foreground">{s.tracking_code} <span className="text-muted-foreground">· {t("version", { n: s.identifier_version })}</span></dd>
        <dt className="text-muted-foreground">{t("lastPolled")}</dt>
        <dd className="text-foreground">{when(s.last_polled_at)}</dd>
        <dt className="text-muted-foreground">{t("lastUpdate")}</dt>
        <dd className="text-foreground">{when(s.status_changed_at)}</dd>
        {!closed && s.tracking_state !== "requires_attention" ? (
          <>
            <dt className="text-muted-foreground">{t("nextPoll")}</dt>
            <dd className="text-foreground">{when(s.next_poll_at)}</dd>
          </>
        ) : null}
        {s.logistic_status === "at_destination" && s.destination_entered_at ? (
          <>
            <dt className="text-muted-foreground">{t("destinationSince")}</dt>
            <dd className="text-foreground">{when(s.destination_entered_at)}</dd>
          </>
        ) : null}
      </dl>

      {!closed ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" className="h-7 gap-1 text-[11px]" disabled={busy !== null} onClick={() => void run("refresh", base, { action: "refresh" }, t("refreshedToast"))}>
            {busy === "refresh" ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" aria-hidden />}
            {t("refresh")}
          </Button>
          <Button type="button" size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy !== null} onClick={() => { setCorrecting((c) => !c); setNumero(s.tracking_number); setCodigo(s.tracking_code); }}>
            {t("correct")}
          </Button>
          {panel.can_stop ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-[11px]"
              disabled={busy !== null}
              onClick={() => {
                if (window.confirm(t("stopConfirm"))) void run("stop", base, { action: "stop", reason: "manual" }, t("stoppedToast"));
              }}
            >
              {t("stop")}
            </Button>
          ) : null}
        </div>
      ) : null}

      {correcting && !closed
        ? form(t("saveCorrection"), () => void run("correct", base, { action: "correct", numero_orden: numero.trim(), codigo: codigo.trim(), expected_version: s.identifier_version }, t("correctedToast")).then((ok) => ok && setCorrecting(false)), () => setCorrecting(false))
        : null}

      <div className="space-y-1.5">
        <button type="button" className="text-[11px] font-medium text-muted-foreground underline-offset-2 hover:underline" onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory}>
          {showHistory ? t("hideHistory") : t("showHistory", { count: panel.events.length })}
        </button>
        {showHistory ? (
          <div className="space-y-3">
            <ul className="space-y-1" aria-label={t("historyTitle")}>
              {panel.events.map((e) => (
                <li key={e.id} className="flex items-baseline justify-between gap-2 text-[11px]">
                  <span className="text-foreground">{eventLabel(e.event_type, e.from_status, e.to_status)} <span className="text-muted-foreground">· {e.source === "user" ? e.actor_name : t("system")}</span></span>
                  <span className="shrink-0 text-muted-foreground">{limaDateTime(e.created_at, locale)}</span>
                </li>
              ))}
            </ul>
            {panel.polls.length > 0 ? (
              <ul className="space-y-1" aria-label={t("pollsTitle")}>
                {panel.polls.map((p) => (
                  <li key={p.id} className="flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
                    <span>{t(`outcome.${p.outcome}`)}{p.applied ? "" : ` · ${t("ignored")}`}{p.http_status ? ` · ${p.http_status}` : ""}</span>
                    <span className="shrink-0">{limaDateTime(p.started_at, locale)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export type { ShipmentView };
