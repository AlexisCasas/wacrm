"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import {
  ArrowRight,
  CircleCheck,
  Clock,
  Coins,
  Loader2,
  MapPin,
  MessageSquare,
  PackageCheck,
  Package,
  Search,
  Truck,
  User,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DELIVERY_STATUSES, INTEGRATION_PENDING_STATUSES, type ConfirmedOrder } from "@/lib/orders/confirmed-orders-types";
import { formatPrice, statusInfo, type StatusTone } from "@/lib/orders/history";
import { LogisticsPanel } from "@/components/orders/logistics/logistics-panel";
import { BulkVouchersButton, VoucherIndicator, useLogisticsSummary } from "@/components/orders/logistics/voucher-indicator";

// "Pedidos confirmados" workspace. READ-ONLY consultation of the orders already confirmed in WACRM: it never edits an order, never changes a
// delivery status and never sends anything. What each user sees is decided by the server (GET /api/orders/confirmed); this screen only renders.
// DNI and phone are not part of the payload, so they cannot be shown here.

const ALL = "__all__";
const SEARCH_DEBOUNCE_MS = 300;
const MAX_NAMES_IN_ROW = 3;

/** Desktop column template of the list (and its header). Below md every row stacks instead. */
const COLUMNS =
  "md:grid-cols-[minmax(150px,2fr)_minmax(110px,1.5fr)_minmax(66px,0.7fr)_minmax(78px,0.95fr)_minmax(112px,1.15fr)_minmax(118px,1.25fr)_minmax(80px,1fr)_96px]";

const DOT: Record<StatusTone, string> = {
  neutral: "bg-muted-foreground",
  amber: "bg-amber-500",
  blue: "bg-blue-500",
  green: "bg-emerald-500",
  red: "bg-red-500",
};

const BADGE: Record<StatusTone, string> = {
  neutral: "border-border bg-muted/60 text-muted-foreground",
  amber: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  blue: "border-blue-500/30 bg-blue-500/10 text-blue-300",
  green: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
  red: "border-red-500/30 bg-red-500/10 text-red-300",
};

type LoadState = "loading" | "ready" | "disabled" | "forbidden" | "error";

interface ListResponse {
  orders?: ConfirmedOrder[];
  next_cursor?: string | null;
}

/** Unknown / future delivery states fall back to a neutral "unknown" label instead of breaking the row. */
function deliveryKey(status: string): string {
  return (DELIVERY_STATUSES as readonly string[]).includes(status) ? status : "unknown";
}

// America/Lima, whatever the browser's time zone is: "16 nov 2026" and "12:12".
function limaParts(iso: string, locale: string): { date: string; time: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: "", time: "" };
  const zone = { timeZone: "America/Lima" } as const;
  return {
    date: new Intl.DateTimeFormat(locale, { ...zone, day: "numeric", month: "short", year: "numeric" }).format(d).replace(/\./g, ""),
    time: new Intl.DateTimeFormat(locale, { ...zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d),
  };
}

/** Integration (delivery) badge: small dot + label; the tone comes from the existing status mapping. */
function IntegrationBadge({ status }: { status: string }) {
  const t = useTranslations("ConfirmedOrders");
  const tone = statusInfo(status).tone;
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${BADGE[tone]}`}>
      <span className={`inline-block size-1.5 rounded-full ${DOT[tone]}`} aria-hidden />
      {t(`delivery.${deliveryKey(status)}`)}
    </span>
  );
}

/** Order status badge. The only status that exists today is "Pedido confirmado" (green); anything else reads neutral. */
function OrderStatusBadge({ status }: { status: string }) {
  const tone: StatusTone = status === "Pedido confirmado" ? "green" : "neutral";
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${BADGE[tone]}`}>
      <CircleCheck className="size-3" aria-hidden />
      {status}
    </span>
  );
}

function StatCard({ icon: Icon, label, value, caption }: { icon: typeof Clock; label: string; value: string; caption?: string }) {
  return (
    <Card className="gap-0 rounded-xl py-0">
      <CardContent className="flex items-center gap-3 px-4 py-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden>
          <Icon className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-xs text-muted-foreground">{label}</p>
          <p className="truncate text-xl font-semibold leading-tight tabular-nums text-foreground">{value}</p>
          {caption ? <p className="truncate text-[11px] text-muted-foreground">{caption}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function ConfirmedOrdersWorkspace() {
  const t = useTranslations("ConfirmedOrders");
  const locale = useLocale();
  const router = useRouter();
  const [orders, setOrders] = useState<ConfirmedOrder[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const [status, setStatus] = useState<string>(ALL);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [selected, setSelected] = useState<ConfirmedOrder | null>(null);
  const requestSeq = useRef(0);
  const opener = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  // PR-04: voucher / logistics indicator of the orders on screen. `null` (flag OFF, not logistics, error) = nothing is rendered.
  const logisticsSummary = useLogisticsSummary(orders.map((o) => o.id));

  // Debounce the free-text search so typing does not fire one request per keystroke.
  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [searchInput]);

  const fetchPage = useCallback(
    async (after: string | null): Promise<{ kind: "ok"; body: ListResponse } | { kind: Exclude<LoadState, "loading" | "ready"> }> => {
      const params = new URLSearchParams();
      if (status !== ALL) params.set("status", status);
      if (search) params.set("q", search);
      if (after) params.set("cursor", after);
      try {
        const res = await fetch(`/api/orders/confirmed?${params.toString()}`, { cache: "no-store" });
        if (res.status === 403) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          return { kind: body.error === "feature_disabled" ? "disabled" : "forbidden" };
        }
        if (res.status === 401) return { kind: "forbidden" };
        if (!res.ok) return { kind: "error" };
        return { kind: "ok", body: (await res.json()) as ListResponse };
      } catch {
        return { kind: "error" };
      }
    },
    [status, search],
  );

  // First page: reruns whenever a filter changes (or the user retries). A stale answer (older request) is ignored.
  useEffect(() => {
    const seq = ++requestSeq.current;
    void (async () => {
      setState("loading");
      const result = await fetchPage(null);
      if (seq !== requestSeq.current) return;
      if (result.kind !== "ok") {
        setOrders([]);
        setCursor(null);
        setState(result.kind);
        return;
      }
      setOrders(result.body.orders ?? []);
      setCursor(result.body.next_cursor ?? null);
      setState("ready");
    })();
  }, [fetchPage, reloadKey]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    const result = await fetchPage(cursor);
    if (seq !== requestSeq.current) return;
    setLoadingMore(false);
    if (result.kind !== "ok") {
      setState("error");
      return;
    }
    // Keyset pages do not overlap, but merging by id keeps the list duplicate-free whatever happens.
    setOrders((prev) => {
      const seen = new Set(prev.map((o) => o.id));
      return [...prev, ...(result.body.orders ?? []).filter((o) => !seen.has(o.id))];
    });
    setCursor(result.body.next_cursor ?? null);
  };

  const open = (order: ConfirmedOrder, trigger: HTMLElement | null) => {
    if (!selected) opener.current = trigger;
    setSelected(order);
  };
  const close = () => setSelected(null);

  // Drawer: focus moves to its close button when it opens, Escape closes it, and focus returns to the "Ver pedido" button that opened it.
  useEffect(() => {
    if (!selected) {
      opener.current?.focus?.();
      opener.current = null;
      return;
    }
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  const filtering = status !== ALL || search !== "" || searchInput !== "";
  const clearFilters = () => {
    setStatus(ALL);
    setSearchInput("");
    setSearch("");
  };

  // Summary cards are computed from the orders actually LOADED (the API returns pages, never a global total). While more pages exist the
  // counts show a "+" and every card says it only covers the loaded orders, so no figure ever claims to be the account total.
  // "Pending integration" is a TECHNICAL state (delivery_status), not a logistics one.
  const partial = cursor !== null;
  const pending = orders.filter((o) => INTEGRATION_PENDING_STATUSES.includes(o.delivery_status)).length;
  const amount = orders.reduce((sum, o) => sum + o.total, 0);

  return (
    <section className={`space-y-4 transition-[margin] ${selected ? "2xl:mr-[404px]" : ""}`} aria-labelledby="confirmed-orders-title">
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden>
          <PackageCheck className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 id="confirmed-orders-title" className="text-xl font-semibold leading-tight text-foreground">
            {t("title")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <BulkVouchersButton visible={logisticsSummary !== null} />
      </div>

      {state === "ready" && (
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard icon={PackageCheck} label={t("statOrders")} value={`${orders.length}${partial ? "+" : ""}`} caption={partial ? t("statPartial") : undefined} />
          <StatCard icon={Clock} label={t("statPending")} value={`${pending}${partial ? "+" : ""}`} caption={partial ? t("statPartial") : undefined} />
          <StatCard icon={Coins} label={t("statAmount")} value={formatPrice(amount)} caption={partial ? t("statPartial") : undefined} />
        </div>
      )}

      {state !== "disabled" && state !== "forbidden" && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchLabel")}
              maxLength={80}
              className="h-10 rounded-lg pl-9"
            />
          </div>
          <Select value={status} onValueChange={(v) => v && setStatus(v)}>
            <SelectTrigger aria-label={t("statusFilter")} className="h-10 w-full rounded-lg sm:w-56">
              <SelectValue>{status === ALL ? t("allStatuses") : t(`delivery.${deliveryKey(status)}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("allStatuses")}</SelectItem>
              {DELIVERY_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {t(`delivery.${s}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="button" variant="ghost" size="sm" onClick={clearFilters} disabled={!filtering} className="text-muted-foreground">
            {t("clearFilters")}
          </Button>
        </div>
      )}

      {state === "loading" && (
        <div className="flex items-center justify-center py-12" role="status" aria-label={t("loading")}>
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      )}

      {state === "disabled" && <Notice text={t("disabled")} />}
      {state === "forbidden" && <Notice text={t("forbidden")} />}
      {state === "error" && (
        <Card className="rounded-xl">
          <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
            <p className="text-sm text-muted-foreground">{t("error")}</p>
            <Button variant="outline" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
              {t("retry")}
            </Button>
          </CardContent>
        </Card>
      )}

      {state === "ready" && orders.length === 0 && <Notice text={filtering ? t("emptyFiltered") : t("empty")} />}

      {state === "ready" && orders.length > 0 && (
        <Card className="gap-0 overflow-hidden rounded-xl py-0">
          <CardContent className="overflow-x-auto p-0">
            <div className="md:min-w-[880px]">
            <div className={`hidden gap-x-3 border-b border-border px-4 py-2.5 text-xs font-medium text-muted-foreground md:grid ${COLUMNS}`} aria-hidden>
              <span>{t("colCustomerDate")}</span>
              <span>{t("colProduct")}</span>
              <span>{t("colTotal")}</span>
              <span>{t("colDestination")}</span>
              <span>{t("colOrderStatus")}</span>
              <span>{t("colIntegration")}</span>
              <span>{t("colSeller")}</span>
              <span className="text-right">{t("colAction")}</span>
            </div>
            <ul className="divide-y divide-border">
              {orders.map((o) => {
                const isSelected = selected?.id === o.id;
                const when = limaParts(o.confirmed_at, locale);
                return (
                  <li
                    key={o.id}
                    data-selected={isSelected ? "true" : undefined}
                    onClick={(e) => open(o, (e.currentTarget.querySelector("button") as HTMLElement | null) ?? null)}
                    className={`grid cursor-pointer gap-x-3 gap-y-2 px-4 py-3 transition-colors md:items-center ${COLUMNS} ${
                      isSelected ? "bg-primary-soft ring-1 ring-inset ring-primary/25" : "hover:bg-muted/40"
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground" aria-hidden>
                        <User className="size-3.5" />
                      </span>
                      <div className="min-w-0">
                        <p className="break-words text-[13px] font-semibold leading-tight text-foreground">{o.customer_name}</p>
                        <p className="whitespace-nowrap text-[11px] text-muted-foreground">
                          {when.date} · {when.time}
                        </p>
                      </div>
                    </div>

                    <div className="min-w-0 text-[13px]">
                      {o.is_multiproduct ? (
                        <>
                          <p className="font-medium text-foreground">{t("multiproduct", { count: o.lines.length })}</p>
                          <p className="text-xs leading-snug text-muted-foreground">
                            {o.lines.slice(0, MAX_NAMES_IN_ROW).map((l, i, shown) => (
                              <span key={l.line_number} className="block truncate">
                                {l.product_name}
                                {i < shown.length - 1 || o.lines.length > MAX_NAMES_IN_ROW ? " +" : ""}
                              </span>
                            ))}
                            {o.lines.length > MAX_NAMES_IN_ROW ? <span className="block">{t("moreProducts", { count: o.lines.length - MAX_NAMES_IN_ROW })}</span> : null}
                          </p>
                        </>
                      ) : (
                        <>
                          <p className="truncate font-medium text-foreground">{o.lines[0]?.product_name ?? o.product_summary}</p>
                          <p className="text-xs text-muted-foreground">{t("units", { count: o.quantity })}</p>
                        </>
                      )}
                    </div>

                    <p className="whitespace-nowrap text-[13px] font-semibold tabular-nums text-foreground">{formatPrice(o.total)}</p>

                    <div className="flex min-w-0 items-start gap-1.5 text-[13px]">
                      <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <div className="min-w-0">
                        <p className="truncate text-foreground">{o.destination}</p>
                        <p className="truncate text-xs text-muted-foreground">{o.agency}</p>
                      </div>
                    </div>

                    <div>
                      <OrderStatusBadge status={o.order_status} />
                      <VoucherIndicator summary={logisticsSummary?.[o.id]} />
                    </div>
                    <div>
                      <IntegrationBadge status={o.delivery_status} />
                    </div>

                    <div className="flex min-w-0 items-center gap-1.5 text-[13px] text-foreground">
                      <User className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="break-words leading-tight">{o.seller_name}</span>
                    </div>

                    <div className="md:flex md:justify-end">
                      <Button
                        type="button"
                        size="sm"
                        variant={isSelected ? "default" : "outline"}
                        aria-pressed={isSelected}
                        aria-label={t("openOrder", { customer: o.customer_name })}
                        onClick={(e) => {
                          e.stopPropagation();
                          open(o, e.currentTarget);
                        }}
                        className={`h-7 gap-1 rounded-lg px-2.5 text-[11px] ${isSelected ? "" : "border-primary/40 text-primary hover:bg-primary/10"}`}
                      >
                        {t("viewOrder")}
                        <ArrowRight className="size-3.5" aria-hidden />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
            </div>
          </CardContent>
        </Card>
      )}

      {state === "ready" && orders.length > 0 && (
        <div className="flex items-center gap-3 px-1 text-xs text-muted-foreground">
          <span>{t("showing", { count: orders.length })}</span>
          {cursor && (
            <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore} className="h-8">
              {loadingMore ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("loadMore")}
            </Button>
          )}
        </div>
      )}

      <OrderDrawer
        order={selected}
        locale={locale}
        onClose={close}
        closeRef={closeRef}
        onOpenChat={(conversationId) => router.push(`/inbox?c=${encodeURIComponent(conversationId)}`)}
      />
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

function SectionTitle({ icon: Icon, children }: { icon: typeof Package; children: React.ReactNode }) {
  return (
    <h4 className="flex items-center gap-2 text-sm font-semibold text-foreground">
      <Icon className="size-4 text-muted-foreground" aria-hidden />
      {children}
    </h4>
  );
}

/**
 * Right-hand detail panel. A fixed panel below the app header (not a modal): the list stays usable and another row can be picked while it is
 * open. On small screens it covers the whole content area instead. Closing it (X / Escape) clears the selection in the list.
 */
function OrderDrawer({
  order,
  locale,
  onClose,
  closeRef,
  onOpenChat,
}: {
  order: ConfirmedOrder | null;
  locale: string;
  onClose: () => void;
  closeRef: React.RefObject<HTMLButtonElement | null>;
  onOpenChat: (conversationId: string) => void;
}) {
  const t = useTranslations("ConfirmedOrders");
  if (!order) return null;
  const when = limaParts(order.confirmed_at, locale);

  return (
    <aside
      role="dialog"
      aria-label={t("detailTitle")}
      className="fixed bottom-0 right-0 top-14 z-30 flex w-full flex-col border-l border-border bg-card shadow-xl sm:max-w-[400px] lg:w-[400px]"
    >
      <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
        <h3 className="text-base font-semibold text-foreground">{t("detailTitle")}</h3>
        <Button ref={closeRef} type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label={t("closeDetail")}>
          <X className="size-4" />
        </Button>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary" aria-hidden>
            <Package className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="break-words text-lg font-semibold leading-tight text-foreground">{order.customer_name}</p>
            <p className="text-xs text-muted-foreground">
              {t("confirmedOn", { date: when.date, time: when.time })}
            </p>
          </div>
        </div>

        <dl className="grid grid-cols-[128px_1fr] items-center gap-x-4 gap-y-3 text-sm">
          <dt className="text-muted-foreground">{t("colSeller")}</dt>
          <dd className="flex min-w-0 items-center gap-1.5 text-foreground">
            <User className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{order.seller_name}</span>
          </dd>
          <dt className="text-muted-foreground">{t("colOrderStatus")}</dt>
          <dd>
            <OrderStatusBadge status={order.order_status} />
          </dd>
          <dt className="text-muted-foreground">{t("colIntegration")}</dt>
          <dd>
            <IntegrationBadge status={order.delivery_status} />
          </dd>
        </dl>

        <hr className="border-border" />

        <section className="space-y-3">
          <SectionTitle icon={Package}>{t("detailProducts", { count: order.lines.length })}</SectionTitle>
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t("lineProduct")}</th>
                  <th className="px-2 py-2 text-right font-medium">{t("lineQuantity")}</th>
                  <th className="px-2 py-2 text-right font-medium">{t("lineUnitPrice")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("lineSubtotal")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {order.lines.map((line) => (
                  <tr key={line.line_number} className="align-top">
                    <td className="break-words px-3 py-2 text-foreground">{line.product_name}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{line.quantity}</td>
                    <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{line.unit_price === null ? t("none") : formatPrice(line.unit_price)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{formatPrice(line.subtotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between rounded-lg bg-muted/50 px-4 py-3">
            <span className="text-sm font-medium text-foreground">{t("total")}</span>
            <span className="text-xl font-semibold tabular-nums text-foreground">{formatPrice(order.total)}</span>
          </div>
        </section>

        <hr className="border-border" />

        <section className="space-y-3">
          <SectionTitle icon={Truck}>{t("shipping")}</SectionTitle>
          <dl className="grid grid-cols-[128px_1fr] gap-x-4 gap-y-2.5 text-sm">
            <dt className="text-muted-foreground">{t("colAgency")}</dt>
            <dd className="font-medium text-foreground">{order.agency}</dd>
            <dt className="text-muted-foreground">{t("colDestination")}</dt>
            <dd className="font-medium text-foreground">{order.destination}</dd>
            <dt className="text-muted-foreground">{t("colDepartment")}</dt>
            <dd className="font-medium text-foreground">{order.department || t("none")}</dd>
          </dl>
        </section>

        <LogisticsPanel key={order.id} orderId={order.id} />
      </div>

      <div className="border-t border-border p-5">
        {order.conversation_id ? (
          <Button type="button" className="h-11 w-full gap-2 rounded-lg text-sm font-medium" onClick={() => onOpenChat(order.conversation_id as string)}>
            <MessageSquare className="size-4" aria-hidden />
            {t("openChat")}
          </Button>
        ) : (
          <p className="text-center text-xs text-muted-foreground">{t("noChat")}</p>
        )}
      </div>
    </aside>
  );
}
