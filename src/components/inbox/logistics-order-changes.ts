import type { PaymentsPanelData } from "@/components/orders/payments/api";

// What the Logistics editor may send: ONLY what the person changed, compared with the order as it was loaded.
//
// An order without item rows (confirmed before multi-product) is SHOWN as one line whose unit price is total / quantity. That line is a view, not
// data: sending it back untouched would rewrite `product` as "N x name", create item rows and, when the division is not exact, move the total. The
// same applies to an order whose total was corrected apart from its lines. So the lines travel only when a line really changed.

export type ItemType = "product" | "accessory";

export interface EditableLine {
  product_name: string;
  quantity: string;
  unit_price: string;
  catalog_product_id: string | null;
  item_type: ItemType;
}

export interface FormState {
  customer_name: string;
  dni: string;
  phone: string;
  description: string;
  destination: string;
}

const FIELD_NAMES = {
  customer_name: "customer_name",
  dni: "dni",
  phone: "phone",
  description: "order_description",
  destination: "destination",
} as const satisfies Record<keyof FormState, string>;

export const parsePrice = (value: string) => Number(value.replace(",", "."));

const round2 = (n: number) => Math.round(n * 100) / 100;

export function formFromOrder(order: NonNullable<PaymentsPanelData["order"]>): FormState {
  return {
    customer_name: order.customer_name ?? "",
    dni: order.dni ?? "",
    phone: order.phone ?? "",
    description: order.order_description ?? "",
    destination: order.destination ?? "",
  };
}

export function linesFromPanel(panel: PaymentsPanelData): EditableLine[] {
  const items = panel.items ?? [];
  if (items.length > 0) {
    return items.map((item) => ({
      product_name: item.product_name,
      quantity: String(item.quantity),
      unit_price: Number(item.unit_price).toFixed(2),
      catalog_product_id: item.catalog_product_id,
      item_type: item.item_type ?? "product",
    }));
  }

  const quantity = Number(panel.order?.quantity) > 0 ? Number(panel.order?.quantity) : 1;
  const unitPrice = Number(panel.total ?? 0) / quantity;

  return [
    {
      product_name: panel.order?.product ?? "",
      quantity: String(quantity),
      unit_price: Number.isFinite(unitPrice) ? unitPrice.toFixed(2) : "0.00",
      catalog_product_id: null,
      item_type: "product",
    },
  ];
}

const comparable = (line: EditableLine) => ({
  name: line.product_name.trim(),
  quantity: Number(line.quantity),
  price: parsePrice(line.unit_price).toFixed(2),
  type: line.item_type,
  catalog: line.catalog_product_id,
});

const sameLine = (a: EditableLine, b: EditableLine, ignoreName = false) => {
  const x = comparable(a);
  const y = comparable(b);
  return (
    (ignoreName || x.name === y.name) &&
    x.quantity === y.quantity &&
    x.price === y.price &&
    x.type === y.type &&
    x.catalog === y.catalog
  );
};

export interface OrderChanges {
  /** The `fields` of `edit_order`; empty when there is nothing to edit. */
  fields: Record<string, unknown>;
  /** True when the lines themselves are sent, so the total becomes the sum of the lines. */
  sendsLines: boolean;
  /** The total the order will have once `fields` are applied. */
  total: number;
}

export function buildOrderChanges(
  panel: PaymentsPanelData,
  form: FormState,
  lines: EditableLine[],
): OrderChanges {
  const fields: Record<string, unknown> = {};
  let total = Number(panel.total);

  if (!panel.order) return { fields, sendsLines: false, total };

  const base = formFromOrder(panel.order);
  for (const key of Object.keys(FIELD_NAMES) as Array<keyof FormState>) {
    if (form[key].trim() !== base[key].trim()) fields[FIELD_NAMES[key]] = form[key].trim();
  }

  const baseLines = linesFromPanel(panel);
  const linesChanged =
    lines.length !== baseLines.length || lines.some((line, i) => !sameLine(line, baseLines[i]));

  if (!linesChanged) return { fields, sendsLines: false, total };

  // Only the name of an order without lines changed: it has its own field, which touches neither the lines nor the total.
  if (
    (panel.items ?? []).length === 0 &&
    lines.length === 1 &&
    sameLine(lines[0], baseLines[0], true)
  ) {
    fields.product = lines[0].product_name.trim();
    return { fields, sendsLines: false, total };
  }

  fields.items = lines.map((line) => ({
    product_name: line.product_name.trim(),
    quantity: line.quantity.trim(),
    unit_price: parsePrice(line.unit_price).toFixed(2),
    item_type: line.item_type,
    ...(line.catalog_product_id ? { catalog_product_id: line.catalog_product_id } : {}),
  }));

  total = round2(
    lines.reduce((sum, line) => {
      const quantity = Number(line.quantity);
      const price = parsePrice(line.unit_price);
      return Number.isFinite(quantity) && Number.isFinite(price) && quantity > 0 && price > 0
        ? sum + quantity * price
        : sum;
    }, 0),
  );

  return { fields, sendsLines: true, total };
}
