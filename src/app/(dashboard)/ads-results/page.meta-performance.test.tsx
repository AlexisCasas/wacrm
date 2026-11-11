// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import AdsResultsPage from './page'
import { buildAdsReport } from '@/lib/meta-capi/report'
import { buildPerfRows, sumTotals, type MetaPerformance } from '@/lib/meta-ads/performance'

const C1 = '120256298878110285', C2 = '120256297069270285', S1 = '120256298878120285', S2 = '120256297702420285'
const AD1 = '120232883780380285', AD2 = '120239084979500285', AD3 = '120256299148760285'
const ads = buildPerfRows([
  { id: AD1, name: '288V Video', status: 'ACTIVE', campaign_id: C1, campaign_name: '288V PROFECIONAL', adset_id: S1, adset_name: 'RECTIFICADORA', spend: 102.5, impressions: 19819, clicks: 392 },
  { id: AD2, name: 'Pulverizador 1', status: 'PAUSED', campaign_id: C2, campaign_name: 'Pulverizador', adset_id: S2, adset_name: 'AMOLADROA IA', spend: 102.65, impressions: 20157, clicks: 511 },
  { id: AD3, name: null, status: null, campaign_id: C2, campaign_name: 'Pulverizador', adset_id: S2, adset_name: 'AMOLADROA IA', spend: 0, impressions: 0, clicks: 0 },
])
const perf = (over: Partial<Extract<MetaPerformance, { available: true }>> = {}): MetaPerformance => ({
  available: true,
  period: { days: 7, since: '2026-11-03', until: '2026-11-09', timezone: 'America/Bogota', currency: 'PEN' },
  synced_at: '2026-11-10T16:00:00.000Z',
  sync: { state: 'ok', covered_from: '2026-08-12', covered_to: '2026-11-10', partial: false },
  reconciliation: { ok: true, checked_at: '2026-11-10T16:00:00.000Z', date_from: '2026-11-03', date_to: '2026-11-09' },
  totals: sumTotals(ads),
  campaigns: buildPerfRows([
    { id: C1, name: '288V PROFECIONAL', status: 'ACTIVE', spend: 102.5, impressions: 19819, clicks: 392 },
    { id: C2, name: 'Pulverizador', status: 'PAUSED', spend: 102.65, impressions: 20157, clicks: 511 },
  ]),
  adsets: buildPerfRows([
    { id: S1, name: 'RECTIFICADORA', status: 'ACTIVE', campaign_id: C1, campaign_name: '288V PROFECIONAL', spend: 102.5, impressions: 19819, clicks: 392 },
    { id: S2, name: 'AMOLADROA IA', status: 'ACTIVE', campaign_id: C2, campaign_name: 'Pulverizador', spend: 102.65, impressions: 20157, clicks: 511 },
  ]),
  ads,
  ...over,
})
const wacrm = (extra: object = {}) => ({
  ...buildAdsReport(
    [{ source_id: AD3, headline: 'InkaClick', contacts: 40, buyers: 2, orders: 3, order_amount: 300, units: 4, products: [{ name: 'Laser', units: 4 }] }],
    'f', 't', [{ product: 'Taladro', buyers: 24, orders: 26, units: 35, sales: 3440, legacy_orders: 0 }],
  ),
  meta_capi: null,
  ...extra,
})
// routes by URL: the WACRM report and the (separate) Meta performance endpoint
const router = (report: unknown, meta: () => Promise<unknown>) =>
  vi.fn(async (url: string) => {
    if (String(url).startsWith('/api/ads/meta-performance')) return meta()
    return { ok: true, status: 200, json: async () => report }
  })
const ok = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body })

beforeEach(() => { vi.stubGlobal('fetch', undefined) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Rendimiento Meta Ads section', () => {
  it('shows updated-at + sync state, period, totals with CTR/CPC/CPM, and the three views with the requested columns', async () => {
    vi.stubGlobal('fetch', router(wacrm({ meta_ads: { configured: true } }), ok(perf())))
    render(<AdsResultsPage />)
    const sec = await screen.findByTestId('meta-performance')
    expect(within(sec).getByText('Rendimiento Meta Ads')).toBeTruthy()
    expect(screen.getByTestId('meta-sync-status').textContent).toMatch(/Actualizado al .* Sincronización al día/)
    expect(sec.textContent).toMatch(/Período: .*America\/Bogota.*PEN/)
    expect(screen.getByTestId('meta-totals').textContent).toContain('205.15')
    expect(screen.getByTestId('meta-totals').textContent).toContain('2.26%') // 903 / 39976
    const heads = (t: string) => Array.from(screen.getByTestId(t).querySelectorAll('th')).map((h) => h.textContent)
    expect(heads('meta-table-campaigns')).toEqual(['Campaña', 'Estado', 'Gasto', 'Impresiones', 'Clics', 'CTR', 'CPC', 'CPM'])
    fireEvent.click(within(sec).getByText('Conjuntos de anuncios'))
    expect(heads('meta-table-adsets')).toEqual(['Conjunto de anuncios', 'Campaña', 'Estado', 'Gasto', 'Impresiones', 'Clics', 'CTR', 'CPC', 'CPM'])
    fireEvent.click(within(sec).getByText('Anuncios'))
    expect(heads('meta-table-ads')).toEqual(['Anuncio', 'Ad ID', 'Campaña', 'Conjunto', 'Estado', 'Gasto', 'Impresiones', 'Clics', 'CTR', 'CPC', 'CPM'])
  })
  it('campaigns view: one row per campaign_id with spend, impressions, clicks, CTR, CPC and CPM', async () => {
    vi.stubGlobal('fetch', router(wacrm({ meta_ads: { configured: true } }), ok(perf())))
    render(<AdsResultsPage />)
    await screen.findByTestId('meta-performance')
    const rows = Array.from(screen.getByTestId('meta-table-campaigns').querySelectorAll('tbody tr')).map((r) => Array.from(r.querySelectorAll('td')).map((c) => c.textContent))
    expect(rows).toEqual([
      ['PulverizadorID 120256297069270285', 'Pausado', '102.65', '20,157', '511', '2.54%', '0.20', '5.09'],
      ['288V PROFECIONALID 120256298878110285', 'Activo', '102.50', '19,819', '392', '1.98%', '0.26', '5.17'],
    ].map((r) => r.map((c) => c.replace(/,/g, (m) => m)))) // es-PE grouping shown as in the table
  })
  it('ads view shows the Ad ID in its own column; an ad without a name says so; zero denominators render "—"', async () => {
    vi.stubGlobal('fetch', router(wacrm({ meta_ads: { configured: true } }), ok(perf())))
    render(<AdsResultsPage />)
    await screen.findByTestId('meta-performance')
    fireEvent.click(within(screen.getByTestId('meta-performance')).getByText('Anuncios'))
    const last = Array.from(screen.getByTestId('meta-table-ads').querySelectorAll('tbody tr')).at(-1)!
    const cells = Array.from(last.querySelectorAll('td')).map((c) => c.textContent)
    expect(cells.slice(0, 5)).toEqual(['Anuncio no sincronizado', AD3, 'Pulverizador', 'AMOLADROA IA', '—'])
    expect(cells.slice(5)).toEqual(['0.00', '0', '0', '—', '—', '—'])
    expect(screen.getByTestId('meta-performance').textContent).not.toMatch(/NaN|Infinity/)
  })
  it('the section follows the 7 / 30 / 90 filter (refetches with the chosen days)', async () => {
    const f = router(wacrm({ meta_ads: { configured: true } }), ok(perf()))
    vi.stubGlobal('fetch', f)
    render(<AdsResultsPage />)
    await screen.findByTestId('meta-performance')
    expect(f).toHaveBeenCalledWith('/api/ads/meta-performance?days=30')
    fireEvent.click(screen.getByText('7 días'))
    await waitFor(() => expect(f).toHaveBeenCalledWith('/api/ads/meta-performance?days=7'))
    fireEvent.click(screen.getByText('90 días'))
    await waitFor(() => expect(f).toHaveBeenCalledWith('/api/ads/meta-performance?days=90'))
  })
  it('states: partial coverage, syncing, error and paused are all stated honestly; reach is explained, never shown', async () => {
    vi.stubGlobal('fetch', router(wacrm({ meta_ads: { configured: true } }), ok(perf({ sync: { state: 'syncing', covered_from: '2026-11-04', covered_to: '2026-11-10', partial: true }, reconciliation: { ok: false, checked_at: '2026-11-10T16:00:00Z', date_from: '2026-11-03', date_to: '2026-11-09' } }))))
    render(<AdsResultsPage />)
    await screen.findByTestId('meta-performance')
    expect(screen.getByTestId('meta-partial').textContent).toMatch(/Datos parciales/)
    expect(screen.getByTestId('meta-sync-status').textContent).toMatch(/Cargando historial/)
    const text = screen.getByTestId('meta-performance').textContent!
    expect(text).toMatch(/diferencias con los totales de Meta/)
    expect(text).toMatch(/El alcance no se muestra porque no se puede sumar entre días/)
    expect(screen.queryByText('Alcance')).toBeNull()
  })
})

describe('FALLBACK: the existing /ads-results never depends on Meta Ads', () => {
  const unchanged = async () => {
    await waitFor(() => expect(screen.getByTestId('full-ads')).toBeTruthy())
    const card = (l: string) => screen.getByText(l).nextSibling?.textContent
    expect(card('Contactos atribuidos')).toBe('40')
    expect(card('Pedidos confirmados (con anuncio)')).toBe('3')
    expect(screen.getByRole('button', { name: 'Por producto' })).toBeTruthy() // product view still offered
    expect(screen.getByTestId('full-ads')).toBeTruthy()
  }
  it('Meta Ads not configured: no section and NO extra request', async () => {
    const f = router(wacrm(), ok(perf()))
    vi.stubGlobal('fetch', f)
    render(<AdsResultsPage />)
    await unchanged()
    expect(screen.queryByTestId('meta-performance')).toBeNull()
    expect(f).toHaveBeenCalledTimes(1)
  })
  it.each([
    ['endpoint says unavailable', ok({ available: false, reason: 'unavailable' })],
    ['endpoint fails (500)', async () => ({ ok: false, status: 500, json: async () => ({}) })],
    ['network error', async () => { throw new Error('down') }],
    ['garbage payload', ok({ hello: 'world' })],
  ])('configured but the Meta section cannot load (%s): the section is omitted, everything else is intact', async (_n, meta) => {
    vi.stubGlobal('fetch', router(wacrm({ meta_ads: { configured: true } }), meta as () => Promise<unknown>))
    render(<AdsResultsPage />)
    await unchanged()
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2))
    expect(screen.queryByTestId('meta-performance')).toBeNull()
  })
  it('the WACRM figures are identical with and without the Meta section', async () => {
    const cards = async (report: unknown) => {
      vi.stubGlobal('fetch', router(report, ok(perf())))
      const { container, unmount } = render(<AdsResultsPage />)
      await waitFor(() => expect(screen.getByTestId('full-ads')).toBeTruthy())
      await waitFor(() => (report as { meta_ads?: unknown }).meta_ads ? expect(screen.getByTestId('meta-performance')).toBeTruthy() : undefined)
      const text = [...container.querySelectorAll('[data-slot="card"]')].filter((c) => !c.querySelector('[data-testid="meta-performance"]') && c.getAttribute('data-testid') !== 'meta-performance').slice(0, 5).map((c) => c.textContent)
      unmount()
      return text
    }
    expect(await cards(wacrm({ meta_ads: { configured: true } }))).toEqual(await cards(wacrm()))
  })
})
