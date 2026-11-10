// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
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
  it('REGRESSION vs production: original cards, labels, figures and ad-table columns are unchanged; product section is added after them', async () => {
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
    for (const gone of ['Consultaron', 'Ventas confirmadas', 'Ticket prom.']) expect(screen.queryByText(gone)).toBeNull()
    const original = screen.getByText('Por anuncio').closest('[data-slot="card"]')!
    expect(Array.from(original.querySelectorAll('th')).map((h) => h.textContent)).toEqual(['Anuncio', 'Contactos', 'Pedidos', 'Importe pedidos', 'Unidades', 'Conversión', 'Productos', 'Ventas verificadas'])
    expect(Array.from(original.querySelectorAll('tbody td')).map((c) => c.textContent)).toEqual(['OfertaID AD1', '40', '3', '300.00', '4', '5%', 'Laser ×4', 'No disponible'])
    // the new section comes after the original one and does not alter it
    expect(original.compareDocumentPosition(screen.getByTestId('sold-products')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
  it('Por producto vendido: columns, figures and the sold-vs-advertised clarification', async () => {
    vi.stubGlobal('fetch', reply(200, { ...buildAdsReport([], 'f', 't', [{ product: 'Taladro', buyers: 24, orders: 26, units: 35, sales: 3440, legacy_orders: 0 }]), meta_capi: null }))
    render(<AdsResultsPage />)
    const sec = await screen.findByTestId('sold-products')
    expect(Array.from(sec.querySelectorAll('th')).map((h) => h.textContent)).toEqual(['Producto', 'Compradores', 'Pedidos', 'Unidades', 'Ventas', 'Ticket promedio'])
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
})
