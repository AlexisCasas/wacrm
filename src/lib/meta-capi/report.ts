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
}

export interface AdsReport {
  period: { from: string; to: string }
  /** All confirmed orders of the period by sold product. null = the read-only helper function is not available (migration not applied). */
  product_sales: ProductSalesRow[] | null
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

export function buildProductSales(rows: unknown[] | null | undefined): ProductSalesRow[] | null {
  if (!Array.isArray(rows)) return null
  return rows.map((r) => {
    const x = r as Record<string, unknown>
    const buyers = num(x.buyers)
    const sales = money2(num(x.sales))
    return { product: typeof x.product === 'string' ? x.product : '—', buyers, orders: num(x.orders), units: num(x.units), sales, legacy_orders: num(x.legacy_orders), avg_ticket: buyers > 0 ? money2(sales / buyers) : null }
  })
}

export function buildAdsReport(rows: unknown[], from: string, to: string, productRows?: unknown[] | null): AdsReport {
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
  const attributedOrders = ads.reduce((a, r) => a + r.orders, 0)
  return {
    period: { from, to },
    ads,
    product_sales: buildProductSales(productRows),
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
