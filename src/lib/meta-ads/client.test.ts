import { describe, expect, it, vi } from 'vitest'
import { CATALOG_FIELDS, catalogPageUrl, fetchCatalogPage, parseAd } from './client'

const TOKEN = 'EAAFAKE_TOKEN_should_never_leak_123456'
const opts = { apiVersion: 'v27.0', adAccountId: '409949686293101' }
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers }))

describe('catalog URL', () => {
  it('uses ONLY the ad-account catalog edge (act_<id>/ads): never /{ad_id} and never ?ids=', () => {
    const url = catalogPageUrl(opts)
    expect(url.startsWith('https://graph.facebook.com/v27.0/act_409949686293101/ads?')).toBe(true)
    expect(url).not.toMatch(/[?&]ids=/)
    expect(new URL(url).pathname).toBe('/v27.0/act_409949686293101/ads')
    expect(decodeURIComponent(url)).toContain(CATALOG_FIELDS)
  })
  it('takes the API version from configuration and pages with the opaque cursor only', () => {
    expect(catalogPageUrl({ ...opts, apiVersion: 'v28.0', after: 'CUR123' })).toContain('/v28.0/act_409949686293101/ads?')
    expect(new URL(catalogPageUrl({ ...opts, after: 'CUR123' })).searchParams.get('after')).toBe('CUR123')
  })
  it('requests no insights fields (no spend, impressions, reach, clicks)', () => {
    for (const f of ['spend', 'impressions', 'reach', 'clicks', 'insights']) expect(CATALOG_FIELDS).not.toContain(f)
  })
})

describe('fetchCatalogPage', () => {
  it('sends the token in the Authorization header, never in the URL', async () => {
    const f = json(200, { data: [] })
    await fetchCatalogPage(opts, TOKEN, f as unknown as typeof fetch)
    const [url, init] = f.mock.calls[0] as [string, RequestInit]
    expect(url).not.toContain(TOKEN)
    expect(url).not.toContain('access_token')
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
    expect(init.method).toBe('GET')
  })
  it('maps ads (real name, campaign/adset, status) and keeps the full numeric id as TEXT', async () => {
    const f = json(200, {
      data: [
        {
          id: '120256299148760285', name: 'Rectificadora Video', status: 'ACTIVE', effective_status: 'ACTIVE', adset_id: '120256298878120285', campaign_id: '120256298878110285',
          adset: { name: 'Conjunto 1', id: '120256298878120285' }, campaign: { name: 'Campaña 1', id: '120256298878110285' }, created_time: '2026-11-10T13:00:00+0000', updated_time: '2026-11-10T14:58:00+0000',
        },
      ],
      paging: { cursors: { after: 'NEXT' }, next: 'https://graph.facebook.com/never-followed?access_token=SECRET' },
    })
    const out = await fetchCatalogPage(opts, TOKEN, f as unknown as typeof fetch)
    expect(out).toMatchObject({ kind: 'ok', after: 'NEXT' })
    if (out.kind !== 'ok') throw new Error('unreachable')
    expect(out.ads[0]).toEqual({
      ad_id: '120256299148760285', name: 'Rectificadora Video', adset_id: '120256298878120285', adset_name: 'Conjunto 1', campaign_id: '120256298878110285',
      campaign_name: 'Campaña 1', status: 'ACTIVE', effective_status: 'ACTIVE', meta_created_time: '2026-11-10T13:00:00.000Z', meta_updated_time: '2026-11-10T14:58:00.000Z',
    })
    // the paging.next URL is never requested
    expect(f).toHaveBeenCalledTimes(1)
  })
  it('the last page (cursor but no `next`) ends the pagination', async () => {
    const out = await fetchCatalogPage(opts, TOKEN, json(200, { data: [], paging: { cursors: { after: 'LAST' } } }) as unknown as typeof fetch)
    expect(out).toMatchObject({ kind: 'ok', after: null })
  })
  it('drops entries without a valid numeric id instead of inventing data', () => {
    expect(parseAd({ name: 'x' })).toBeNull()
    expect(parseAd({ id: 'abc', name: 'x' })).toBeNull()
    expect(parseAd(null)).toBeNull()
    expect(parseAd({ id: '120256299148760285' })?.name).toBeNull()
  })
  it('classifies errors: 190 -> auth, rate limits and 5xx -> retry (honouring Meta), others -> rejected; never echoes Meta text or the token', async () => {
    const err = (status: number, code: number, headers: Record<string, string> = {}) =>
      fetchCatalogPage(opts, TOKEN, json(status, { error: { code, message: `bad ${TOKEN}` } }, headers) as unknown as typeof fetch)
    expect(await err(400, 190)).toEqual({ kind: 'auth', httpStatus: 400, code: 'meta_190' })
    expect(await err(403, 200)).toMatchObject({ kind: 'auth' })
    expect(await err(400, 613, { 'retry-after': '120' })).toEqual({ kind: 'retry', httpStatus: 400, code: 'meta_613', retryAfterMs: 120_000 })
    const usage = JSON.stringify({ '123': [{ estimated_time_to_regain_access: 7 }] })
    expect(await err(400, 80004, { 'x-business-use-case-usage': usage })).toMatchObject({ kind: 'retry', retryAfterMs: 420_000 })
    expect(await err(500, 2)).toMatchObject({ kind: 'retry' })
    expect(await err(400, 100)).toEqual({ kind: 'rejected', httpStatus: 400, code: 'meta_100' })
    for (const o of [await err(400, 190), await err(400, 100)]) expect(JSON.stringify(o)).not.toContain(TOKEN)
  })
  it('network failure and malformed bodies are contained', async () => {
    expect(await fetchCatalogPage(opts, TOKEN, vi.fn().mockRejectedValue(new Error(`boom ${TOKEN}`)) as unknown as typeof fetch)).toEqual({ kind: 'retry', httpStatus: null, code: 'network' })
    expect(await fetchCatalogPage(opts, TOKEN, json(200, { nope: 1 }) as unknown as typeof fetch)).toEqual({ kind: 'rejected', httpStatus: 200, code: 'bad_shape' })
    expect(await fetchCatalogPage(opts, TOKEN, vi.fn().mockResolvedValue(new Response('<html>', { status: 502 })) as unknown as typeof fetch)).toMatchObject({ kind: 'retry', code: 'http_502' })
  })
})

describe('ad sets, campaigns and insights requests', () => {
  it('ad sets: act_<id>/adsets with the validated fields, id/name/campaign_id/status/effective_status mapped', async () => {
    const { adsetsPageUrl, campaignsPageUrl, fetchAdsetsPage, parseAdset } = await import('./client')
    expect(adsetsPageUrl(opts)).toContain('/v27.0/act_409949686293101/adsets?')
    expect(decodeURIComponent(adsetsPageUrl(opts))).toContain('fields=id,name,campaign_id,status,effective_status,optimization_goal,billing_event,bid_strategy,daily_budget,lifetime_budget,start_time,end_time,created_time,updated_time')
    expect(campaignsPageUrl(opts)).toContain('/act_409949686293101/campaigns?')
    const out = await fetchAdsetsPage(opts, TOKEN, json(200, { data: [{ id: '120256298878120285', name: 'RECTIFICADORA', campaign_id: '120256298878110285', status: 'ACTIVE', effective_status: 'ACTIVE' }] }) as unknown as typeof fetch)
    expect(out).toEqual({ kind: 'ok', after: null, items: [{ adset_id: '120256298878120285', name: 'RECTIFICADORA', campaign_id: '120256298878110285', status: 'ACTIVE', effective_status: 'ACTIVE', optimization_goal: null, billing_event: null, bid_strategy: null, daily_budget: null, lifetime_budget: null, start_time: null, end_time: null, created_time: null, updated_time: null }] })
    expect(parseAdset({ id: 'x' })).toBeNull()
  })
  it('insights URL: level=ad, time_increment=1, the validated fields, explicit time_range, version from config; no token in the URL', async () => {
    const { insightsPageUrl, INSIGHT_FIELDS } = await import('./client')
    const u = new URL(insightsPageUrl({ ...opts, since: '2026-11-03', until: '2026-11-09' }))
    expect(u.pathname).toBe('/v27.0/act_409949686293101/insights')
    expect(u.searchParams.get('level')).toBe('ad')
    expect(u.searchParams.get('time_increment')).toBe('1')
    expect(u.searchParams.get('fields')).toBe(INSIGHT_FIELDS)
    expect(INSIGHT_FIELDS).toBe('ad_id,ad_name,campaign_id,campaign_name,adset_id,adset_name,impressions,clicks,spend,reach,date_start,date_stop')
    expect(JSON.parse(u.searchParams.get('time_range')!)).toEqual({ since: '2026-11-03', until: '2026-11-09' })
    expect(u.toString()).not.toContain('access_token')
  })
  it('parses a real-looking row keeping spend as an exact decimal string and date_start as the day', async () => {
    const { parseInsight } = await import('./client')
    expect(parseInsight({ ad_id: '120232883780380285', ad_name: 'x', campaign_id: '120256298878110285', campaign_name: '288V PROFECIONAL', adset_id: '120256298878120285', adset_name: 's', impressions: '19819', clicks: '392', spend: '102.50', reach: '18646', date_start: '2026-11-09', date_stop: '2026-11-09' }))
      .toMatchObject({ ad_id: '120232883780380285', date: '2026-11-09', impressions: 19819, clicks: 392, spend: '102.50', reach: 18646, campaign_name: '288V PROFECIONAL' })
  })
  it('account totals: sums come back as strings/ints; no delivery (empty data) is zero; a malformed answer is rejected', async () => {
    const { fetchAccountTotals, accountTotalsUrl } = await import('./client')
    const o = { ...opts, since: '2026-11-03', until: '2026-11-09' }
    expect(new URL(accountTotalsUrl(o)).searchParams.get('level')).toBe('account')
    expect(await fetchAccountTotals(o, TOKEN, json(200, { data: [{ spend: '12463.42', impressions: '3775851', clicks: '62554' }] }) as unknown as typeof fetch)).toEqual({ kind: 'ok', totals: { spend: '12463.42', impressions: 3775851, clicks: 62554 } })
    expect(await fetchAccountTotals(o, TOKEN, json(200, { data: [] }) as unknown as typeof fetch)).toEqual({ kind: 'ok', totals: { spend: '0', impressions: 0, clicks: 0 } })
    expect(await fetchAccountTotals(o, TOKEN, json(200, { data: [{}, {}] }) as unknown as typeof fetch)).toMatchObject({ kind: 'rejected', code: 'bad_shape' })
  })
})
