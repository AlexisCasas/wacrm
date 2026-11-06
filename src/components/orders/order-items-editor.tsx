"use client";

import { useEffect, useState } from "react";
import { Plus, Search, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { normalizePrice } from "@/lib/orders/money";
import { priceToCents } from "@/lib/orders/items";

// Stable identity prevents stale catalog suggestions transferring to a
// different line after another line is removed. This is UI-only metadata.
let nextDraftRow = 0;
const nextRowId = () => "line-" + (++nextDraftRow);

export interface DraftOrderItem {
  row_id?: string;
  product_name: string;
  quantity: string;
  unit_price: string;
  catalog_product_id: string | null;
}

export const emptyOrderItem = (): DraftOrderItem => ({
  row_id: nextRowId(),
  product_name: "",
  quantity: "1",
  unit_price: "",
  catalog_product_id: null,
});

export function subtotalCents(item: DraftOrderItem): number | null {
  const price = normalizePrice(item.unit_price);
  if (!price || !/^[0-9]{1,5}$/.test(item.quantity)) return null;
  const qty = Number(item.quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > 10000) return null;
  const subtotal = priceToCents(price) * qty;
  return Number.isSafeInteger(subtotal) && subtotal < 1_000_000_000 ? subtotal : null;
}

export function moneyDisplay(cents: number): string {
  return "S/ " + Math.floor(cents / 100) + "." + String(cents % 100).padStart(2, "0");
}

// A historical order's price is a TOTAL, not necessarily a unit price.
export function draftFromLegacy(values: { product: string; quantity: string; price: string }): DraftOrderItem {
  const q = /^[0-9]{1,5}$/.test(values.quantity.trim()) && Number(values.quantity) > 0 && Number(values.quantity) <= 10000
    ? values.quantity.trim() : "1";
  return {
    row_id: nextRowId(),
    product_name: values.product.includes("\n") ? "" : values.product.trim(),
    quantity: q,
    unit_price: q === "1" ? values.price : "",
    catalog_product_id: null,
  };
}

export const itemsForSubmission = (items: DraftOrderItem[]) => items.map((item) => ({
  product_name: item.product_name,
  quantity: item.quantity,
  unit_price: item.unit_price,
  catalog_product_id: item.catalog_product_id,
}));

interface CatalogProduct {
  id: string;
  display_name: string;
  active: boolean;
}

/** Explicit catalog search is separate from free-text product entry.
 * Selecting an item copies only its ID/name; unit prices are never invented.
 * This panel is mounted only while open, so stale suggestions cannot leak
 * between different products or survive closing the picker. */
function CatalogPicker({
  index, onSelect,
}: {
  index: number;
  onSelect: (product: CatalogProduct) => void;
}) {
  const t = useTranslations("Orders");
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<CatalogProduct[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      setStatus("loading");
      try {
        const response = await fetch("/api/orders/products?q=" + encodeURIComponent(q), {
          cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) throw new Error("catalog_unavailable");
        const body = (await response.json()) as { products?: CatalogProduct[] };
        if (!controller.signal.aborted) {
          setOptions((body.products ?? []).filter((p) => p.active).slice(0, 10));
          setStatus("ready");
        }
      } catch {
        if (!controller.signal.aborted) {
          setOptions([]);
          setStatus("error");
        }
      }
    }, 300);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [query]);

  const q = query.trim();
  return (
    <div className="grid gap-2 rounded-md border bg-muted/20 p-2" data-testid={"order-catalog-picker-" + index}>
      <Label htmlFor={"order-catalog-search-" + index}>{t("lineCatalogSearchLabel")}</Label>
      <Input
        id={"order-catalog-search-" + index}
        type="search"
        value={query}
        autoComplete="off"
        placeholder={t("lineCatalogSearchPlaceholder")}
        onChange={(e) => {
          setQuery(e.target.value);
          setOptions([]);
          setStatus("idle");
        }}
      />
      {q.length < 2 ? (
        <p className="text-xs text-muted-foreground">{t("lineCatalogSearchPlaceholder")}</p>
      ) : status === "loading" || status === "idle" ? (
        <p role="status" className="text-xs text-muted-foreground">{t("lineCatalogSearching")}</p>
      ) : status === "error" ? (
        <p role="status" className="text-xs text-muted-foreground">{t("lineCatalogUnavailable")}</p>
      ) : options.length === 0 ? (
        <p role="status" className="text-xs text-muted-foreground">{t("lineCatalogNoResults")}</p>
      ) : (
        <div className="grid max-h-48 gap-1 overflow-y-auto rounded-md border bg-popover p-1" data-testid={"order-catalog-search-results-" + index}>
          {options.map((product) => (
            <button
              key={product.id}
              type="button"
              className="rounded-sm px-2 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent"
              onClick={() => onSelect(product)}
            >
              {product.display_name}
            </button>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t("lineCatalogManualHint")}</p>
    </div>
  );
}

function ProductNameInput({
  item, index, change,
}: {
  item: DraftOrderItem;
  index: number;
  change: (patch: Partial<DraftOrderItem>) => void;
}) {
  const t = useTranslations("Orders");
  const [options, setOptions] = useState<CatalogProduct[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);

  useEffect(() => {
    if (catalogOpen || item.catalog_product_id || item.product_name.trim().length < 2) return;
    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      try {
        const url = "/api/orders/products?q=" + encodeURIComponent(item.product_name.trim());
        const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("catalog_unavailable");
        const body = (await response.json()) as { products?: CatalogProduct[] };
        if (!controller.signal.aborted) {
          setOptions((body.products ?? []).filter((p) => p.active).slice(0, 6));
          setUnavailable(false);
        }
      } catch {
        if (!controller.signal.aborted) {
          setOptions([]);
          setUnavailable(true);
        }
      }
    }, 300);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [item.product_name, item.catalog_product_id, catalogOpen]);

  const shown = !item.catalog_product_id && item.product_name.trim().length >= 2;
  return (
    <div className="grid gap-1 sm:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor={"order-item-product-" + index}>{t("lineProductName")}</Label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={catalogOpen}
          aria-controls={"order-catalog-picker-" + index}
          onClick={() => setCatalogOpen((open) => !open)}
        >
          <Search className="mr-1 size-4" />
          {catalogOpen ? t("lineCatalogClose") : t("lineCatalogBrowse")}
        </Button>
      </div>
      <Input
        id={"order-item-product-" + index}
        value={item.product_name}
        maxLength={150}
        autoComplete="off"
        onChange={(e) => {
          setOptions([]);
          setUnavailable(false);
          change({ product_name: e.target.value, catalog_product_id: null });
        }}
      />
      {catalogOpen ? (
        <CatalogPicker
          index={index}
          onSelect={(product) => {
            change({ product_name: product.display_name, catalog_product_id: product.id });
            setOptions([]);
            setUnavailable(false);
            setCatalogOpen(false);
          }}
        />
      ) : item.catalog_product_id ? (
        <p className="text-xs text-muted-foreground">{t("lineFromCatalog")}</p>
      ) : shown && options.length > 0 ? (
        <div className="grid max-h-40 gap-1 overflow-y-auto rounded-md border bg-popover p-1" data-testid={"order-catalog-options-" + index}>
          {options.map((p) => (
            <button
              key={p.id}
              type="button"
              className="rounded-sm px-2 py-1 text-left text-sm hover:bg-accent focus-visible:bg-accent"
              onClick={() => {
                change({ product_name: p.display_name, catalog_product_id: p.id });
                setOptions([]);
              }}
            >
              {p.display_name}
            </button>
          ))}
        </div>
      ) : shown && unavailable ? (
        <p className="text-xs text-muted-foreground">{t("lineCatalogUnavailable")}</p>
      ) : null}
    </div>
  );
}

interface Props {
  items: DraftOrderItem[];
  onChange: (items: DraftOrderItem[]) => void;
  error?: string | null;
}

export function OrderItemsEditor({ items, onChange, error }: Props) {
  const t = useTranslations("Orders");
  const subtotals = items.map(subtotalCents);
  const total = subtotals.every((amount) => amount !== null)
    ? subtotals.reduce<number>((sum, amount) => sum + (amount ?? 0), 0)
    : null;
  const totalQty = items.reduce((sum, item) => sum + (/^[0-9]{1,5}$/.test(item.quantity) ? Number(item.quantity) : 0), 0);
  const change = (index: number, patch: Partial<DraftOrderItem>) => {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  return (
    <section className="grid gap-3 rounded-md border p-3" aria-label={t("lineItemsHeading")} data-testid="order-items-editor">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">{t("lineItemsHeading")}</h3>
        <Button type="button" size="sm" variant="outline" disabled={items.length >= 20} onClick={() => onChange([...items, emptyOrderItem()])}>
          <Plus className="mr-1 size-4" />{t("lineAdd")}
        </Button>
      </div>
      {items.map((item, index) => (
        <div key={item.row_id ?? index} className="grid gap-2 rounded-md border bg-muted/20 p-2" data-testid={"order-item-" + index}>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{t("lineNumber", { number: index + 1 })}</span>
            <Button type="button" variant="ghost" size="sm" aria-label={t("lineRemove")} disabled={items.length === 1}
              onClick={() => onChange(items.filter((_, i) => i !== index))}>
              <Trash2 className="size-4" />
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <ProductNameInput item={item} index={index} change={(patch) => change(index, patch)} />
            <div className="grid gap-1">
              <Label htmlFor={"order-item-quantity-" + index}>{t("lineQuantity")}</Label>
              <Input id={"order-item-quantity-" + index} value={item.quantity} inputMode="numeric"
                onChange={(e) => change(index, { quantity: e.target.value })} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor={"order-item-unit-price-" + index}>{t("lineUnitPrice")}</Label>
              <Input id={"order-item-unit-price-" + index} value={item.unit_price} inputMode="decimal"
                onChange={(e) => change(index, { unit_price: e.target.value })} />
            </div>
          </div>
          <div className="text-right text-sm text-muted-foreground">
            {t("lineSubtotal")}: <span className="font-medium text-foreground">{subtotals[index] === null ? "—" : moneyDisplay(subtotals[index]!)}</span>
          </div>
        </div>
      ))}
      <div className="flex items-center justify-between border-t pt-2 text-sm font-semibold" data-testid="order-items-total">
        <span>{t("lineUnitsTotal", { count: totalQty })}</span>
        <span>{total === null ? "—" : moneyDisplay(total)}</span>
      </div>
      {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
    </section>
  );
}
