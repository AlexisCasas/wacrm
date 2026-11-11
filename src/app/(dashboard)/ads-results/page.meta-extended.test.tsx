// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import AdsResultsPage from './page'
import { buildAdsReport } from '@/lib/meta-capi/report'
import { buildExt, buildPerfRows, mergeRange, sumTotals, type MetaPerformance, type PerfRow } from '@/lib/meta-ads/performance'

const C1 = '120256298878110285', C2 = '120256297069270285', S1 = '120256298878120285', S2 = '120256297702420285'
const AD1 = '120232883780380285', AD2 = '120239084979500285'
const raw = [
  { id: AD1, name: '288V Video', status: 'ACTIVE', campaign_id: C1, campaign_name: '288V PROFECIONAL', adset_id: S1, adset_name: 'RECTIFICADORA', spend: 102.5, impressions: 19819, clicks: 392 },
  { id: AD2, name: 'Pulverizador 1', status: 'PAUSED', campaign_id: C2, campaign_name: 'Pulverizador', adset_id: S2, adset_name: 'AMOLADROA IA', spend: 102.65, impressions: 20157, clicks: 511 },
]
const MSG = { 'onsite_conversion.messaging_conversation_started_7d': 40, 'onsite_conversion.total_messaging_connection': 55, 'onsite_conversion.messaging_first_reply': 30, 'onsite_conversion.messaging_user_depth_2_message_send': 20, 'onsite_conversion.messaging_user_depth_3_message_send': 10 }
const adsBase = buildPerfRows(raw)
const ads = mergeRange(adsBase, [
  { id: AD1, reach: 18646, frequency: 1.0629, inline_link_clicks: 300, outbound_clicks: 250, actions: { ...MSG, lead: 1, onsite_web_lead: 1, video_view: 900, brand_new_unknown_type: 3 } },
  { id: AD2, reach: 19218, frequency: 1.0489, inline_link_clicks: 400, outbound_clicks: 350, actions: {} },
]).map((r) => ({ ...r, detail: r.id === AD1 ? { created_time: '2026-11-01T10:00:00Z', updated_time: '2026-11-09T10:00:00Z' } : null }))
const campaigns = mergeRange(buildPerfRows([
  { id: C1, name: '288V PROFECIONAL', status: 'ACTIVE', spend: 102.5, impressions: 19819, clicks: 392 },
  { id: C2, name: 'Pulverizador', status: 'PAUSED', spend: 102.65, impressions: 20157, clicks: 511 },
]), [{ id: C1, reach: 18646, frequency: 1.0629, actions: {} }, { id: C2, reach: 19218, frequency: 1.0489, actions: {} }]).map((r) => ({ ...r, detail: r.id === C1 ? { objective: 'MESSAGES', buying_type: 'AUCTION', daily_budget: 5000, lifetime_budget: null, start_time: '2026-11-01T15:00:00Z', stop_time: null, updated_time: '2026-11-09T20:00:00Z' } : null }))
const adsets = mergeRange(buildPerfRows([
  { id: S1, name: 'RECTIFICADORA', status: 'ACTIVE', campaign_id: C1, campaign_name: '288V PROFECIONAL', spend: 102.5, impressions: 19819, clicks: 392 },
]), [{ id: S1, reach: 18646, frequency: 1.0629, actions: {} }]).map((r) => ({ ...r, detail: { optimization_goal: 'CONVERSATIONS', billing_event: 'IMPRESSIONS', bid_strategy: null, daily_budget: null, lifetime_budget: null, start_time: null, end_time: null, updated_time: null } }))
const summary = buildExt({ id: '409949686293101', reach: 37864, frequency: 1.0558, inline_link_clicks: 700, outbound_clicks: 600, actions: { ...MSG, lead: 2, video_view: 1800, onsite_web_lead: 2 } }, 39976)
const baseData = (): Extract<MetaPerformance, { available: true }> => ({
  available: true,
  period: { days: 7, since: '2026-11-03', until: '2026-11-09', timezone: 'America/Bogota', currency: 'PEN' },
  synced_at: '2026-11-10T16:00:00.000Z',
  sync: { state: 'ok', covered_from: '2026-08-12', covered_to: '2026-11-10', partial: false },
  reconciliation: null,
  totals: sumTotals(adsBase),
  campaigns: buildPerfRows([{ id: C1, name: '288V PROFECIONAL', status: 'ACTIVE', spend: 102.5, impressions: 19819, clicks: 392 }, { id: C2, name: 'Pulverizador', status: 'PAUSED', spend: 102.65, impressions: 20157, clicks: 511 }]),
  adsets: buildPerfRows([{ id: S1, name: 'RECTIFICADORA', status: 'ACTIVE', campaign_id: C1, campaign_name: '288V PROFECIONAL', spend: 102.5, impressions: 19819, clicks: 392 }]),
  ads: adsBase,
  extended: null,
})
const extData = (over: Partial<Extract<MetaPerformance, { available: true }>> = {}): MetaPerformance => ({ ...baseData(), campaigns: campaigns as PerfRow[], adsets: adsets as PerfRow[], ads: ads as PerfRow[], extended: { available: true, summary }, ...over })
const wacrm = (extra: object = {}) => ({
  ...buildAdsReport([{ source_id: AD1, headline: 'InkaClick', contacts: 40, buyers: 2, orders: 3, order_amount: 300, units: 4, products: [{ name: 'Laser', units: 4 }] }], 'f', 't', [{ product: 'Taladro', buyers: 24, orders: 26, units: 35, sales: 3440, legacy_orders: 0 }]),
  meta_capi: null, meta_ads: { configured: true }, ...extra,
})
const router = (report: unknown, meta: () => Promise<unknown>) => vi.fn(async (url: string) => (String(url).startsWith('/api/ads/meta-performance') ? meta() : { ok: true, status: 200, json: async () => report }))
const ok = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body })
beforeEach(() => { vi.stubGlobal('fetch', undefined) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const heads = (t: string) => Array.from(screen.getByTestId(t).querySelectorAll('th')).map((h) => h.textContent)

describe('Rendimiento Meta Ads — extended metrics', () => {
  it('KPIs are grouped: Rendimiento (with Reach and Frecuencia from Meta\'s aggregate), Tráfico (Clics / Clics en enlace / Clics salientes kept separate), Mensajería (Meta)', async () => {
    vi.stubGlobal('fetch', router(wacrm(), ok(extData())))
    render(<AdsResultsPage />)
    const t = await screen.findByTestId('meta-totals')
    const perf = within(screen.getByTestId('meta-group-performance'))
    for (const l of ['Gasto', 'Impresiones', 'Reach', 'Frecuencia', 'CTR', 'CPC', 'CPM']) expect(perf.getByText(l)).toBeTruthy()
    expect(perf.getByText('Reach').nextSibling?.textContent).toBe('37,864')
    expect(perf.getByText('Frecuencia').nextSibling?.textContent).toBe('1.06')
    const traffic = within(screen.getByTestId('meta-group-traffic'))
    expect(traffic.getByText('Clics').nextSibling?.textContent).toBe('903')
    expect(traffic.getByText('Clics en enlace').nextSibling?.textContent).toBe('700')
    expect(traffic.getByText('Clics salientes').nextSibling?.textContent).toBe('600')
    const msg = within(screen.getByTestId('meta-group-messaging'))
    expect(msg.getByText('Conversaciones iniciadas (Meta)').nextSibling?.textContent).toBe('40')
    expect(msg.getByText('Conexiones de mensajería (Meta)').nextSibling?.textContent).toBe('55')
    expect(msg.getByText('Primeras respuestas (Meta)').nextSibling?.textContent).toBe('30')
    expect(msg.getByText('Llegaron a 2 mensajes (Meta)').nextSibling?.textContent).toBe('20')
    expect(msg.getByText('Llegaron a 3 mensajes (Meta)').nextSibling?.textContent).toBe('10')
    expect(msg.getByText('Conversaciones iniciadas (Meta)').parentElement?.getAttribute('title')).toBe('Resultado atribuido por Meta Ads. No equivale a contactos únicos de WACRM.')
    expect(t.textContent).not.toMatch(/Contactos|Compradores|Pedidos|NaN|Infinity/)
  })
  it('tables: Reach and Frecuencia columns in the three views; headers exactly as requested', async () => {
    vi.stubGlobal('fetch', router(wacrm(), ok(extData())))
    render(<AdsResultsPage />)
    await screen.findByTestId('meta-performance')
    expect(heads('meta-table-campaigns')).toEqual(['Campaña', 'Estado', 'Gasto', 'Impresiones', 'Reach', 'Frecuencia', 'Clics', 'CTR', 'CPC', 'CPM'])
    fireEvent.click(screen.getByText('Conjuntos de anuncios'))
    expect(heads('meta-table-adsets')).toEqual(['Conjunto de anuncios', 'Campaña', 'Estado', 'Gasto', 'Impresiones', 'Reach', 'Frecuencia', 'Clics', 'CTR', 'CPC', 'CPM'])
    fireEvent.click(within(screen.getByTestId('meta-performance')).getByText('Anuncios'))
    expect(heads('meta-table-ads')).toEqual(['Anuncio', 'Ad ID', 'Campaña', 'Conjunto', 'Estado', 'Gasto', 'Impresiones', 'Reach', 'Frecuencia', 'Clics', 'CTR', 'CPC', 'CPM'])
    const row = Array.from(screen.getByTestId('meta-table-ads').querySelectorAll('tbody tr'))[1] // sorted by spend: AD2 first, AD1 second
    const cells = Array.from(row.querySelectorAll('td')).map((c) => c.textContent)
    expect(cells.slice(1, 3)).toEqual([AD1, '288V PROFECIONAL']) // Ad ID stays visible
    expect(cells.slice(5)).toEqual(['102.50', '19,819', '18,646', '1.06', '392', '1.98%', '0.26', '5.17'])
  })
  it('campaign detail (expandable): id, objective, buying type, daily/lifetime budget in major units, start/stop/updated, traffic', async () => {
    vi.stubGlobal('fetch', router(wacrm(), ok(extData())))
    render(<AdsResultsPage />)
    await screen.findByTestId('meta-performance')
    fireEvent.click(screen.getByLabelText('Detalle de 288V PROFECIONAL'))
    const d = screen.getByTestId(`meta-detail-${C1}`)
    expect(d.textContent).toContain(C1)
    expect(d.textContent).toContain('MESSAGES')
    expect(d.textContent).toContain('AUCTION')
    expect(d.textContent).toContain('PEN 50.00') // 5000 minor units
    expect(d.textContent).toContain('Presupuesto total')
  })
  it('ad set detail shows optimization goal and billing event; ad detail shows created/updated, link + outbound clicks, the five messaging results and "Otros resultados Meta"', async () => {
    vi.stubGlobal('fetch', router(wacrm(), ok(extData())))
    render(<AdsResultsPage />)
    await screen.findByTestId('meta-performance')
    fireEvent.click(screen.getByText('Conjuntos de anuncios'))
    fireEvent.click(screen.getByLabelText('Detalle de RECTIFICADORA'))
    expect(screen.getByTestId(`meta-detail-${S1}`).textContent).toMatch(/CONVERSATIONS.*IMPRESSIONS/)
    fireEvent.click(within(screen.getByTestId('meta-performance')).getByText('Anuncios'))
    fireEvent.click(screen.getByLabelText('Detalle de 288V Video'))
    const d = screen.getByTestId(`meta-detail-${AD1}`)
    for (const l of ['Clics en enlace', 'Clics salientes', 'Conversaciones iniciadas (Meta)', 'Conexiones de mensajería (Meta)', 'Primeras respuestas (Meta)', 'Llegaron a 2 mensajes (Meta)', 'Llegaron a 3 mensajes (Meta)', 'Creado', 'Actualizado']) expect(d.textContent).toContain(l)
    const other = within(d).getByTestId('meta-other-results')
    expect(other.textContent).toContain('Otros resultados Meta')
    for (const t of ['video_view', 'brand_new_unknown_type', 'lead', 'onsite_web_lead']) expect(other.textContent).toContain(t)
    expect(other.textContent).toContain('Otro resultado reportado por Meta') // unknown action_type: neutral description, technical name shown
    expect(other.textContent).toMatch(/no se suman/) // lead aliases are listed one by one
    expect(other.textContent).not.toContain('onsite_conversion.messaging') // messaging has its own labelled slots
  })
  it('the account-level "Otros resultados Meta" is a collapsible detail; WACRM labels never appear in Meta metrics', async () => {
    vi.stubGlobal('fetch', router(wacrm(), ok(extData())))
    render(<AdsResultsPage />)
    const sec = await screen.findByTestId('meta-performance')
    const details = within(sec).getAllByTestId('meta-other-results')[0]
    expect(details.tagName).toBe('DETAILS')
    expect(details.textContent).toContain('Resultados reportados por Meta. No son contactos, pedidos ni ventas de WACRM.')
  })
  it('a messaging result Meta did not report is not shown as a KPI (no fake zero)', async () => {
    const s = buildExt({ reach: 100, actions: { 'onsite_conversion.messaging_conversation_started_7d': 7 } }, 150)
    vi.stubGlobal('fetch', router(wacrm(), ok(extData({ extended: { available: true, summary: s } }))))
    render(<AdsResultsPage />)
    await screen.findByTestId('meta-performance')
    const msg = within(screen.getByTestId('meta-group-messaging'))
    expect(msg.getByText('Conversaciones iniciadas (Meta)')).toBeTruthy()
    expect(msg.queryByText('Conexiones de mensajería (Meta)')).toBeNull()
    expect(msg.queryByText('Llegaron a 3 mensajes (Meta)')).toBeNull()
  })
  it('rows without cached range data show "—" for Reach and Frecuencia (never a derived number)', async () => {
    const partial = extData({ ads: mergeRange(adsBase, [{ id: AD1, reach: 18646, frequency: 1.0629, actions: {} }]) as PerfRow[] })
    vi.stubGlobal('fetch', router(wacrm(), ok(partial)))
    render(<AdsResultsPage />)
    await screen.findByTestId('meta-performance')
    fireEvent.click(within(screen.getByTestId('meta-performance')).getByText('Anuncios'))
    const cells = Array.from(Array.from(screen.getByTestId('meta-table-ads').querySelectorAll('tbody tr'))[0].querySelectorAll('td')).map((c) => c.textContent) // AD2 (no cached range) is the first row
    expect(cells.slice(7, 9)).toEqual(['—', '—'])
  })
  it('FALLBACK TO CHECKPOINT: no extended cache => the section is exactly the previous one (6 KPIs, no Reach/Frecuencia columns, no detail buttons)', async () => {
    vi.stubGlobal('fetch', router(wacrm(), ok(baseData())))
    render(<AdsResultsPage />)
    await screen.findByTestId('meta-performance')
    expect(screen.queryByTestId('meta-group-performance')).toBeNull()
    expect(screen.getByTestId('meta-totals').textContent).not.toMatch(/Reach|Frecuencia|salientes/)
    expect(heads('meta-table-campaigns')).toEqual(['Campaña', 'Estado', 'Gasto', 'Impresiones', 'Clics', 'CTR', 'CPC', 'CPM'])
    expect(screen.queryByLabelText(/Detalle de/)).toBeNull()
    expect(screen.getByTestId('meta-performance').textContent).toMatch(/El alcance no se muestra porque no se puede sumar entre días/)
  })
  it('FALLBACK: Meta totally down (endpoint unavailable / 500 / network): the section disappears and every WACRM block is intact', async () => {
    for (const meta of [ok({ available: false, reason: 'unavailable' }), async () => ({ ok: false, status: 500, json: async () => ({}) }), async () => { throw new Error('down') }]) {
      vi.stubGlobal('fetch', router(wacrm(), meta))
      const { unmount } = render(<AdsResultsPage />)
      await waitFor(() => expect(screen.getByTestId('full-ads')).toBeTruthy())
      expect(screen.queryByTestId('meta-performance')).toBeNull()
      const card = (l: string) => screen.getByText(l).nextSibling?.textContent
      expect(card('Contactos atribuidos')).toBe('40')
      expect(card('Pedidos confirmados (con anuncio)')).toBe('3')
      expect(screen.getByRole('button', { name: 'Por producto' })).toBeTruthy() // product view still offered
      expect(screen.getByTestId('full-ads')).toBeTruthy()
      unmount()
    }
  })
  it('WACRM figures are identical with and without the extended Meta layer', async () => {
    const text = async (meta: unknown) => {
      vi.stubGlobal('fetch', router(wacrm(), ok(meta)))
      const { container, unmount } = render(<AdsResultsPage />)
      await screen.findByTestId('meta-performance')
      const t = Array.from(container.querySelectorAll('[data-slot="card"]')).filter((c) => c.getAttribute('data-testid') !== 'meta-performance').slice(0, 5).map((c) => c.textContent)
      unmount()
      return t
    }
    expect(await text(extData())).toEqual(await text(baseData()))
  })
})
