// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import AdsResultsPage from './page'
import { buildAdsReport } from '@/lib/meta-capi/report'
import { attachMetaCatalog, type CatalogRow } from '@/lib/meta-ads/enrich'

const ID1 = '120256299148760285'
const ID2 = '120255157385110285'
const reply = (body: unknown) => vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body })
beforeEach(() => { vi.stubGlobal('fetch', undefined) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const report = () =>
  buildAdsReport(
    [
      { source_id: ID1, headline: 'InkaClick', contacts: 40, buyers: 2, orders: 3, order_amount: 300, units: 4, products: [{ name: 'Laser', units: 4 }] },
      { source_id: ID2, headline: 'InkaClick', contacts: 10, buyers: 0, orders: 0, order_amount: 0, units: 0, products: [] },
    ],
    'f', 't',
    [{ product: 'Taladro', buyers: 2, orders: 3, units: 4, sales: 300, legacy_orders: 0 }],
    [{ product: 'Taladro', source_id: ID1, buyers: 2, orders: 3, units: 4, sales: 300 }],
  )
const cat: CatalogRow = { ad_id: ID1, name: 'Rectificadora Video', adset_name: 'Conjunto A', campaign_name: 'Campaña A', status: 'ACTIVE', effective_status: 'ACTIVE', last_synced_at: 'x' }

describe('Resultados de anuncios — real ad names from the Meta catalog', () => {
  it('full ad table: the REAL name leads and the Meta Ad ID stays small below it; an ad missing from the catalog says so (never its headline)', async () => {
    vi.stubGlobal('fetch', reply({ ...attachMetaCatalog(report(), [cat], '2026-11-10T16:00:00Z'), meta_capi: null }))
    render(<AdsResultsPage />)
    await waitFor(() => expect(screen.getByTestId('full-ads')).toBeTruthy())
    fireEvent.click(within(screen.getByTestId('full-ads')).getByRole('button', { name: 'Detalle por anuncio' }))
    const full = screen.getByTestId('full-ads')
    const cells = Array.from(full.querySelectorAll('tbody tr')).map((r) => r.querySelector('td')!.textContent)
    expect(cells).toEqual([`Rectificadora Video${ID1}ActivoVer detalle`, `Anuncio no sincronizado${ID2}Ver detalle`])
    expect(full.textContent).not.toContain('InkaClick') // the account-name headline is no longer what identifies the ad
    const idLine = Array.from(full.querySelectorAll('span')).find((d) => d.textContent === ID1)!
    expect(idLine.className).toContain('text-xs') // the id is secondary: small, muted, monospace
    // campaign / ad set moved to the per-ad detail (same data the row already received)
    fireEvent.click(within(full).getByLabelText('Ver detalle de Rectificadora Video'))
    const d = screen.getByTestId(`ad-detail-${ID1}`)
    expect(d.textContent).toMatch(/Campaña.*Campaña A.*Conjunto.*Conjunto A.*Estado.*Activo/)
    expect(screen.getByTestId('meta-catalog-note').textContent).toMatch(/sincronizados el/)
  })
  it('drilldown "Anuncio atribuido" shows the same identity: real name + ID', async () => {
    vi.stubGlobal('fetch', reply({ ...attachMetaCatalog(report(), [cat], '2026-11-10T16:00:00Z'), meta_capi: null }))
    render(<AdsResultsPage />)
    await waitFor(() => expect(screen.getByTestId('sold-products')).toBeTruthy())
    fireEvent.click(screen.getByText(/Ver anuncios \(1\)/))
    const drill = screen.getByTestId('product-ads')
    expect(drill.querySelector('tbody td')!.textContent).toContain('Rectificadora Video')
    expect(drill.querySelector('tbody td')!.textContent).toContain(`ID ${ID1}`)
  })
  it('FALLBACK without Meta: exactly today\'s screen (headline + ID, no note), numbers untouched', async () => {
    vi.stubGlobal('fetch', reply({ ...report(), meta_capi: null }))
    render(<AdsResultsPage />)
    await waitFor(() => expect(screen.getByTestId('sold-products')).toBeTruthy())
    fireEvent.click(within(screen.getByTestId('full-ads')).getByRole('button', { name: 'Detalle por anuncio' }))
    const full = screen.getByTestId('full-ads')
    expect(Array.from(full.querySelectorAll('tbody tr')).map((r) => r.querySelector('td')!.textContent)).toEqual([`InkaClick${ID1}Ver detalle`, `InkaClick${ID2}Ver detalle`])
    expect(screen.queryByTestId('meta-catalog-note')).toBeNull()
    expect(screen.queryByText('Anuncio no sincronizado')).toBeNull()
    expect(Array.from(full.querySelectorAll('th')).map((h) => h.textContent)).toEqual(['Anuncio', 'Contactos', 'Pedidos', 'Importe pedidos', 'Unidades', 'Conversión', 'Productos'])
  })
  it('summary cards are identical with and without the catalog', async () => {
    const cards = async (body: unknown) => {
      vi.stubGlobal('fetch', reply(body))
      const { container, unmount } = render(<AdsResultsPage />)
      await waitFor(() => expect(screen.getByTestId('sold-products')).toBeTruthy())
      const text = Array.from(container.querySelectorAll('[data-slot="card"]')).slice(0, 4).map((c) => c.textContent)
      unmount()
      return text
    }
    expect(await cards({ ...attachMetaCatalog(report(), [cat], 'x'), meta_capi: null })).toEqual(await cards({ ...report(), meta_capi: null }))
  })
})
