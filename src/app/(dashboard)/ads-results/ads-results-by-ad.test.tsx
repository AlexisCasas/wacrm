// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import AdsResultsPage from './page'
import BeforePage from './__fixtures__/page.before-ux'
import { adName, adStatus, PRODUCTS_VISIBLE, splitProducts } from './ads-results-by-ad'
import { buildAdsReport } from '@/lib/meta-capi/report'
import { attachMetaCatalog, type CatalogRow } from '@/lib/meta-ads/enrich'

// "Resultados por anuncio" UX change = PRESENTATION ONLY. BeforePage is the verbatim production page at 2f8be25d: the same report is rendered by it and by the new page and the
// values read from both DOMs must be identical (rows, source_id, name, contacts, orders, amount, units, conversion, products).

const IDS = ['120256299148760285', '120232883780380285', '120239084979500285', '120255157385110285']
const reply = (body: unknown) => vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body })
beforeEach(() => { vi.stubGlobal('fetch', undefined) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const catalog = (id: string, name: string, status: string, camp = 'Campaña A', set = 'Conjunto A'): CatalogRow => ({ ad_id: id, name, adset_name: set, campaign_name: camp, status, effective_status: status, last_synced_at: 'x' })
const ROWS = [
  { source_id: IDS[0], headline: 'InkaClick', contacts: 1234, buyers: 411, orders: 420, order_amount: 52345.5, units: 640, products: [{ name: 'Taladro 20V', units: 300 }, { name: 'Amoladora 850W', units: 200 }, { name: 'Pulidora', units: 80 }, { name: 'Rectificadora', units: 40 }, { name: 'Soldadora, inverter', units: 20 }] },
  { source_id: IDS[1], headline: 'InkaClick', contacts: 7, buyers: 1, orders: 1, order_amount: 99.9, units: 2, products: [{ name: 'Laser', units: 2 }] },
  { source_id: IDS[2], headline: 'Anuncio en estados', contacts: 5, buyers: 0, orders: 0, order_amount: 0, units: 0, products: [] },
  { source_id: IDS[3], headline: 'Otro', contacts: 3, buyers: 1, orders: 2, order_amount: 10, units: 3, products: [{ name: 'A', units: 1 }, { name: 'B', units: 1 }, { name: 'C', units: 1 }] },
]
const withMeta = () => attachMetaCatalog(buildAdsReport(ROWS, 'f', 't'), [catalog(IDS[0], 'Rectificadora Video', 'ACTIVE'), catalog(IDS[1], 'Otro anuncio', 'CAMPAIGN_PAUSED'), catalog(IDS[3], 'Cuatro', 'WITH_ISSUES')], '2026-11-10T16:00:00Z')
const noMeta = () => buildAdsReport(ROWS, 'f', 't')

interface Model { id: string; name: string; contacts: number; orders: number; amount: number; units: number; conversion: number | null; products: string[] }
const num = (t: string | null) => Number((t ?? '').replace(/,/g, ''))
function oldModel(): Model[] {
  return Array.from(screen.getByTestId('full-ads').querySelectorAll('tbody tr')).map((tr) => {
    const td = Array.from(tr.querySelectorAll('td'))
    const divs = td[0].querySelectorAll('div')
    return {
      name: divs[0].textContent!, id: divs[1].textContent!.replace(/^ID /, ''), contacts: num(td[1].textContent), orders: num(td[2].textContent), amount: num(td[3].textContent), units: num(td[4].textContent),
      conversion: td[5].textContent === '—' ? null : parseFloat(td[5].textContent!), // the old cell is one joined string "A ×1, B ×2": split on the "×N" markers so product names containing commas survive
      products: td[6].textContent === '—' ? [] : Array.from(td[6].textContent!.matchAll(/(.+?) ×(\d+)(?:, |$)/g)).map((m) => `${m[1]} ×${m[2]}`),
    }
  })
}
function newModel(): Model[] {
  const full = screen.getByTestId('full-ads')
  for (const b of within(full).queryAllByText(/Ver todos/)) fireEvent.click(b) // expand every product list: nothing may be missing
  return Array.from(full.querySelectorAll('tbody tr')).filter((tr) => tr.getAttribute('data-testid') !== 'ad-detail-row').map((tr) => {
    const td = Array.from(tr.querySelectorAll('td'))
    return {
      name: td[0].querySelector('.line-clamp-2')!.textContent!, id: td[0].querySelector('span.font-mono')!.textContent!, contacts: num(td[1].textContent), orders: num(td[2].textContent), amount: num(td[3].textContent), units: num(td[4].textContent),
      conversion: td[5].textContent === '—' ? null : parseFloat(td[5].textContent!),
      products: Array.from(td[6].querySelectorAll('[data-testid="ad-products"] > span')).map((s) => s.textContent!),
    }
  })
}
const renderModel = async (Page: () => React.ReactElement, report: unknown, pick: () => Model[]) => {
  vi.stubGlobal('fetch', reply({ ...(report as object), meta_capi: null }))
  const { container, unmount } = render(<Page />)
  await waitFor(() => expect(screen.getByTestId('full-ads').querySelector('tbody')).toBeTruthy())
  const model = pick()
  const others = Array.from(container.querySelectorAll('[data-slot="card"]')).filter((c) => c.getAttribute('data-testid') !== 'full-ads').map((c) => c.textContent)
  unmount()
  return { model, others }
}

describe('BEFORE vs AFTER: the data is identical, only the presentation changed', () => {
  for (const [label, mk] of [['with the Meta catalog', withMeta], ['without the Meta catalog (headline fallback)', noMeta]] as const) {
    it(`${label}: rows, source_id, name, contacts, orders, amount, units, conversion and products are the same`, async () => {
      const before = await renderModel(BeforePage as never, mk(), oldModel)
      const after = await renderModel(AdsResultsPage as never, mk(), newModel)
      expect(after.model).toHaveLength(ROWS.length)
      expect(after.model).toEqual(before.model)
      expect(after.model.map((m) => m.id)).toEqual(ROWS.map((r) => r.source_id)) // same order, same source_id
      // and the cards / product section / everything else on the page is untouched
      expect(after.others).toEqual(before.others)
    })
  }
  it('every conversion keeps its value (the old text 33.3% / 25% / 5% is now shown with one decimal, same number); null stays "—"', async () => {
    const r = await renderModel(AdsResultsPage as never, withMeta(), newModel)
    const src = buildAdsReport(ROWS, 'f', 't').ads
    expect(r.model.map((m) => m.conversion)).toEqual(src.map((a) => a.conversion_pct))
  })
  it('7 / 30 / 90: the section follows the period and shows each response\'s rows unchanged', async () => {
    const by: Record<string, unknown> = {
      '7': buildAdsReport(ROWS.slice(0, 1), 'f', 't'), '30': buildAdsReport(ROWS.slice(0, 3), 'f', 't'), '90': buildAdsReport(ROWS, 'f', 't'),
    }
    const f = vi.fn(async (url: string) => {
      const from = Date.parse(new URL(url, 'http://x').searchParams.get('from')!), to = Date.parse(new URL(url, 'http://x').searchParams.get('to')!)
      return { ok: true, status: 200, json: async () => ({ ...(by[String(Math.round((to - from) / 86_400_000))] as object), meta_capi: null }) }
    })
    vi.stubGlobal('fetch', f)
    render(<AdsResultsPage />)
    await waitFor(() => expect(newModel()).toHaveLength(3)) // default 30 days
    fireEvent.click(screen.getByText('7 días'))
    await waitFor(() => expect(newModel()).toHaveLength(1))
    fireEvent.click(screen.getByText('90 días'))
    await waitFor(() => expect(newModel()).toHaveLength(4))
    expect(newModel().map((m) => m.id)).toEqual(ROWS.map((r) => r.source_id))
  })
})

describe('Resultados por anuncio — presentation', () => {
  it('header: title + short subtitle + the "sold product" clarification; main columns exactly Anuncio | Contactos | Pedidos | Importe pedidos | Unidades | Conversión | Productos', async () => {
    vi.stubGlobal('fetch', reply({ ...withMeta(), meta_capi: null }))
    render(<AdsResultsPage />)
    await waitFor(() => expect(screen.getByTestId('full-ads').querySelector('tbody')).toBeTruthy())
    const full = screen.getByTestId('full-ads')
    expect(within(full).getByRole('button', { name: 'Detalle por anuncio' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Resultados por anuncio' })).toBeTruthy() // the page title is unchanged; the Card no longer repeats it
    expect(screen.getAllByText('Resultados por anuncio')).toHaveLength(1)
    expect(within(full).queryByText('Resultados por anuncio')).toBeNull()
    expect(full.textContent).toContain('Resultados comerciales atribuidos a cada anuncio.')
    expect(full.textContent).toContain('Los productos corresponden a productos vendidos, no necesariamente al producto publicitado.')
    expect(Array.from(full.querySelectorAll('th')).map((h) => h.textContent)).toEqual(['Anuncio', 'Contactos', 'Pedidos', 'Importe pedidos', 'Unidades', 'Conversión', 'Productos'])
    expect(full.textContent).not.toMatch(/Gasto|Reach|Frecuencia|Conversaciones iniciadas|ROAS|CPA/) // WACRM commercial view only: no Meta Ads metrics here
  })
  it('numeric columns are right-aligned and tabular; the name leads and the id is small, monospace and secondary (no "ID " prefix)', async () => {
    vi.stubGlobal('fetch', reply({ ...withMeta(), meta_capi: null }))
    render(<AdsResultsPage />)
    await waitFor(() => expect(screen.getByTestId('full-ads').querySelector('tbody')).toBeTruthy())
    const row = screen.getByTestId('full-ads').querySelector('tbody tr')!
    const td = Array.from(row.querySelectorAll('td'))
    for (const i of [1, 2, 3, 4, 5]) expect(td[i].className).toMatch(/text-right.*tabular-nums|tabular-nums.*text-right/)
    expect(td[0].querySelector('.font-medium')!.textContent).toBe('Rectificadora Video')
    const id = td[0].querySelector('span.font-mono')!
    expect(id.textContent).toBe(IDS[0])
    expect(id.className).toMatch(/text-xs.*text-muted-foreground/)
    expect(td[0].textContent).not.toContain('ID ')
    expect(td[3].textContent).toBe('52,345.50') // same money format as before, aligned
    expect(td[1].textContent).toBe('1,234') // thousands grouping only (value 1234)
  })
  it('FALLBACK of the name is untouched: catalog => real name; ad missing from the catalog => "Anuncio no sincronizado" + source_id; no catalog => headline; never the headline when a catalog exists', async () => {
    vi.stubGlobal('fetch', reply({ ...withMeta(), meta_capi: null }))
    render(<AdsResultsPage />)
    await waitFor(() => expect(screen.getByTestId('full-ads').querySelector('tbody')).toBeTruthy())
    const m = newModel()
    expect(m.map((x) => x.name)).toEqual(['Rectificadora Video', 'Otro anuncio', 'Anuncio no sincronizado', 'Cuatro'])
    expect(m[2].id).toBe(IDS[2])
    expect(screen.getByTestId('full-ads').textContent).not.toContain('Anuncio en estados') // the headline of the unsynced ad is NOT used
    expect(adName('H', undefined)).toBe('H')
    expect(adName(null, undefined)).toBe('Sin título')
    expect(adName('H', null)).toBe('Anuncio no sincronizado')
    expect(adName('H', { name: null, campaign_name: null, adset_name: null, status: null, effective_status: null })).toBe('H')
  })
  it('status badge only from the status the row ALREADY has (Activo / Campaña pausada / Con incidencias); none when absent or unknown; nothing is added', async () => {
    vi.stubGlobal('fetch', reply({ ...withMeta(), meta_capi: null }))
    render(<AdsResultsPage />)
    await waitFor(() => expect(screen.getByTestId('full-ads').querySelector('tbody')).toBeTruthy())
    expect(within(screen.getByTestId('full-ads')).getAllByTestId('ad-status').map((b) => b.textContent)).toEqual(['Activo', 'Campaña pausada', 'Con incidencias']) // the unsynced ad has none
    cleanup()
    vi.stubGlobal('fetch', reply({ ...noMeta(), meta_capi: null }))
    render(<AdsResultsPage />)
    await waitFor(() => expect(screen.getByTestId('full-ads').querySelector('tbody')).toBeTruthy())
    expect(within(screen.getByTestId('full-ads')).queryAllByTestId('ad-status')).toHaveLength(0)
    expect(adStatus({ name: 'x', campaign_name: null, adset_name: null, status: 'SOMETHING_NEW', effective_status: null })).toBeNull()
    expect(adStatus(undefined)).toBeNull()
    expect(adStatus({ name: 'x', campaign_name: null, adset_name: null, status: 'PAUSED', effective_status: 'ADSET_PAUSED' })?.label).toBe('Conjunto pausado')
  })
  it('PRODUCTS: up to 3 shown normally; more than 3 => first 2 + "+N más · Ver todos"; expanding shows ALL, in the same order; "Ver menos" collapses; none => "—"', async () => {
    vi.stubGlobal('fetch', reply({ ...withMeta(), meta_capi: null }))
    render(<AdsResultsPage />)
    await waitFor(() => expect(screen.getByTestId('full-ads').querySelector('tbody')).toBeTruthy())
    const rows = Array.from(screen.getByTestId('full-ads').querySelectorAll('tbody tr')).filter((tr) => tr.getAttribute('data-testid') !== 'ad-detail-row')
    const chips = (i: number) => Array.from(rows[i].querySelectorAll('[data-testid="ad-products"] > span')).map((s) => s.textContent)
    expect(chips(0)).toEqual(['Taladro 20V ×300', 'Amoladora 850W ×200']) // 5 products: 2 + "+3 más"
    expect(within(rows[0] as HTMLElement).getByText('+3 más · Ver todos')).toBeTruthy()
    expect(chips(1)).toEqual(['Laser ×2']) // few: all
    expect(rows[2].querySelector('td:last-child')!.textContent).toBe('—')
    expect(chips(3)).toEqual(['A ×1', 'B ×1', 'C ×1']) // exactly 3: all, no "más"
    expect(within(rows[3] as HTMLElement).queryByText(/más/)).toBeNull()
    fireEvent.click(within(rows[0] as HTMLElement).getByText('+3 más · Ver todos'))
    expect(chips(0)).toEqual(['Taladro 20V ×300', 'Amoladora 850W ×200', 'Pulidora ×80', 'Rectificadora ×40', 'Soldadora, inverter ×20']) // nothing removed or reordered
    fireEvent.click(within(rows[0] as HTMLElement).getByText('Ver menos'))
    expect(chips(0)).toHaveLength(2)
    expect(splitProducts([1, 2, 3], false)).toEqual({ shown: [1, 2, 3], hidden: 0 })
    expect(splitProducts([1, 2, 3, 4], false)).toEqual({ shown: [1, 2], hidden: 2 })
    expect(splitProducts([1, 2, 3, 4], true)).toEqual({ shown: [1, 2, 3, 4], hidden: 0 })
    expect(PRODUCTS_VISIBLE).toBe(2)
  })
  it('"Ver detalle": only data the row already has (Meta Ad ID, campaña, conjunto, estado) + "Ventas verificadas: No disponible"; no Meta Ads performance metrics', async () => {
    vi.stubGlobal('fetch', reply({ ...withMeta(), meta_capi: null }))
    render(<AdsResultsPage />)
    await waitFor(() => expect(screen.getByTestId('full-ads').querySelector('tbody')).toBeTruthy())
    const full = screen.getByTestId('full-ads')
    expect(within(full).queryByTestId('ad-detail-row')).toBeNull()
    fireEvent.click(within(full).getByLabelText('Ver detalle de Rectificadora Video'))
    const d = within(full).getByTestId(`ad-detail-${IDS[0]}`)
    expect(d.textContent).toContain(IDS[0])
    expect(d.textContent).toMatch(/Campaña.*Campaña A/)
    expect(d.textContent).toMatch(/Conjunto.*Conjunto A/)
    expect(d.textContent).toMatch(/Estado.*Activo/)
    expect(d.textContent).toMatch(/Ventas verificadas.*No disponible/)
    expect(d.textContent).not.toMatch(/Gasto|Reach|Frecuencia|Impresiones|Conversaciones|CTR|CPC|CPM/)
    fireEvent.click(within(full).getByLabelText('Ver detalle de Rectificadora Video'))
    expect(within(full).queryByTestId('ad-detail-row')).toBeNull()
    // unsynced ad: detail has the id and the verified-sales note only (no invented campaign / status)
    fireEvent.click(within(full).getByLabelText('Ver detalle de Anuncio no sincronizado'))
    const u = within(full).getByTestId(`ad-detail-${IDS[2]}`)
    expect(u.textContent).toContain(IDS[2])
    expect(u.textContent).not.toMatch(/Campaña|Conjunto|Estado/)
  })
  it('the section still collapses/expands exactly as before (default collapsed when the product drilldown exists)', async () => {
    const withDrill = buildAdsReport(ROWS, 'f', 't', [{ product: 'Taladro', buyers: 2, orders: 3, units: 4, sales: 300, legacy_orders: 0 }], [{ product: 'Taladro', source_id: IDS[0], buyers: 2, orders: 3, units: 4, sales: 300 }])
    vi.stubGlobal('fetch', reply({ ...withDrill, meta_capi: null }))
    render(<AdsResultsPage />)
    await screen.findByTestId('sold-products')
    const toggle = within(screen.getByTestId('full-ads')).getByRole('button', { name: 'Detalle por anuncio' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByTestId('full-ads').querySelector('table')).toBeNull()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('full-ads').querySelectorAll('tbody tr').length).toBeGreaterThan(0)
  })
  it('no ads in the period: same empty message as before', async () => {
    vi.stubGlobal('fetch', reply({ ...buildAdsReport([], 'f', 't'), meta_capi: null }))
    render(<AdsResultsPage />)
    await waitFor(() => expect(screen.getByText('Sin contactos ni pedidos atribuidos a anuncios en este periodo.')).toBeTruthy())
  })
})
