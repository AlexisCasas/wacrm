// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import AdsResultsPage from './page'
import { adName, adStatus, PRODUCTS_VISIBLE, splitProducts } from './ads-results-by-ad'
import { buildAdsReport, type AdsReport } from '@/lib/meta-capi/report'
import { attachMetaCatalog, type CatalogRow } from '@/lib/meta-ads/enrich'
import type { MetaPerformanceAvailable, PerfRow } from '@/lib/meta-ads/performance'

// Mockup redesign of /ads-results = PRESENTATION ONLY. The old page is gone, so equivalence is proven against an independent oracle: every value shown for each ad is derived here
// straight from the report rows (never from the component) and compared with what the DOM prints, for 7 / 30 / 90 days, with and without the Meta catalog.

const IDS = ['120256299148760285', '120232883780380285', '120239084979500285', '120255157385110285']
beforeEach(() => { vi.stubGlobal('fetch', undefined) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const catalog = (id: string, name: string, status: string, camp = 'Campaña A', set = 'Conjunto A'): CatalogRow => ({ ad_id: id, name, adset_name: set, campaign_name: camp, status, effective_status: status, last_synced_at: 'x' })
const ROWS = [
  { source_id: IDS[0], headline: 'InkaClick', contacts: 1234, buyers: 411, orders: 420, order_amount: 52345.5, units: 640, products: [{ name: 'Taladro 20V', units: 300 }, { name: 'Amoladora 850W', units: 200 }, { name: 'Pulidora', units: 80 }, { name: 'Rectificadora', units: 40 }, { name: 'Soldadora, inverter', units: 20 }] },
  { source_id: IDS[1], headline: 'InkaClick', contacts: 7, buyers: 1, orders: 1, order_amount: 99.9, units: 2, products: [{ name: 'Laser', units: 2 }] },
  { source_id: IDS[2], headline: 'Anuncio en estados', contacts: 5, buyers: 0, orders: 0, order_amount: 0, units: 0, products: [] },
  { source_id: IDS[3], headline: 'Otro', contacts: 3, buyers: 1, orders: 2, order_amount: 10, units: 3, products: [{ name: 'A', units: 1 }, { name: 'B', units: 1 }, { name: 'C', units: 1 }] },
]
const withMeta = (): AdsReport => attachMetaCatalog(buildAdsReport(ROWS, 'f', 't'), [catalog(IDS[0], 'Rectificadora Video', 'ACTIVE'), catalog(IDS[1], 'Otro anuncio', 'CAMPAIGN_PAUSED'), catalog(IDS[3], 'Cuatro', 'WITH_ISSUES')], '2026-11-10T16:00:00Z')
const noMeta = () => buildAdsReport(ROWS, 'f', 't')

const perfRow = (id: string, over: Partial<PerfRow> = {}): PerfRow => ({
  id, name: 'x', status: 'ACTIVE', campaign_id: null, campaign_name: null, adset_id: null, adset_name: null,
  spend: 12464.72, impressions: 3776317, clicks: 62571, ctr: 1.6569, cpc: 0.1992, cpm: 3.3, ...over,
})
const PERF = (days = 30): MetaPerformanceAvailable => ({
  available: true, period: { days, since: '2026-10-12', until: '2026-11-10', timezone: 'America/Bogota', currency: 'PEN' }, synced_at: '2026-11-11T10:00:00Z',
  sync: { state: 'ok', covered_from: '2026-10-12', covered_to: '2026-11-10', partial: false }, reconciliation: null,
  totals: { spend: 99999, impressions: 99999999, clicks: 9999999, ctr: 9, cpc: 9, cpm: 9 }, campaigns: [], adsets: [],
  ads: [
    perfRow(IDS[0], {
      ext: { reach: 1191117, frequency: 3.17, link_clicks: 5000, outbound_clicks: 4000, messaging: { conversations_started: 800, connections: null, first_replies: null, depth_2: null, depth_3: null }, other_results: [] },
    }),
  ],
  extended: { available: true, summary: null },
})

/** Route by URL: the report endpoint, optionally the Meta performance endpoint. */
const stub = (reports: Record<string, AdsReport> | AdsReport, perf?: (days: number) => MetaPerformanceAvailable | null) => {
  const f = vi.fn(async (url: string) => {
    const u = new URL(url, 'http://x')
    if (u.pathname === '/api/ads/meta-performance') {
      const body = perf?.(Number(u.searchParams.get('days')))
      return { ok: !!body, status: body ? 200 : 404, json: async () => body }
    }
    const days = String(Math.round((Date.parse(u.searchParams.get('to')!) - Date.parse(u.searchParams.get('from')!)) / 86_400_000))
    const r = 'ads' in reports ? (reports as AdsReport) : (reports as Record<string, AdsReport>)[days]
    return { ok: true, status: 200, json: async () => ({ ...r, meta_capi: null, meta_ads: perf ? { configured: true } : null }) }
  })
  vi.stubGlobal('fetch', f)
  return f
}
const ready = () => waitFor(() => expect(screen.getAllByTestId('ad-item').length).toBeGreaterThan(0))
const items = () => screen.getAllByTestId('ad-item')
const money = (n: number) => new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
const int = (n: number) => new Intl.NumberFormat('es-PE').format(n)

describe('DATA EQUIVALENCE: every figure printed per ad comes straight from the report', () => {
  for (const [label, mk] of [['with the Meta catalog', withMeta], ['without the Meta catalog (headline fallback)', noMeta]] as const) {
    it(`${label}: order, source_id, contacts, orders, units, amount, conversion and ALL products`, async () => {
      const rep = mk()
      stub(rep)
      render(<AdsResultsPage />)
      await ready()
      expect(items()).toHaveLength(rep.ads.length)
      for (const el of screen.getAllByText(/más$/)) fireEvent.click(el) // expand every product list: nothing may be missing
      rep.ads.forEach((a, i) => {
        const row = within(items()[i])
        const cells = row.getAllByRole('cell')
        expect(cells[0].textContent).toContain(`ID: ${a.source_id}`)
        expect(cells[0].textContent).toContain(adName(a.headline, a.meta))
        expect(cells[1].textContent).toContain(int(a.contacts))
        expect(cells[2].textContent).toContain(`${int(a.orders)} ${a.orders === 1 ? 'pedido' : 'pedidos'}`)
        expect(cells[2].textContent).toContain(`${int(a.units)} ${a.units === 1 ? 'unidad' : 'unidades'}`)
        expect(cells[3].textContent).toContain(money(a.order_amount))
        expect(cells[3].textContent).toContain(a.conversion_pct === null ? '— conversión' : `${a.conversion_pct.toFixed(1)}% conversión`)
        expect(Array.from(cells[4].querySelectorAll('[data-testid="ad-products"] > span')).map((s) => s.textContent)).toEqual(a.products.map((p) => `${p.name} ×${p.units}`))
      })
    })
  }
  it('7 / 30 / 90: the list follows the period and shows each response\'s rows unchanged', async () => {
    stub({ '7': buildAdsReport(ROWS.slice(0, 1), 'f', 't'), '30': buildAdsReport(ROWS.slice(0, 3), 'f', 't'), '90': buildAdsReport(ROWS, 'f', 't') })
    render(<AdsResultsPage />)
    await waitFor(() => expect(items()).toHaveLength(3)) // default 30 days
    fireEvent.click(screen.getByRole('button', { name: '7 días' }))
    await waitFor(() => expect(items()).toHaveLength(1))
    expect(screen.getByRole('button', { name: '7 días' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '90 días' }))
    await waitFor(() => expect(items()).toHaveLength(4))
    expect(items().map((el) => el.textContent!.match(/ID: (\d+)/)![1])).toEqual(ROWS.map((r) => r.source_id))
  })
})

describe('Resultados por anuncio — mockup structure', () => {
  it('header, summary cards and section heading (no collapsible title, no explanatory mockup panels)', async () => {
    stub(withMeta())
    render(<AdsResultsPage />)
    await ready()
    expect(screen.getByRole('heading', { level: 1, name: 'Resultados por anuncio' })).toBeTruthy()
    expect(screen.getByText('Rendimiento comercial de tus anuncios: contactos, pedidos, ventas y productos atribuidos.')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: 'Detalle por anuncio' })).toBeTruthy()
    expect(screen.getByText('Resultados comerciales atribuidos a cada anuncio.')).toBeTruthy()
    expect(screen.getByText('Los productos corresponden a productos vendidos, no necesariamente al producto publicitado.')).toBeTruthy()
    for (const doc of ['Estructura de la vista', 'Beneficios', 'Cómo se lee la tabla']) expect(screen.queryByText(doc)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Detalle por anuncio' })).toBeNull() // the section is always visible now
    // main columns: Anuncio | Contactos | Pedidos | Venta | Productos (+ unnamed expander)
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Anuncio', 'Contactos', 'Pedidos', 'Venta', 'Productos', 'Detalle'])
    // no percentage deltas are invented on the cards
    expect(screen.queryByText(/[↑↓]/)).toBeNull()
    const card = (l: string) => screen.getByText(l).nextSibling?.textContent
    expect(card('Contactos atribuidos')).toBe(String(withMeta().totals.contacts))
    expect(card('Pedidos confirmados (con anuncio)')).toBe(String(withMeta().totals.attributed_orders))
    expect(card('Importe de pedidos confirmados')).toBe(money(withMeta().totals.order_amount))
    expect(card('Pedidos sin atribución comprobable')).toBe(String(withMeta().totals.unattributed_orders))
  })
  it('row: name leads, "ID: source_id" is secondary, orders/units and amount/conversion are stacked, no campaign/conjunto in the main row', async () => {
    stub(withMeta())
    render(<AdsResultsPage />)
    await ready()
    const cells = within(items()[0]).getAllByRole('cell')
    expect(cells[0].querySelector('.line-clamp-2')!.textContent).toBe('Rectificadora Video')
    const id = cells[0].querySelector('span.font-mono')!
    expect(id.textContent).toBe(`ID: ${IDS[0]}`)
    expect(id.className).toMatch(/text-xs.*text-muted-foreground/)
    expect(cells[1].textContent).toContain(int(1234))
    expect(cells[3].textContent).toContain('52,345.50')
    expect(items()[0].textContent).not.toMatch(/Campaña A|Conjunto A/) // only inside the expanded detail
    expect(cells[2].className).toMatch(/tabular-nums/)
  })
  it('FALLBACK of the name is untouched: catalog => real name; ad missing from the catalog => "Anuncio no sincronizado" + source_id; no catalog => headline', async () => {
    stub(withMeta())
    render(<AdsResultsPage />)
    await ready()
    expect(items().map((el) => el.querySelector('.line-clamp-2')!.textContent)).toEqual(['Rectificadora Video', 'Otro anuncio', 'Anuncio no sincronizado', 'Cuatro'])
    expect(items()[2].textContent).toContain(IDS[2])
    expect(screen.queryByText('Anuncio en estados')).toBeNull()
    expect(adName('H', undefined)).toBe('H')
    expect(adName(null, undefined)).toBe('Sin título')
    expect(adName('H', null)).toBe('Anuncio no sincronizado')
    expect(adName('H', { name: null, campaign_name: null, adset_name: null, status: null, effective_status: null })).toBe('H')
  })
  it('status badge only from the status the row ALREADY has; none when absent or unknown', async () => {
    stub(withMeta())
    render(<AdsResultsPage />)
    await ready()
    expect(screen.getAllByTestId('ad-status').map((b) => b.textContent)).toEqual(['Activo', 'Campaña pausada', 'Con incidencias'])
    cleanup()
    stub(noMeta())
    render(<AdsResultsPage />)
    await ready()
    expect(screen.queryAllByTestId('ad-status')).toHaveLength(0)
    expect(adStatus({ name: 'x', campaign_name: null, adset_name: null, status: 'SOMETHING_NEW', effective_status: null })).toBeNull()
    expect(adStatus(undefined)).toBeNull()
    expect(adStatus({ name: 'x', campaign_name: null, adset_name: null, status: 'PAUSED', effective_status: 'ADSET_PAUSED' })?.label).toBe('Conjunto pausado')
  })
  it('PRODUCTS: max 2 chips + "+N más"; expanding shows ALL in the same order; "Ver menos" collapses; none => "—"', async () => {
    stub(withMeta())
    render(<AdsResultsPage />)
    await ready()
    const chips = (i: number) => Array.from(items()[i].querySelectorAll('[data-testid="ad-products"] > span')).map((s) => s.textContent)
    expect(chips(0)).toEqual(['Taladro 20V ×300', 'Amoladora 850W ×200'])
    expect(within(items()[0]).getByText('+3 más')).toBeTruthy()
    expect(chips(1)).toEqual(['Laser ×2'])
    expect(within(items()[2]).getAllByRole('cell')[4].textContent!.trim()).toBe('Productos—')
    expect(chips(3)).toEqual(['A ×1', 'B ×1']) // 3 products => 2 + "+1 más"
    expect(within(items()[3]).getByText('+1 más')).toBeTruthy()
    fireEvent.click(within(items()[0]).getByText('+3 más'))
    expect(chips(0)).toEqual(['Taladro 20V ×300', 'Amoladora 850W ×200', 'Pulidora ×80', 'Rectificadora ×40', 'Soldadora, inverter ×20'])
    fireEvent.click(within(items()[0]).getByText('Ver menos'))
    expect(chips(0)).toHaveLength(2)
    expect(splitProducts([1, 2], false)).toEqual({ shown: [1, 2], hidden: 0 })
    expect(splitProducts([1, 2, 3, 4], false)).toEqual({ shown: [1, 2], hidden: 2 })
    expect(splitProducts([1, 2, 3, 4], true)).toEqual({ shown: [1, 2, 3, 4], hidden: 0 })
    expect(PRODUCTS_VISIBLE).toBe(2)
  })
  it('no ads in the period: same empty message as before', async () => {
    stub(buildAdsReport([], 'f', 't'))
    render(<AdsResultsPage />)
    await waitFor(() => expect(screen.getByText('Sin contactos ni pedidos atribuidos a anuncios en este periodo.')).toBeTruthy())
  })
})

describe('Expanded ad: Información / Rendimiento en Meta Ads / Productos atribuidos', () => {
  it('without Meta performance: two blocks (information + all products); WACRM data only, no Meta metrics; chevron toggles', async () => {
    stub(withMeta())
    render(<AdsResultsPage />)
    await ready()
    expect(screen.queryByTestId('ad-detail-row')).toBeNull()
    const btn = within(items()[0]).getByRole('button', { name: 'Ver detalle de Rectificadora Video' })
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(btn)
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    const d = within(items()[0])
    const info = d.getByTestId(`ad-detail-${IDS[0]}`).textContent!
    expect(info).toContain('Información del anuncio')
    expect(info).toContain(IDS[0])
    expect(info).toMatch(/Campaña.*Campaña A/)
    expect(info).toMatch(/Conjunto.*Conjunto A/)
    expect(info).toMatch(/Estado.*Activo/)
    expect(info).toMatch(/Ventas verificadas.*No disponible/)
    expect(d.queryByTestId('ad-meta-block')).toBeNull()
    expect(d.getByTestId('ad-products-block').textContent).toContain('Soldadora, inverter×20') // ALL products, with units
    expect(d.getByTestId('ad-products-block').querySelectorAll('li')).toHaveLength(5)
    fireEvent.click(btn)
    expect(screen.queryByTestId('ad-detail-row')).toBeNull()
    // unsynced ad: no invented campaign / status
    fireEvent.click(within(items()[2]).getByRole('button', { name: 'Ver detalle de Anuncio no sincronizado' }))
    const u = within(items()[2]).getByTestId(`ad-detail-${IDS[2]}`).textContent!
    expect(u).toContain(IDS[2])
    expect(u).not.toMatch(/Campaña|Conjunto|Estado/)
    expect(within(items()[2]).getByText('Sin productos vendidos en este período.')).toBeTruthy()
  })
  it('with Meta performance: the ad\'s OWN impressions / clicks / CTR / spend are primary, the rest are secondary; ad-level only (never account totals)', async () => {
    stub(withMeta(), PERF)
    render(<AdsResultsPage />)
    await ready()
    await screen.findByTestId('meta-performance') // global card loaded => the shared fetch resolved
    fireEvent.click(within(items()[0]).getByRole('button', { name: /Ver detalle de Rectificadora Video/ }))
    const b = within(items()[0]).getByTestId('ad-meta-block')
    expect(b.textContent).toContain('Rendimiento en Meta Ads(30 días)')
    expect(b.textContent).toContain(int(3776317))
    expect(b.textContent).toContain(int(62571))
    expect(b.textContent).toContain(`${money(1.6569)}%`)
    expect(b.textContent).toContain(money(12464.72))
    expect(b.textContent).not.toContain(int(99999999)) // the account total is never mixed into an ad
    const more = within(b).getByTestId('ad-meta-more')
    expect(more.textContent).toContain('Reach')
    expect(more.textContent).toContain(int(1191117))
    expect(more.textContent).toContain('Frecuencia')
    expect(more.textContent).toContain('Clics en enlace')
    expect(more.textContent).toContain('Clics salientes')
    expect(more.textContent).toContain('Conversaciones iniciadas (Meta)')
    expect(more.textContent).not.toContain('Primeras respuestas') // null metrics are not shown
    expect(b.textContent).toContain('no son contactos ni pedidos de WACRM')
  })
  it('an ad Meta has no data for says so (no zeros, no account numbers); an ad with Meta rows but no extended data just has fewer secondary metrics', async () => {
    stub(withMeta(), (d) => ({ ...PERF(d), ads: [perfRow(IDS[1], { cpc: null, cpm: null })] }))
    render(<AdsResultsPage />)
    await ready()
    await screen.findByTestId('meta-performance')
    fireEvent.click(within(items()[0]).getByRole('button', { name: /Ver detalle/ }))
    expect(within(items()[0]).getByTestId('ad-meta-block').textContent).toContain('Meta no reporta gasto ni impresiones de este anuncio')
    fireEvent.click(within(items()[1]).getByRole('button', { name: /Ver detalle/ }))
    const b = within(items()[1]).getByTestId('ad-meta-block')
    expect(b.textContent).toContain(int(3776317))
    expect(within(b).queryByTestId('ad-meta-more')).toBeNull() // nothing secondary was reported
  })
  it('Meta performance unavailable: the per-ad Meta block and the global card are simply absent', async () => {
    stub(withMeta(), () => null)
    render(<AdsResultsPage />)
    await ready()
    fireEvent.click(within(items()[0]).getByRole('button', { name: /Ver detalle/ }))
    expect(within(items()[0]).queryByTestId('ad-meta-block')).toBeNull()
    expect(screen.queryByTestId('meta-performance')).toBeNull()
  })
})

describe('Vista Por anuncio | Por producto', () => {
  const withDrill = () =>
    buildAdsReport(ROWS, 'f', 't', [{ product: 'Taladro', buyers: 2, orders: 3, units: 4, sales: 300, legacy_orders: 0 }], [{ product: 'Taladro', source_id: IDS[0], buyers: 2, orders: 3, units: 4, sales: 300 }])
  it('default is "Por anuncio"; the switch shows the product table with its drilldown; switching back keeps the ad list', async () => {
    stub(withDrill())
    render(<AdsResultsPage />)
    await ready()
    expect(screen.getByRole('button', { name: 'Por anuncio' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByTestId('sold-products')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Por producto' }))
    const sec = screen.getByTestId('sold-products')
    expect(screen.getByRole('heading', { level: 2, name: 'Rendimiento por producto' })).toBeTruthy()
    expect(Array.from(sec.querySelectorAll('th')).map((h) => h.textContent)).toEqual(['Producto vendido', 'Compradores', 'Pedidos', 'Unidades', 'Ventas confirmadas', 'Ticket prom.', 'Anuncios atribuidos'])
    fireEvent.click(within(sec).getByRole('button', { name: 'Ver anuncios de Taladro' }))
    expect(within(sec).getByTestId('product-ads').textContent).toContain(IDS[0])
    fireEvent.click(screen.getByRole('button', { name: 'Por anuncio' }))
    expect(screen.queryByTestId('sold-products')).toBeNull()
    expect(items()).toHaveLength(4)
  })
  it('no product data (old DB): no switch, only the ad view', async () => {
    stub(withMeta())
    render(<AdsResultsPage />)
    await ready()
    expect(screen.queryByRole('button', { name: 'Por producto' })).toBeNull()
  })
})
