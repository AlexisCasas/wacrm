export interface AdsReportRow {
  source_id: string | null
  headline: string | null
  contacts: number
  buyers: number
  orders: number
  order_amount: number
  units: number
  products: { name: string; units: number }[]
}

/** One ad bucket of a SOLD product. source_id null = "Sin atribución comprobable" (orders that do not resolve to any ad). */
export interface ProductAdRow {
  source_id: string | null
  /** Same name the full per-ad table shows (headline of that ad's cohort in the period); null = "Sin título" there too. Never invented. */
  headline: string | null
  /** Contacts of this AD in the period, exactly as the full per-ad table reports them (an ad-level figure, not product-specific). null = unattributed bucket. */
  contacts: number | null
  /** Does NOT add up across ads: a contact who bought the product under two ads counts once in each. */
  buyers: number
  orders: number
  units: number
  sales: number
}

/** SOLD product (from order lines), never the advertised product. Additive: independent of every existing metric. */
export interface ProductSalesRow {
  product: string
  buyers: number
  orders: number
  units: number
  /** Sum of item-level subtotals (legacy one-line orders: the order price). Never a prorated share of an order total. */
  sales: number
  /** Orders in this row that came from the legacy header (no item detail). */
  legacy_orders: number
  /** sales / buyers. */
  avg_ticket: number | null
  /** Ads this product's orders resolved to (same attribution as the per-ad report) + the unattributed bucket. null = breakdown function unavailable. */
  ads: ProductAdRow[] | null
}

export interface AdsReport {
  period: { from: string; to: string }
  /** All confirmed orders of the period by sold product. null = the read-only helper function is not available (migration not applied). */
  product_sales: ProductSalesRow[] | null
  /** true = the product -> ad breakdown is available (so the full per-ad table can start collapsed). */
  ad_breakdown_available: boolean
  ads: (AdsReportRow & { conversion_pct: number | null })[]
  unattributed: AdsReportRow | null
  totals: { contacts: number; orders: number; order_amount: number; attributed_orders: number; unattributed_orders: number }
  /** Not available until InkaClick exposes a reliable paid/delivered state. Never derived from "Pedido confirmado". */
  verified_sales: { available: false; reason: string }
  /** ROAS needs ad spend, which WACRM does not have. */
  roas: { available: false; reason: string }
  /** Whether conversions are being sent to Meta for this account. null = not visible to the caller. Informational only. */
  meta_capi: { enabled: boolean; test_mode: boolean } | null
}

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0)) || 0

const money2 = (n: number) => Math.round(n * 100) / 100

/** Rows of ads_results_product_ad_breakdown grouped by the product display name (identical to ads_results_by_product's). null = function unavailable. */
export function buildProductAdBreakdown(rows: unknown[] | null | undefined, adInfo: Map<string, { headline: string | null; contacts: number }>): Map<string, ProductAdRow[]> | null {
  if (!Array.isArray(rows)) return null
  const byProduct = new Map<string, ProductAdRow[]>()
  for (const r of rows) {
    const x = r as Record<string, unknown>
    if (typeof x.product !== 'string') continue
    const source_id = typeof x.source_id === 'string' ? x.source_id : null
    const row: ProductAdRow = {
      source_id,
      headline: source_id === null ? null : (adInfo.get(source_id)?.headline ?? null),
      contacts: source_id === null ? null : (adInfo.get(source_id)?.contacts ?? null),
      buyers: num(x.buyers),
      orders: num(x.orders),
      units: num(x.units),
      sales: money2(num(x.sales)),
    }
    byProduct.set(x.product, [...(byProduct.get(x.product) ?? []), row])
  }
  // Real ads by sales (ties by id), the unattributed bucket always last.
  for (const list of byProduct.values()) {
    list.sort((a, b) => (a.source_id === null ? 1 : 0) - (b.source_id === null ? 1 : 0) || b.sales - a.sales || String(a.source_id).localeCompare(String(b.source_id)))
  }
  return byProduct
}

export function buildProductSales(rows: unknown[] | null | undefined, breakdown: Map<string, ProductAdRow[]> | null = null): ProductSalesRow[] | null {
  if (!Array.isArray(rows)) return null
  return rows.map((r) => {
    const x = r as Record<string, unknown>
    const buyers = num(x.buyers)
    const sales = money2(num(x.sales))
    const product = typeof x.product === 'string' ? x.product : '—'
    return {
      product, buyers, orders: num(x.orders), units: num(x.units), sales, legacy_orders: num(x.legacy_orders), avg_ticket: buyers > 0 ? money2(sales / buyers) : null,
      ads: breakdown === null ? null : (breakdown.get(product) ?? []),
    }
  })
}

export function buildAdsReport(rows: unknown[], from: string, to: string, productRows?: unknown[] | null, breakdownRows?: unknown[] | null): AdsReport {
  const all: AdsReportRow[] = (rows ?? []).map((r) => {
    const x = r as Record<string, unknown>
    return {
      source_id: typeof x.source_id === 'string' ? x.source_id : null,
      headline: typeof x.headline === 'string' ? x.headline : null,
      contacts: num(x.contacts),
      buyers: num(x.buyers),
      orders: num(x.orders),
      order_amount: num(x.order_amount),
      units: num(x.units),
      products: Array.isArray(x.products) ? (x.products as { name: string; units: number }[]) : [],
    }
  })
  const ads = all
    .filter((r) => r.source_id !== null)
    .map((r) => ({ ...r, conversion_pct: r.contacts > 0 ? Math.round((r.buyers / r.contacts) * 1000) / 10 : null }))
  const unattributed = all.find((r) => r.source_id === null) ?? null
  // Names for the drilldown come from the very same rows the full per-ad table renders, so both always show the same name for an ad.
  const breakdown = buildProductAdBreakdown(breakdownRows, new Map(ads.map((a) => [a.source_id as string, { headline: a.headline, contacts: a.contacts }] as const)))
  const product_sales = buildProductSales(productRows, breakdown)
  const attributedOrders = ads.reduce((a, r) => a + r.orders, 0)
  return {
    period: { from, to },
    ads,
    product_sales,
    ad_breakdown_available: product_sales !== null && breakdown !== null,
    unattributed,
    totals: {
      contacts: ads.reduce((a, r) => a + r.contacts, 0),
      orders: attributedOrders + (unattributed?.orders ?? 0),
      order_amount: Math.round((ads.reduce((a, r) => a + r.order_amount, 0) + (unattributed?.order_amount ?? 0)) * 100) / 100,
      attributed_orders: attributedOrders,
      unattributed_orders: unattributed?.orders ?? 0,
    },
    verified_sales: { available: false, reason: 'InkaClick todavía no informa pago/entrega; "Pedido confirmado" no es una venta cobrada.' },
    roas: { available: false, reason: 'No hay inversión publicitaria confiable en WACRM.' },
    meta_capi: null,
  }
}
