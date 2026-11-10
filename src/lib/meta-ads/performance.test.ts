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

import { attachDetails, buildExt, isLeadAlias, mergeRange, minorToMajor, MESSAGING_ACTION_TYPES } from './performance'

describe('buildExt (Meta aggregated metrics for one entity and window)', () => {
  const raw = {
    id: '1', reach: 5200, frequency: 1.3462, inline_link_clicks: 120, outbound_clicks: 100,
    actions: {
      'onsite_conversion.messaging_conversation_started_7d': 40, 'onsite_conversion.total_messaging_connection': 55, 'onsite_conversion.messaging_first_reply': 30,
      'onsite_conversion.messaging_user_depth_2_message_send': 20, 'onsite_conversion.messaging_user_depth_3_message_send': 10,
      lead: 1, onsite_web_lead: 1, 'onsite_conversion.lead_grouped': 1, video_view: 900, link_click: 120, brand_new_unknown_type: 3,
    },
  }
  it('REACH and FREQUENCY are Meta\'s window values; link clicks and outbound clicks are separate from clicks', () => {
    const e = buildExt(raw, 7000)
    expect(e).toMatchObject({ reach: 5200, frequency: 1.3462, link_clicks: 120, outbound_clicks: 100 })
  })
  it('the five messaging results map to their EXACT Meta action_types and stay out of "other results"', () => {
    expect(MESSAGING_ACTION_TYPES).toEqual({
      conversations_started: 'onsite_conversion.messaging_conversation_started_7d', connections: 'onsite_conversion.total_messaging_connection',
      first_replies: 'onsite_conversion.messaging_first_reply', depth_2: 'onsite_conversion.messaging_user_depth_2_message_send', depth_3: 'onsite_conversion.messaging_user_depth_3_message_send',
    })
    const e = buildExt(raw, 7000)
    expect(e.messaging).toEqual({ conversations_started: 40, connections: 55, first_replies: 30, depth_2: 20, depth_3: 10 })
    expect(e.other_results.map((o) => o.action_type)).not.toEqual(expect.arrayContaining(Object.values(MESSAGING_ACTION_TYPES)))
  })
  it('a messaging result Meta did not return is null ("not reported"), never 0', () => {
    expect(buildExt({ actions: { video_view: 3 } }, 100).messaging).toEqual({ conversations_started: null, connections: null, first_replies: null, depth_2: null, depth_3: null })
  })
  it('LEAD aliases are listed one by one and NEVER summed; unknown action_types are kept with their technical name and a neutral description', () => {
    const e = buildExt(raw, 7000)
    const leads = e.other_results.filter((o) => o.lead_alias)
    expect(leads.map((o) => o.action_type).sort()).toEqual(['lead', 'onsite_conversion.lead_grouped', 'onsite_web_lead'])
    expect(leads.every((o) => o.value === 1)).toBe(true) // 3 rows of 1, no combined "3"
    expect(e.other_results.some((o) => o.action_type === 'leads' || o.value === 3 && o.lead_alias)).toBe(false)
    const unknown = e.other_results.find((o) => o.action_type === 'brand_new_unknown_type')!
    expect(unknown).toMatchObject({ value: 3, description: 'Otro resultado reportado por Meta', lead_alias: false })
    expect(isLeadAlias('onsite_web_lead')).toBe(true)
    expect(isLeadAlias('video_view')).toBe(false)
  })
  it('other results are sorted by value, described when known', () => {
    const o = buildExt(raw, 7000).other_results
    expect(o[0]).toMatchObject({ action_type: 'video_view', description: 'Reproducciones de video', value: 900 })
    expect(o.map((x) => x.value)).toEqual([...o.map((x) => x.value)].sort((a, b) => b - a))
  })
  it('frequency falls back to impressions / reach ONLY when Meta sent none; reach 0 or null never divides', () => {
    expect(buildExt({ reach: 1000 }, 1500).frequency).toBe(1.5)
    expect(buildExt({ reach: 0 }, 1500).frequency).toBeNull()
    expect(buildExt({}, 1500)).toMatchObject({ reach: null, frequency: null, link_clicks: null, outbound_clicks: null })
    for (const v of Object.values(buildExt({ reach: 0, frequency: 'x', actions: { a: 'NaN' } }, 0))) expect(typeof v === 'number' ? Number.isFinite(v) : true).toBe(true)
  })
})

describe('mergeRange / attachDetails', () => {
  const rows = buildPerfRows([{ id: '111111', spend: 10, impressions: 1000, clicks: 10 }, { id: '222222', spend: 5, impressions: 500, clicks: 5 }])
  it('merges by Meta id; a row without a range entry gets ext = null (no derived value); WACRM-independent fields are untouched', () => {
    const merged = mergeRange(rows, [{ id: '111111', reach: 800, frequency: 1.25, actions: {} }])
    expect(merged.find((r) => r.id === '111111')?.ext).toMatchObject({ reach: 800, frequency: 1.25 })
    expect(merged.find((r) => r.id === '222222')?.ext).toBeNull()
    expect(merged.map((r) => { const c = { ...r }; delete c.ext; return c })).toEqual(rows)
  })
  it('totals of the rows are never used to build reach: two rows with reach 800 and 700 are NOT added into a 1500 anywhere', () => {
    const merged = mergeRange(rows, [{ id: '111111', reach: 800 }, { id: '222222', reach: 700 }])
    expect(JSON.stringify(sumTotals(merged))).not.toContain('reach')
  })
  it('details come from the catalog by id; missing catalog rows give null; non-array catalog leaves rows untouched', () => {
    const d = attachDetails(rows, 'campaign', [{ campaign_id: '111111', objective: 'MESSAGES', buying_type: 'AUCTION', daily_budget: '5000', lifetime_budget: null, start_time: '2026-11-01T15:00:00Z', stop_time: null, updated_time: '2026-11-09T23:00:00Z', ignored: 'x' }], 'campaign_id')
    expect(d[0].detail).toEqual({ objective: 'MESSAGES', buying_type: 'AUCTION', daily_budget: 5000, lifetime_budget: null, start_time: '2026-11-01T15:00:00Z', stop_time: null, updated_time: '2026-11-09T23:00:00Z' })
    expect(d[1].detail).toBeNull()
    expect(attachDetails(rows, 'ad', null, 'ad_id')).toEqual(rows)
  })
  it('budgets are Meta minor units: PEN/USD /100, JPY /1', () => {
    expect(minorToMajor(5000, 'PEN')).toBe(50)
    expect(minorToMajor(1234, 'USD')).toBe(12.34)
    expect(minorToMajor(500, 'JPY')).toBe(500)
  })
})
