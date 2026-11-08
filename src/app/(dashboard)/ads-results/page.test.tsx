// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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
})
