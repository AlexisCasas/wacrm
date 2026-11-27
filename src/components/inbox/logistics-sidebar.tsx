"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, PackageCheck } from "lucide-react";
import { LogisticsOrderEditor } from "@/components/inbox/logistics-order-editor";
import { DeriveToCommercial } from "@/components/inbox/derive-to-commercial";
import { useAuth } from "@/hooks/use-auth";
import { LogisticsPanel } from "@/components/orders/logistics/logistics-panel";
import { ShalomSection } from "@/components/orders/shalom/shalom-section";

interface ConversationOrder {
  order_id: string;
  product: string;
  confirmed_at: string;
  financial_status: string;
  total: number;
  paid_confirmed: number;
  pending_balance: number;
}

interface ConversationOrdersResponse {
  orders?: ConversationOrder[];
  error?: string;
}

const money = (value: number) => `S/ ${value.toFixed(2)}`;

export function LogisticsSidebar({
  conversationId,
}: {
  conversationId: string | null;
}) {
  const [orders, setOrders] = useState<ConversationOrder[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const { canSendMessages } = useAuth();

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!conversationId) {
        setOrders([]);
        setSelectedOrderId("");
        setLoadError(false);
        return;
      }

      setLoading(true);
      setLoadError(false);

      try {
        const res = await fetch(
          `/api/orders/payments/conversation?conversation_id=${encodeURIComponent(conversationId)}`,
          { cache: "no-store" },
        );

        if (!res.ok) throw new Error("orders_read_failed");

        const body = (await res.json()) as ConversationOrdersResponse;
        const next = Array.isArray(body.orders) ? body.orders : [];

        if (cancelled) return;

        setOrders(next);
        setSelectedOrderId((current) => {
          if (current && next.some((order) => order.order_id === current)) {
            return current;
          }

          // The service returns them oldest -> newest.
          // Default to the most recently confirmed tracked order.
          return next.at(-1)?.order_id ?? "";
        });
      } catch {
        if (!cancelled) {
          setOrders([]);
          setSelectedOrderId("");
          setLoadError(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [conversationId, refreshToken]);

  const selectedOrder = useMemo(
    () => orders.find((order) => order.order_id === selectedOrderId) ?? null,
    [orders, selectedOrderId],
  );

  return (
    <aside className="flex h-full w-[380px] xl:w-[420px] flex-col border-l bg-background">
      <div className="border-b px-5 py-4">
        <p className="text-sm font-semibold">Logística</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Gestión del pedido de esta conversación
        </p>
        {/* Outside the order list on purpose: a chat with no tracked order also has to be handed back. The server decides who sees it. */}
        {canSendMessages ? (
          <DeriveToCommercial
            key={`routing-${conversationId ?? "none"}`}
            conversationId={conversationId}
          />
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {!conversationId ? (
          <div className="rounded-lg border border-dashed p-5 text-center text-sm text-muted-foreground">
            Selecciona una conversación para ver su pedido.
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Cargando pedido…
          </div>
        ) : loadError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
            No se pudo cargar la información logística.
          </div>
        ) : orders.length === 0 ? (
          <div className="rounded-lg border border-dashed p-5 text-center">
            <PackageCheck className="mx-auto mb-2 size-5 text-muted-foreground" />
            <p className="text-sm font-medium">Sin pedido confirmado</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Esta conversación todavía no tiene un pedido disponible para Logística.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {orders.length > 1 ? (
              <section className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground">
                  Pedido
                </label>

                <Select
                  value={selectedOrderId}
                  onValueChange={(value) => setSelectedOrderId(value ?? "")}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Seleccionar pedido" />
                  </SelectTrigger>

                  <SelectContent>
                    {orders.map((order) => (
                      <SelectItem key={order.order_id} value={order.order_id}>
                        {order.product} · {money(order.total)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </section>
            ) : null}

            {selectedOrder ? (
              <>
                <section className="rounded-xl border p-4">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Pedido
                      </p>
                      <p className="mt-1 line-clamp-2 text-sm font-semibold">
                        {selectedOrder.product}
                      </p>
                    </div>

                    <PackageCheck className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <p className="text-[11px] text-muted-foreground">Total</p>
                      <p className="mt-0.5 text-sm font-medium">
                        {money(selectedOrder.total)}
                      </p>
                    </div>

                    <div>
                      <p className="text-[11px] text-muted-foreground">Pagado</p>
                      <p className="mt-0.5 text-sm font-medium">
                        {money(selectedOrder.paid_confirmed)}
                      </p>
                    </div>

                    <div>
                      <p className="text-[11px] text-muted-foreground">Saldo</p>
                      <p className="mt-0.5 text-sm font-semibold">
                        {money(selectedOrder.pending_balance)}
                      </p>
                    </div>
                  </div>
                </section>

                <LogisticsOrderEditor
                  orderId={selectedOrder.order_id}
                  onChanged={() => setRefreshToken((value) => value + 1)}
                />

                <section className="space-y-3">
                  <div>
                    <p className="text-sm font-semibold">Preparación y voucher</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Evidencia logística y documentación del pedido.
                    </p>
                  </div>

                  <LogisticsPanel orderId={selectedOrder.order_id} />
                </section>

                <section className="space-y-3">
                  <div>
                    <p className="text-sm font-semibold">Envío · Shalom</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Orden, código y seguimiento del despacho.
                    </p>
                  </div>

                  <ShalomSection orderId={selectedOrder.order_id} />
                </section>
              </>
            ) : null}
          </div>
        )}
      </div>
    </aside>
  );
}
