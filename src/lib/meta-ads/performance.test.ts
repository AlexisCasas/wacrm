import { describe, expect, it } from 'vitest'
import { buildPerfRows, metaWindow, metrics, ratios, sumTotals, syncState } from './performance'

describe('ratios (computed from TOTALS)', () => {
  it('CTR = clicks / impressions * 100, CPC = spend / clicks, CPM = spend / impressions * 1000', () => {
    expect(ratios({ spend: 12463.42, impressions: 3775851, clicks: 62554 })).toEqual({ ctr: 1.6567, cpc: 0.1992, cpm: 3.3008 })
    expect(ratios({ spend: 102.5, impressions: 19819, clicks: 392 })).toMatchObject({ ctr: 1.9779, cpc: 0.2615, cpm: 5.1718 })
  })
  it('division by zero is null (shown as "—"), never NaN or Infinity', () => {
    for (const t of [{ spend: 10, impressions: 0, clicks: 0 }, { spend: 10, impressions: 500, clicks: 0 }, { spend: 0, impressions: 0, clicks: 0 }]) {
      const r = ratios(t)
      for (const v of Object.values(r)) expect(v === null || Number.isFinite(v)).toBe(true)
    }
    expect(ratios({ spend: 10, impressions: 0, clicks: 0 })).toEqual({ ctr: null, cpc: null, cpm: null })
    expect(ratios({ spend: 10, impressions: 500, clicks: 0 })).toEqual({ ctr: 0, cpc: null, cpm: 20 })
    expect(ratios({ spend: 0, impressions: 1000, clicks: 10 })).toEqual({ ctr: 1, cpc: 0, cpm: 0 })
  })
  it('totals are NOT an average of the rows\' ratios', () => {
    const rows = buildPerfRows([
      { id: '1', spend: 100, impressions: 1000, clicks: 100 }, // CTR 10 %
      { id: '2', spend: 100, impressions: 99000, clicks: 100 }, // CTR 0.1 %
    ])
    expect(rows.map((r) => r.ctr).sort()).toEqual([0.101, 10].sort())
    expect(sumTotals(rows).ctr).toBe(0.2) // 200 / 100000, not (10 + 0.1) / 2
    expect(sumTotals(rows).cpc).toBe(1)
  })
})

describe('period', () => {
  it('7/30/90 = the N COMPLETE Meta days before today in the ad account timezone (today excluded)', () => {
    const now = Date.parse('2026-11-10T16:00:00Z')
    expect(metaWindow(7, 'America/Bogota', now)).toEqual({ since: '2026-11-03', until: '2026-11-09' })
    expect(metaWindow(30, 'America/Bogota', now)).toEqual({ since: '2026-10-11', until: '2026-11-09' })
    expect(metaWindow(90, 'America/Bogota', now)).toEqual({ since: '2026-08-12', until: '2026-11-09' })
    // 02:00 UTC is still the previous calendar day in Bogota
    expect(metaWindow(7, 'America/Bogota', Date.parse('2026-11-10T02:00:00Z'))).toEqual({ since: '2026-11-02', until: '2026-11-08' })
  })
})

describe('buildPerfRows', () => {
  it('keys by Meta id, sorts by spend then id, parses numerics safely and drops rows without an id', () => {
    const rows = buildPerfRows([
      { id: '120256298878110285', name: 'Pulverizador', status: 'ACTIVE', spend: '102.65', impressions: '20157', clicks: 511 },
      { id: '120232883780380285', name: '288V PROFECIONAL', spend: 102.5, impressions: 19819, clicks: 392 },
      { id: '120256298878120285', name: null, spend: 'oops', impressions: null, clicks: undefined },
      { name: 'no id', spend: 5 },
    ])
    expect(rows.map((r) => r.id)).toEqual(['120256298878110285', '120232883780380285', '120256298878120285'])
    expect(rows[0]).toMatchObject({ spend: 102.65, impressions: 20157, clicks: 511 })
    expect(rows[2]).toMatchObject({ spend: 0, impressions: 0, clicks: 0, ctr: null, cpc: null, cpm: null })
    expect(buildPerfRows(null)).toEqual([])
  })
  it('metrics rounds spend to cents without float drift', () => {
    expect(metrics(0.1 + 0.2, 0, 0).spend).toBe(0.3)
  })
})

describe('syncState', () => {
  it('maps the stored job state to what the UI says', () => {
    expect(syncState({ status: 'paused', last_success_at: 'x' }, false)).toBe('paused')
    expect(syncState({ status: 'error', last_success_at: 'x' }, false)).toBe('error')
    expect(syncState({ status: 'ok', last_success_at: null }, false)).toBe('pending')
    expect(syncState({ status: 'ok', last_success_at: 'x' }, true)).toBe('syncing')
    expect(syncState({ status: 'ok', last_success_at: 'x' }, false)).toBe('ok')
  })
})
