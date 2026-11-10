// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import AdsResultsPage from './page'
import { buildAdsReport } from '@/lib/meta-capi/report'

const reply = (status: number, body: unknown) => vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body })
beforeEach(() => { vi.stubGlobal('fetch', undefined) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Resultados de anuncios page states', () => {
  it('no data: explains it and still shows Meta sending as disabled', async () => {
    vi.stubGlobal('fetch', reply(200, { ...buildAdsReport([], 'f', 't'), meta_capi: { enabled: false, test_mode: false } }))
    render(<AdsResultsPage />)
    await waitFor(() => expect(screen.getByText(/Sin contactos ni pedidos atribuidos/)).toBeTruthy())
    expect(screen.getByTestId('capi-status').textContent).toMatch(/desactivado/)
    expect(screen.getByText(/ROAS no disponible/)).toBeTruthy()
  })
  it('integration enabled in test mode is stated; unattributed orders are counted apart from ads', async () => {
    vi.stubGlobal('fetch', reply(200, { ...buildAdsReport([
      { source_id: 'AD1', headline: 'Oferta', contacts: 4, buyers: 1, orders: 1, order_amount: 99.9, units: 2, products: [{ name: 'Laser', units: 2 }] },
      { source_id: null, contacts: 0, buyers: 0, orders: 3, order_amount: 30, units: 3, products: [] },
    ], 'f', 't'), meta_capi: { enabled: true, test_mode: true } }))
    render(<AdsResultsPage />)
    await waitFor(() => expect(screen.getByText('Oferta')).toBeTruthy())
    expect(screen.getByTestId('capi-status').textContent).toMatch(/activo.*modo de prueba/)
    expect(screen.getByText('Pedidos sin atribución comprobable').nextSibling?.textContent).toBe('3')
    expect(screen.getByText('25%')).toBeTruthy()
    expect(screen.getByText('No disponible')).toBeTruthy()
  })
  it('no permission (403): shows a permission message, no report', async () => {
    vi.stubGlobal('fetch', reply(403, { error: 'Forbidden' }))
    render(<AdsResultsPage />)
    await waitFor(() => expect(screen.getByText(/No tienes permisos/)).toBeTruthy())
    expect(screen.queryByText(/Por anuncio/)).toBeNull()
  })
  it('server failure: shows a load error', async () => {
    vi.stubGlobal('fetch', reply(500, {}))
    render(<AdsResultsPage />)
    await waitFor(() => expect(screen.getByText(/No se pudo cargar/)).toBeTruthy())
  })
  it('REGRESSION vs production: original cards, labels, figures and ad-table columns are unchanged; without the breakdown the full ad table is OPEN (previous screen) after the product section', async () => {
    vi.stubGlobal('fetch', reply(200, { ...buildAdsReport([
      { source_id: 'AD1', headline: 'Oferta', contacts: 40, buyers: 2, orders: 3, order_amount: 300, units: 4, products: [{ name: 'Laser', units: 4 }] },
      { source_id: null, contacts: 0, buyers: 0, orders: 5, order_amount: 50, units: 5, products: [] },
    ], 'f', 't', [{ product: 'Taladro', buyers: 24, orders: 26, units: 35, sales: 3440, legacy_orders: 0 }]), meta_capi: null }))
    render(<AdsResultsPage />)
    await waitFor(() => expect(screen.getByTestId('sold-products')).toBeTruthy())
    const card = (l: string) => screen.getByText(l).nextSibling?.textContent
    expect(card('Contactos atribuidos')).toBe('40')
    expect(card('Pedidos confirmados (con anuncio)')).toBe('3')
    expect(card('Pedidos sin atribución comprobable')).toBe('5')
    expect(card('Importe de pedidos confirmados')).toBe('350.00') // attributed + unattributed, exactly as in production
    for (const gone of ['Consultaron', 'Ventas confirmadas']) expect(screen.queryByText(gone)).toBeNull()
    const original = screen.getByText('Vista completa por anuncio').closest('[data-slot="card"]')!
    expect(Array.from(original.querySelectorAll('th')).map((h) => h.textContent)).toEqual(['Anuncio', 'Contactos', 'Pedidos', 'Importe pedidos', 'Unidades', 'Conversión', 'Productos', 'Ventas verificadas'])
    expect(Array.from(original.querySelectorAll('tbody td')).map((c) => c.textContent)).toEqual(['OfertaID AD1', '40', '3', '300.00', '4', '5%', 'Laser ×4', 'No disponible'])
    // order: summary, products, then the (here open) full ad table; no drilldown column without the breakdown
    expect(screen.getByTestId('sold-products').compareDocumentPosition(original) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByText(/Ver anuncios/)).toBeNull()
  })
  it('no "Consultaron"/"Conversión" columns at product level (no reliable source yet)', async () => {
    vi.stubGlobal('fetch', withBreakdown())
    render(<AdsResultsPage />)
    const sec = await screen.findByTestId('sold-products')
    expect(within(sec).queryByText('Consultaron')).toBeNull()
    expect(within(sec).queryByText('Conversión')).toBeNull()
  })
  it('Rendimiento por producto (no breakdown): columns, figures and the sold-vs-advertised clarification', async () => {
    vi.stubGlobal('fetch', reply(200, { ...buildAdsReport([], 'f', 't', [{ product: 'Taladro', buyers: 24, orders: 26, units: 35, sales: 3440, legacy_orders: 0 }]), meta_capi: null }))
    render(<AdsResultsPage />)
    const sec = await screen.findByTestId('sold-products')
    expect(Array.from(sec.querySelectorAll('th')).map((h) => h.textContent)).toEqual(['Producto vendido', 'Compradores', 'Pedidos', 'Unidades', 'Ventas', 'Ticket prom.'])
    expect(Array.from(sec.querySelectorAll('td')).map((c) => c.textContent)).toEqual(['Taladro', '24', '26', '35', '3,440.00', '143.33'])
    expect(sec.textContent).toMatch(/Producto vendido, no necesariamente producto publicitado/)
    for (const banned of ['Alcance', 'Impresiones', 'Gasto', 'CTR', 'CPC', 'CPM', 'CPA', 'ROAS', 'Pendiente Meta', 'N/A']) expect(within(sec).queryByText(banned)).toBeNull()
  })
  it('old DB without the helper: no product section, original screen intact', async () => {
    vi.stubGlobal('fetch', reply(200, { ...buildAdsReport([{ source_id: 'AD1', headline: 'Oferta', contacts: 1, buyers: 0, orders: 0, order_amount: 0, units: 0, products: [] }], 'f', 't'), meta_capi: null }))
    render(<AdsResultsPage />)
    await waitFor(() => expect(screen.getByText('Oferta')).toBeTruthy())
    expect(screen.queryByTestId('sold-products')).toBeNull()
  })
  it('7/30/90 filters request the same periods as before', async () => {
    const f = reply(200, { ...buildAdsReport([], 'f', 't'), meta_capi: null })
    vi.stubGlobal('fetch', f)
    render(<AdsResultsPage />)
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1))
    ;(await screen.findByText('7 días')).click()
    await waitFor(() => expect(f).toHaveBeenCalledTimes(2))
    ;(await screen.findByText('90 días')).click()
    await waitFor(() => expect(f).toHaveBeenCalledTimes(3))
    const span = (c: unknown[]) => { const u = new URL(String(c[0]), 'http://x'); return Math.round((Date.parse(u.searchParams.get('to')!) - Date.parse(u.searchParams.get('from')!)) / 86_400_000) }
    expect(f.mock.calls.map(span)).toEqual([30, 7, 90])
    expect(f.mock.calls.every((c) => String(c[0]).startsWith('/api/ads/results?'))).toBe(true) // only the existing endpoint, no Meta
  })

  // ---------------------------------------------------------------- product -> ad drilldown
  const ADS = [
    { source_id: 'AD1', headline: 'Anuncio en estados', contacts: 10, buyers: 2, orders: 2, order_amount: 300, units: 3, products: [{ name: 'Taladro', units: 3 }] },
    { source_id: 'AD2', headline: null, contacts: 4, buyers: 1, orders: 1, order_amount: 100, units: 1, products: [{ name: 'Taladro', units: 1 }] },
    { source_id: 'AD3', headline: 'Sin ventas', contacts: 5, buyers: 0, orders: 0, order_amount: 0, units: 0, products: [] },
    { source_id: null, contacts: 0, buyers: 0, orders: 2, order_amount: 80, units: 2, products: [] },
  ]
  const PRODUCTS = [
    { product: 'Taladro', buyers: 3, orders: 4, units: 5, sales: 450, legacy_orders: 0 },
    { product: 'Gel', buyers: 1, orders: 1, units: 1, sales: 30, legacy_orders: 1 },
  ]
  const BREAKDOWN = [
    { product: 'Taladro', source_id: 'AD1', buyers: 2, orders: 2, units: 3, sales: 300 },
    { product: 'Taladro', source_id: 'AD2', buyers: 1, orders: 1, units: 1, sales: 100 },
    { product: 'Taladro', source_id: null, buyers: 1, orders: 1, units: 1, sales: 50 },
    { product: 'Gel', source_id: null, buyers: 1, orders: 1, units: 1, sales: 30 },
  ]
  const withBreakdown = () => reply(200, { ...buildAdsReport(ADS, 'f', 't', PRODUCTS, BREAKDOWN), meta_capi: null })

  it('drilldown: Anuncios column + "Ver anuncios (N)" per product; the full ad table starts COLLAPSED', async () => {
    vi.stubGlobal('fetch', withBreakdown())
    render(<AdsResultsPage />)
    const sec = await screen.findByTestId('sold-products')
    expect(within(sec).getByText('Rendimiento por producto')).toBeTruthy()
    expect(Array.from(sec.querySelectorAll('thead th')).map((h) => h.textContent)).toEqual(['Producto vendido', 'Compradores', 'Pedidos', 'Unidades', 'Ventas', 'Ticket prom.', 'Anuncios'])
    expect(screen.getByRole('button', { name: 'Ver anuncios de Taladro' }).textContent).toBe('Ver anuncios (2)') // AD1 + AD2; the unattributed bucket is not an ad
    expect(screen.getByRole('button', { name: 'Ver anuncios de Gel' }).textContent).toBe('Ver anuncios (0)')
    expect(screen.queryByTestId('product-ads')).toBeNull()
    expect(screen.queryByText('Importe pedidos')).toBeNull() // full ad table collapsed
    expect(screen.getByRole('button', { name: /Vista completa por anuncio/ }).getAttribute('aria-expanded')).toBe('false')
  })
  it('expanding a product shows its ads (name + ID), the unattributed bucket, reconciles, and does not touch other rows', async () => {
    vi.stubGlobal('fetch', withBreakdown())
    render(<AdsResultsPage />)
    await screen.findByTestId('sold-products')
    fireEvent.click(screen.getByRole('button', { name: 'Ver anuncios de Taladro' }))
    const panel = await screen.findByTestId('product-ads')
    expect(Array.from(panel.querySelectorAll('th')).map((h) => h.textContent)).toEqual(['Anuncio atribuido', 'Contactos', 'Compradores', 'Pedidos', 'Unidades', 'Ventas'])
    expect(Array.from(panel.querySelectorAll('tbody tr')).filter((r) => r.querySelector('td')).map((r) => Array.from(r.querySelectorAll('td')).map((c) => c.textContent))).toEqual([
      ['Anuncio en estadosID AD1', '10', '2', '2', '3', '300.00'],
      ['Sin títuloID AD2', '4', '1', '1', '1', '100.00'],
      ['Sin atribución comprobable', '—', '1', '1', '1', '50.00'],
    ])
    // orders/units/sales of the buckets add up to the product row (Taladro: 4 / 5 / 450)
    const cells = Array.from(panel.querySelectorAll('tbody tr')).filter((r) => r.querySelector('td')).map((r) => Array.from(r.querySelectorAll('td')).map((c) => parseFloat(c.textContent!.replace(/,/g, '')) || 0))
    expect(cells.reduce((a, r) => a + r[3], 0)).toBe(4)
    expect(cells.reduce((a, r) => a + r[4], 0)).toBe(5)
    expect(cells.reduce((a, r) => a + r[5], 0)).toBe(450)
    expect(panel.textContent).toMatch(/Contactos es el total de contactos del anuncio/)
    expect(panel.textContent).toMatch(/Compradores puede sumar más que los compradores únicos del producto/)
    // only that one row expanded; the product figures are unchanged
    expect(screen.getAllByTestId('product-ads')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Ver anuncios de Gel' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('button', { name: 'Ver anuncios de Taladro' }).getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Ver anuncios de Gel' }))
    expect(screen.getAllByTestId('product-ads')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Ver anuncios de Taladro' }))
    expect(screen.getAllByTestId('product-ads')).toHaveLength(1)
  })
  it('"Vista completa por anuncio" opens on demand and shows EXACTLY the current table, including ads with contacts and no sales', async () => {
    vi.stubGlobal('fetch', withBreakdown())
    render(<AdsResultsPage />)
    await screen.findByTestId('sold-products')
    fireEvent.click(screen.getByRole('button', { name: /Vista completa por anuncio/ }))
    const full = screen.getByTestId('full-ads')
    expect(Array.from(full.querySelectorAll('th')).map((h) => h.textContent)).toEqual(['Anuncio', 'Contactos', 'Pedidos', 'Importe pedidos', 'Unidades', 'Conversión', 'Productos', 'Ventas verificadas'])
    expect(within(full).getByText('Sin ventas')).toBeTruthy() // AD3: 5 contacts, 0 orders
    expect(within(full).getByText('ID AD3')).toBeTruthy()
    expect(within(full).getByText('Anuncio en estados')).toBeTruthy()
  })
  it('breakdown unavailable (RPC missing/failing): products stay, no Anuncios column, full ad table OPEN like before', async () => {
    vi.stubGlobal('fetch', reply(200, { ...buildAdsReport(ADS, 'f', 't', PRODUCTS, null), meta_capi: null }))
    render(<AdsResultsPage />)
    const sec = await screen.findByTestId('sold-products')
    expect(Array.from(sec.querySelectorAll('thead th')).map((h) => h.textContent)).toEqual(['Producto vendido', 'Compradores', 'Pedidos', 'Unidades', 'Ventas', 'Ticket prom.'])
    expect(screen.queryByText(/Ver anuncios/)).toBeNull()
    expect(screen.getByText('Importe pedidos')).toBeTruthy() // full table visible without any click
    expect(screen.getByText('Sin ventas')).toBeTruthy()
  })
  it('products unavailable (old DB): product card hidden, full ad table open, 4 cards intact', async () => {
    vi.stubGlobal('fetch', reply(200, { ...buildAdsReport(ADS, 'f', 't', null, BREAKDOWN), meta_capi: null }))
    render(<AdsResultsPage />)
    await waitFor(() => expect(screen.getByText('Anuncio en estados')).toBeTruthy())
    expect(screen.queryByTestId('sold-products')).toBeNull()
    expect(screen.getByText('Contactos atribuidos').nextSibling?.textContent).toBe('19')
  })
  it('changing the period collapses expanded products (no stale panels) and keeps the same endpoint', async () => {
    const f = withBreakdown()
    vi.stubGlobal('fetch', f)
    render(<AdsResultsPage />)
    await screen.findByTestId('sold-products')
    fireEvent.click(screen.getByRole('button', { name: 'Ver anuncios de Taladro' }))
    expect(screen.getAllByTestId('product-ads')).toHaveLength(1)
    fireEvent.click(screen.getByText('7 días'))
    await waitFor(() => expect(f).toHaveBeenCalledTimes(2))
    await screen.findByTestId('sold-products')
    expect(screen.queryByTestId('product-ads')).toBeNull()
  })
})
