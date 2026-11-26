"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Loader2,
  MapPin,
  Package,
  Plus,
  Save,
  Trash2,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { PaymentsPanelData } from "@/components/orders/payments/api";
import { notifyPaymentsChanged } from "@/components/orders/payments/api";

type ItemType = "product" | "accessory";

interface EditableLine {
  product_name: string;
  quantity: string;
  unit_price: string;
  catalog_product_id: string | null;
  item_type: ItemType;
}

interface FormState {
  customer_name: string;
  dni: string;
  phone: string;
  description: string;
  destination: string;
}

const EMPTY_FORM: FormState = {
  customer_name: "",
  dni: "",
  phone: "",
  description: "",
  destination: "",
};

export function LogisticsOrderEditor({
  orderId,
  onChanged,
}: {
  orderId: string;
  onChanged?: () => void;
}) {
  const [panel, setPanel] = useState<PaymentsPanelData | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [lines, setLines] = useState<EditableLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);

    try {
      const res = await fetch(`/api/orders/payments/orders/${orderId}`, {
        cache: "no-store",
      });

      if (!res.ok) throw new Error("panel_read_failed");

      const body = (await res.json()) as PaymentsPanelData;

      if (!body.order) throw new Error("order_missing");

      setPanel(body);
      setPaymentAmount("");

      setForm({
        customer_name: body.order.customer_name ?? "",
        dni: body.order.dni ?? "",
        phone: body.order.phone ?? "",
        description: body.order.order_description ?? "",
        destination: body.order.destination ?? "",
      });

      if ((body.items ?? []).length > 0) {
        setLines(
          (body.items ?? []).map((item) => ({
            product_name: item.product_name,
            quantity: String(item.quantity),
            unit_price: Number(item.unit_price).toFixed(2),
            catalog_product_id: item.catalog_product_id,
            item_type: item.item_type ?? "product",
          })),
        );
      } else {
        const qty =
          Number(body.order.quantity) > 0 ? Number(body.order.quantity) : 1;

        const unitPrice =
          qty > 0 ? Number(body.total ?? 0) / qty : Number(body.total ?? 0);

        setLines([
          {
            product_name: body.order.product ?? "",
            quantity: String(qty),
            unit_price: Number.isFinite(unitPrice)
              ? unitPrice.toFixed(2)
              : "0.00",
            catalog_product_id: null,
            item_type: "product",
          },
        ]);
      }
    } catch {
      setPanel(null);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  const products = useMemo(
    () => lines.filter((line) => line.item_type === "product"),
    [lines],
  );

  const accessories = useMemo(
    () => lines.filter((line) => line.item_type === "accessory"),
    [lines],
  );

  const addLine = (itemType: ItemType) => {
    if (lines.length >= 20) {
      toast.error("El pedido admite como máximo 20 líneas.");
      return;
    }

    setLines((current) => [
      ...current,
      {
        product_name: "",
        quantity: "1",
        unit_price: "",
        catalog_product_id: null,
        item_type: itemType,
      },
    ]);
  };

  const updateLine = (
    target: EditableLine,
    field: "product_name" | "quantity" | "unit_price",
    value: string,
  ) => {
    setLines((current) =>
      current.map((line) =>
        line === target ? { ...line, [field]: value } : line,
      ),
    );
  };

  const removeLine = (target: EditableLine) => {
    setLines((current) => current.filter((line) => line !== target));
  };

  const paymentValue = Number(paymentAmount.replace(",", ".")) || 0;

  const editedTotal = useMemo(
    () =>
      Math.round(
        lines.reduce((sum, line) => {
          const quantity = Number(line.quantity);
          const price = Number(line.unit_price.replace(",", "."));

          if (
            !Number.isFinite(quantity) ||
            !Number.isFinite(price) ||
            quantity <= 0 ||
            price <= 0
          ) {
            return sum;
          }

          return sum + quantity * price;
        }, 0) * 100,
      ) / 100,
    [lines],
  );

  const editedPendingBalance = panel
    ? Math.max(
        Math.round((editedTotal - panel.paid_confirmed) * 100) / 100,
        0,
      )
    : 0;

  const previewBalance = Math.max(
    Math.round((editedPendingBalance - paymentValue) * 100) / 100,
    0,
  );

  const save = async () => {
    if (!panel?.order) return;

    if (!form.customer_name.trim()) {
      toast.error("Completa el nombre del cliente.");
      return;
    }

    if (!form.phone.trim()) {
      toast.error("Completa el teléfono.");
      return;
    }

    if (!form.destination.trim()) {
      toast.error("Completa el destino.");
      return;
    }

    if (!lines.some((line) => line.item_type === "product")) {
      toast.error("Agrega al menos un producto.");
      return;
    }

    if (
      paymentAmount.trim() &&
      (
        !/^\d{1,7}([.,]\d{1,2})?$/.test(paymentAmount.trim()) ||
        paymentValue <= 0
      )
    ) {
      toast.error("Ingresa un pago válido.");
      return;
    }

    if (paymentValue > editedPendingBalance) {
      toast.error("El pago no puede superar el saldo pendiente.");
      return;
    }

    for (const line of lines) {
      const quantity = Number(line.quantity);
      const price = Number(line.unit_price.replace(",", "."));

      if (!line.product_name.trim()) {
        toast.error("Completa todos los productos y accesorios.");
        return;
      }

      if (!Number.isInteger(quantity) || quantity < 1) {
        toast.error("Revisa las cantidades.");
        return;
      }

      if (!Number.isFinite(price) || price <= 0) {
        toast.error("Revisa los precios.");
        return;
      }
    }

    const fields = {
      customer_name: form.customer_name.trim(),
      dni: form.dni.trim(),
      phone: form.phone.trim(),
      destination: form.destination.trim(),
      order_description: form.description.trim(),
      items: lines.map((line) => ({
        product_name: line.product_name.trim(),
        quantity: line.quantity.trim(),
        unit_price: Number(line.unit_price.replace(",", ".")).toFixed(2),
        item_type: line.item_type,
        ...(line.catalog_product_id
          ? { catalog_product_id: line.catalog_product_id }
          : {}),
      })),
    };

    setSaving(true);

    try {
      const res = await fetch(`/api/orders/payments/orders/${orderId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "edit_order",
          fields,
          reason: "Actualización desde panel de Logística",
        }),
      });

      const editResult = (await res.json().catch(() => ({}))) as {
        total?: number | null;
        pending_balance?: number | null;
        error?: string;
      };

      if (!res.ok) throw new Error("save_failed");

      const savedTotal =
        typeof editResult.total === "number"
          ? editResult.total
          : editedTotal;

      const savedPendingBalance =
        typeof editResult.pending_balance === "number"
          ? editResult.pending_balance
          : editedPendingBalance;

      if (paymentValue > savedPendingBalance) {
        toast.error(
          "El pedido se actualizó, pero el pago no se registró porque supera el nuevo saldo.",
        );

        setPaymentAmount("");
        await load();
        notifyPaymentsChanged(orderId);
        onChanged?.();
        return;
      }

      if (paymentValue > 0) {
        const paymentCents = Math.round(paymentValue * 100);
        const totalCents = Math.round(savedTotal * 100);
        const balanceCents = Math.round(savedPendingBalance * 100);

        const kind =
          panel.paid_confirmed === 0 && paymentCents === totalCents
            ? "full"
            : paymentCents === balanceCents
              ? "balance"
              : "advance";

        const registerRes = await fetch(
          `/api/orders/payments/orders/${orderId}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "register",
              request_key: crypto.randomUUID(),
              amount: paymentValue.toFixed(2),
              kind,
              paid_at: new Date().toISOString(),
              notes: "Pago registrado desde panel de Logística",
            }),
          },
        );

        const registered = (await registerRes.json().catch(() => ({}))) as {
          payment_id?: string;
          row_version?: number;
          status?: string;
          error?: string;
        };

        if (
          !registerRes.ok ||
          !registered.payment_id ||
          !registered.row_version
        ) {
          throw new Error("payment_register_failed");
        }

        const confirmRes = await fetch(
          `/api/orders/payments/orders/${orderId}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "confirm",
              payment_id: registered.payment_id,
              expected_version: registered.row_version,
            }),
          },
        );

        if (!confirmRes.ok) {
          throw new Error("payment_confirm_failed");
        }
      }

      toast.success(
        paymentValue > 0
          ? "Pedido y pago actualizados."
          : "Pedido actualizado.",
      );

      setPaymentAmount("");

      await load();
      notifyPaymentsChanged(orderId);
      onChanged?.();
    } catch {
      toast.error("No se pudieron guardar los cambios.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Cargando pedido…
      </div>
    );
  }

  if (loadError || !panel?.order) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
        No se pudieron cargar los datos del pedido.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <section className="space-y-3 rounded-xl border p-4">
        <div className="flex items-center gap-2">
          <UserRound className="size-4 text-muted-foreground" />
          <p className="text-sm font-semibold">Cliente</p>
        </div>

        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            Nombre completo
          </label>
          <Input
            value={form.customer_name}
            onChange={(e) =>
              setForm((current) => ({
                ...current,
                customer_name: e.target.value,
              }))
            }
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              DNI
            </label>
            <Input
              value={form.dni}
              inputMode="numeric"
              onChange={(e) =>
                setForm((current) => ({
                  ...current,
                  dni: e.target.value,
                }))
              }
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              Teléfono
            </label>
            <Input
              value={form.phone}
              inputMode="tel"
              onChange={(e) =>
                setForm((current) => ({
                  ...current,
                  phone: e.target.value,
                }))
              }
            />
          </div>
        </div>
      </section>

      <LineGroup
        title="Productos"
        type="product"
        lines={products}
        onAdd={() => addLine("product")}
        onUpdate={updateLine}
        onRemove={removeLine}
      />

      <LineGroup
        title="Accesorios"
        type="accessory"
        lines={accessories}
        onAdd={() => addLine("accessory")}
        onUpdate={updateLine}
        onRemove={removeLine}
      />

      <section className="space-y-2 rounded-xl border p-4">
        <div className="flex items-center gap-2">
          <Package className="size-4 text-muted-foreground" />
          <p className="text-sm font-semibold">Descripción</p>
        </div>

        <Textarea
          value={form.description}
          rows={3}
          placeholder="Descripción del pedido"
          onChange={(e) =>
            setForm((current) => ({
              ...current,
              description: e.target.value,
            }))
          }
        />
      </section>

      <section className="space-y-3 rounded-xl border p-4">
        <div>
          <p className="text-sm font-semibold">Pago</p>
          <p className="text-xs text-muted-foreground">
            Registra únicamente el monto recibido.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
          <span className="text-muted-foreground">Total</span>
          <span className="text-right font-medium">
            S/ {editedTotal.toFixed(2)}
          </span>

          <span className="text-muted-foreground">Pagado</span>
          <span className="text-right font-medium">
            S/ {panel.paid_confirmed.toFixed(2)}
          </span>
        </div>

        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            Pago
          </label>
          <Input
            value={paymentAmount}
            inputMode="decimal"
            placeholder="0.00"
            onChange={(e) => setPaymentAmount(e.target.value)}
          />
        </div>

        <div className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2 text-sm">
          <span className="text-muted-foreground">
            Saldo
          </span>
          <span className="font-semibold">
            S/ {previewBalance.toFixed(2)}
          </span>
        </div>
      </section>

      <section className="space-y-2 rounded-xl border p-4">
        <div className="flex items-center gap-2">
          <MapPin className="size-4 text-muted-foreground" />
          <p className="text-sm font-semibold">Entrega</p>
        </div>

        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            Destino
          </label>
          <Input
            value={form.destination}
            onChange={(e) =>
              setForm((current) => ({
                ...current,
                destination: e.target.value,
              }))
            }
          />
        </div>
      </section>

      <Button
        type="button"
        className="w-full"
        disabled={saving}
        onClick={() => void save()}
      >
        {saving ? (
          <Loader2 className="mr-2 size-4 animate-spin" />
        ) : (
          <Save className="mr-2 size-4" />
        )}
        Guardar
      </Button>
    </div>
  );
}

function LineGroup({
  title,
  type,
  lines,
  onAdd,
  onUpdate,
  onRemove,
}: {
  title: string;
  type: ItemType;
  lines: EditableLine[];
  onAdd: () => void;
  onUpdate: (
    line: EditableLine,
    field: "product_name" | "quantity" | "unit_price",
    value: string,
  ) => void;
  onRemove: (line: EditableLine) => void;
}) {
  return (
    <section className="space-y-3 rounded-xl border p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">{title}</p>

        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8"
          onClick={onAdd}
        >
          <Plus className="mr-1 size-3.5" />
          {type === "product" ? "Producto" : "Accesorio"}
        </Button>
      </div>

      {lines.length === 0 ? (
        <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
          Sin {type === "product" ? "productos" : "accesorios"}.
        </p>
      ) : (
        <div className="space-y-3">
          {lines.map((line, index) => (
            <div
              key={`${type}-${index}`}
              className="space-y-2 rounded-lg bg-muted/30 p-3"
            >
              <div className="flex gap-2">
                <Input
                  value={line.product_name}
                  placeholder={
                    type === "product"
                      ? "Nombre del producto"
                      : "Nombre del accesorio"
                  }
                  onChange={(e) =>
                    onUpdate(line, "product_name", e.target.value)
                  }
                />

                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-9 shrink-0"
                  onClick={() => onRemove(line)}
                  aria-label="Eliminar"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-[11px] text-muted-foreground">
                    Cantidad
                  </label>
                  <Input
                    value={line.quantity}
                    inputMode="numeric"
                    onChange={(e) =>
                      onUpdate(line, "quantity", e.target.value)
                    }
                  />
                </div>

                <div>
                  <label className="mb-1 block text-[11px] text-muted-foreground">
                    Precio
                  </label>
                  <Input
                    value={line.unit_price}
                    inputMode="decimal"
                    onChange={(e) =>
                      onUpdate(line, "unit_price", e.target.value)
                    }
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
