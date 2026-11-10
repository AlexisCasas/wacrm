import { describe, expect, it } from 'vitest'
import { buildAdsReport } from '@/lib/meta-capi/report'
import { attachMetaCatalog, reportAdIds, type CatalogRow } from './enrich'

const ID1 = '120256299148760285'
const ID2 = '120255157385110285'
const row = (over: Partial<CatalogRow> = {}): CatalogRow => ({ ad_id: ID1, name: 'Rectificadora Video', adset_name: 'Conjunto A', campaign_name: 'Campaña A', status: 'ACTIVE', effective_status: 'ACTIVE', last_synced_at: '2026-11-10T16:00:00Z', ...over })
const mk = () =>
  buildAdsReport(
    [
      { source_id: ID1, headline: 'InkaClick', contacts: 4, buyers: 1, orders: 1, order_amount: 99, units: 2, products: [{ name: 'Laser', units: 2 }] },
      { source_id: ID2, headline: 'InkaClick', contacts: 9, buyers: 0, orders: 0, order_amount: 0, units: 0, products: [] },
      { source_id: '(sin id de anuncio)', headline: null, contacts: 1, buyers: 0, orders: 0, order_amount: 0, units: 0, products: [] },
      { source_id: null, contacts: 0, buyers: 0, orders: 3, order_amount: 30, units: 3, products: [] },
    ],
    'f', 't',
    [{ product: 'Taladro', buyers: 1, orders: 1, units: 2, sales: 99, legacy_orders: 0 }],
    [{ product: 'Taladro', source_id: ID1, buyers: 1, orders: 1, units: 2, sales: 99 }, { product: 'Taladro', source_id: null, buyers: 0, orders: 0, units: 0, sales: 0 }],
  )

describe('attachMetaCatalog', () => {
  it('adds the REAL name/campaign/adset/status and keeps every source_id and number untouched', () => {
    const base = JSON.parse(JSON.stringify(mk()))
    const r = attachMetaCatalog(mk(), [row()], '2026-11-10T16:00:00Z')
    expect(r.ads.find((a) => a.source_id === ID1)?.meta).toEqual({ name: 'Rectificadora Video', campaign_name: 'Campaña A', adset_name: 'Conjunto A', status: 'ACTIVE', effective_status: 'ACTIVE' })
    expect(r.product_sales?.[0].ads?.find((a) => a.source_id === ID1)?.meta?.name).toBe('Rectificadora Video')
    expect(r.meta_catalog).toEqual({ available: true, synced_at: '2026-11-10T16:00:00Z' })
    // source ids, headlines and all figures are exactly the pre-enrichment ones
    const strip = (x: typeof r) => JSON.parse(JSON.stringify({ ...x, meta_catalog: undefined, ads: x.ads.map((a) => ({ ...a, meta: undefined })), product_sales: x.product_sales?.map((p) => ({ ...p, ads: p.ads?.map((a) => ({ ...a, meta: undefined })) })) }))
    expect(strip(r)).toEqual(strip(base))
    expect(r.ads.map((a) => a.source_id)).toEqual(base.ads.map((a: { source_id: string }) => a.source_id))
  })
  it('an ad missing from the synced catalog is "not synced" (meta = null): never named from its headline', () => {
    const r = attachMetaCatalog(mk(), [row()], '2026-11-10T16:00:00Z')
    const missing = r.ads.find((a) => a.source_id === ID2)!
    expect(missing.meta).toBeNull()
    expect(missing.headline).toBe('InkaClick')
  })
  it('the unattributed bucket and the "(sin id de anuncio)" placeholder are not ads: no meta at all', () => {
    const r = attachMetaCatalog(mk(), [row()], '2026-11-10T16:00:00Z')
    expect(r.ads.find((a) => a.source_id === '(sin id de anuncio)')?.meta).toBeUndefined()
    expect(r.product_sales?.[0].ads?.find((a) => a.source_id === null)?.meta).toBeUndefined()
  })
  it('FALLBACK: lookup failed (null) or nothing synced yet => the report is returned exactly as it was', () => {
    const base = JSON.stringify(mk())
    expect(JSON.stringify(attachMetaCatalog(mk(), null, '2026-11-10T16:00:00Z'))).toBe(base)
    expect(JSON.stringify(attachMetaCatalog(mk(), undefined, '2026-11-10T16:00:00Z'))).toBe(base)
    expect(JSON.stringify(attachMetaCatalog(mk(), [row()], null))).toBe(base)
    expect(JSON.stringify(attachMetaCatalog(mk(), [row()], undefined))).toBe(base)
  })
})

describe('reportAdIds', () => {
  it('lists each real Meta ad id once (ads + drilldown), never the placeholder or the unattributed bucket', () => {
    expect(reportAdIds(mk()).sort()).toEqual([ID2, ID1].sort())
  })
})
