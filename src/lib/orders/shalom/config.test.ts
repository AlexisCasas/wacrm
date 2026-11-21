import { describe, expect, it } from 'vitest'

import {
  SHALOM_DEFAULTS, attentionWindowElapsed, isShalomGloballyEnabled, nextPollAfterFailure, nextPollAfterSuccess, rateLimitPauseSeconds, readShalomConfig,
} from '@/lib/orders/shalom/config'
import { createFakeProvider, notConfiguredProvider, pickScenario, resolveShalomProvider } from '@/lib/orders/shalom/providers'

const NOW = new Date('2026-12-01T15:00:00Z')
const minutes = (d: Date | null) => (d ? (d.getTime() - NOW.getTime()) / 60_000 : null)

describe('centralized configuration (DEFAULT QA / PROVISIONAL, never an SLA)', () => {
  it('provisional defaults: tick 15 min; origin 3 h, transit 3 h, destination 12 h; 15 calendar days', () => {
    expect(SHALOM_DEFAULTS.tickMinutes).toBe(15)
    expect(SHALOM_DEFAULTS.intervalMinutes).toEqual({ at_origin: 180, in_transit: 180, at_destination: 720 })
    expect(SHALOM_DEFAULTS.alertDays).toBe(15)
  })

  it('next query after a good answer depends on the status; delivered is never asked again', () => {
    const cfg = readShalomConfig({})
    expect(minutes(nextPollAfterSuccess('at_origin', NOW, cfg))).toBe(180)
    expect(minutes(nextPollAfterSuccess('in_transit', NOW, cfg))).toBe(180)
    expect(minutes(nextPollAfterSuccess('at_destination', NOW, cfg))).toBe(720)
    expect(nextPollAfterSuccess('delivered', NOW, cfg)).toBeNull()
  })

  it('backoff after failures is bounded and its last step repeats', () => {
    const cfg = readShalomConfig({})
    expect([1, 2, 3, 4, 5, 6, 7, 50].map((f) => minutes(nextPollAfterFailure(f, NOW, cfg)))).toEqual([15, 30, 60, 120, 240, 360, 360, 360])
    expect(minutes(nextPollAfterFailure(0, NOW, cfg))).toBe(15)
  })

  it('a 429 pause honours Retry-After within bounds and falls back otherwise', () => {
    const cfg = readShalomConfig({})
    expect(rateLimitPauseSeconds(7, cfg)).toBe(7)
    expect(rateLimitPauseSeconds(0, cfg)).toBe(1)
    expect(rateLimitPauseSeconds(100_000, cfg)).toBe(900)
    expect(rateLimitPauseSeconds(null, cfg)).toBe(60)
    expect(rateLimitPauseSeconds(Number.NaN, cfg)).toBe(60)
  })

  it('an order-level error needs a person only after the configured window: one single failure never does', () => {
    const cfg = readShalomConfig({})
    expect(attentionWindowElapsed(null, NOW, cfg)).toBe(false)
    expect(attentionWindowElapsed(NOW, NOW, cfg)).toBe(false)
    expect(attentionWindowElapsed(new Date(NOW.getTime() - 23 * 3_600_000), NOW, cfg)).toBe(false)
    expect(attentionWindowElapsed(new Date(NOW.getTime() - 24 * 3_600_000), NOW, cfg)).toBe(true)
  })

  it('SHALOM_CONFIG_JSON accelerates the QA clock; anything invalid is ignored and never loosens a bound', () => {
    const cfg = readShalomConfig({ SHALOM_CONFIG_JSON: JSON.stringify({ intervalMinutes: { at_origin: 1, in_transit: 2 }, attentionWindowHours: 1, batchSize: 500, backoffMinutes: [1, 2], alertDays: 3 }) })
    expect(cfg.intervalMinutes).toEqual({ at_origin: 1, in_transit: 2, at_destination: 720 })
    expect(cfg.attentionWindowHours).toBe(1)
    expect(cfg.batchSize).toBe(50)
    expect(cfg.backoffMinutes).toEqual([1, 2])
    expect(cfg.alertDays).toBe(3)
    for (const bad of ['not json', '[]', '"x"', JSON.stringify({ alertDays: -1, batchSize: 0, backoffMinutes: [0, 'x'], timeoutMs: 'fast' })]) {
      expect(readShalomConfig({ SHALOM_CONFIG_JSON: bad })).toEqual(SHALOM_DEFAULTS)
    }
  })

  it('the global kill switch is OFF unless SHALOM_TRACKING_ENABLED is exactly "true"', () => {
    for (const v of [undefined, '', 'false', 'TRUE', '1', 'yes']) expect(isShalomGloballyEnabled({ SHALOM_TRACKING_ENABLED: v })).toBe(false)
    expect(isShalomGloballyEnabled({ SHALOM_TRACKING_ENABLED: 'true' })).toBe(true)
  })
})

describe('provider resolution (no real provider exists)', () => {
  it('defaults to not_configured; production can never resolve the fake', () => {
    expect(resolveShalomProvider({})).toBe(notConfiguredProvider)
    expect(resolveShalomProvider({ SHALOM_PROVIDER: 'fake', NODE_ENV: 'production' })).toBe(notConfiguredProvider)
    expect(resolveShalomProvider({ SHALOM_PROVIDER: 'something_real' })).toBe(notConfiguredProvider)
    expect(resolveShalomProvider({ SHALOM_PROVIDER: 'fake', NODE_ENV: 'development' }).name).toBe('fake')
  })

  it('not_configured never answers (a typed failure the cron survives)', async () => {
    await expect(notConfiguredProvider.fetchTracking({ numero: '1', codigo: 'A' })).rejects.toMatchObject({ code: 'not_configured' })
  })

  it('the fake plays the scenario of the guide, else the default, else origin', async () => {
    expect(pickScenario({ default: 'transit', byNumber: { '12345678': 'delivered' } }, '12345678')).toBe('delivered')
    expect(pickScenario({ default: 'transit' }, '99999999')).toBe('transit')
    expect(pickScenario(null, '1')).toBe('origin')
    const p = createFakeProvider((n) => (n === '1' ? 'not_found' : 'origin'))
    expect((await p.fetchTracking({ numero: '1', codigo: 'A' })).httpStatus).toBe(404)
    expect((await p.fetchTracking({ numero: '2', codigo: 'A' })).httpStatus).toBe(200)
  })
})
