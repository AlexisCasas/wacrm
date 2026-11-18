// @vitest-environment node
/**
 * PR-05 · the tracking SERVICE + POLLER against the REAL local stack with the FAKE provider and an injectable clock (no Shalom, no network, no secrets).
 * Covers the whole poll loop (ticks, claim / lease, backoff, attention window, rate limit, credentials breaker, timeout), the actor-facing service
 * (register / correct / refresh / stop / acknowledge) and the reads (panel, list summary) under RLS. Skipped unless LOCAL_URL is set. LOCAL ONLY.
 *
 *   eval "$(npx supabase status -o env | sed 's/^/export /')"; LOCAL_URL=$API_URL LOCAL_ANON=$ANON_KEY LOCAL_SERVICE=$SERVICE_ROLE_KEY npx vitest run src/lib/orders/shalom/tracking.qa.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createWorld, QA_ENABLED, type QaActor, type QaWorld } from '@/lib/orders/logistics/test-support/qa-env'
import { readShalomConfig } from '@/lib/orders/shalom/config'
import { runShalomTick, type PollDeps } from '@/lib/orders/shalom/poller'
import { createFakeProvider, notConfiguredProvider } from '@/lib/orders/shalom/providers'
import { acknowledgeAlert, correctShipment, getShipmentPanel, getShipmentSummary, refreshShipment, registerShipment, stopShipment } from '@/lib/orders/shalom/service'
import { mkReadyOrder, setShipmentFlag } from '@/lib/orders/shalom/test-support/ready-order'
import { acquireQaLock, releaseQaLock } from '@/lib/orders/shalom/test-support/qa-lock'

let w: QaWorld
let n = 0
let clockMs = Date.parse('2026-12-01T15:00:00Z')
const now = () => new Date(clockMs)
const advance = (minutes: number) => { clockMs += minutes * 60_000 }
const scenarios = new Map<string, string>()
const CFG = readShalomConfig({
  SHALOM_CONFIG_JSON: JSON.stringify({ intervalMinutes: { at_origin: 10, in_transit: 10, at_destination: 60 }, backoffMinutes: [5, 10], attentionWindowHours: 24, timeoutMs: 40, batchSize: 50, refreshMinIntervalSeconds: 300 }),
})
const deps = (over: Partial<PollDeps> = {}): PollDeps => ({ provider: createFakeProvider((num) => scenarios.get(num) ?? 'origin'), cfg: CFG, now, ...over })
const tick = (over: Partial<PollDeps> = {}) => runShalomTick(w.admin, deps(over))

// The clock only moves FORWARD (the credentials breaker of an earlier test is expressed in the same clock). America/Lima = UTC-5, no DST.
const limaDay0 = (iso: string) => { const d = new Date(Date.parse(iso) - 5 * 3_600_000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + 5 * 3_600_000 }
const mkNum = () => String(30_000_000 + (n += 1))
async function shipment(label: string, scenario = 'origin') {
  const order = await mkReadyOrder(w, w.acc, `trk-${label}-${n}`)
  const num = mkNum()
  scenarios.set(num, scenario)
  const r = await registerShipment(w.ctxOf(w.logi, w.acc), w.admin, order, { numero: num, codigo: '7m99' }, now())
  expect(r).toMatchObject({ ok: true, status: 201 })
  return { order, num }
}
const row = async (order: string) => ((await w.admin.from('order_shipments').select('*').eq('order_id', order).single()).data ?? {}) as Record<string, unknown>
const pollRows = async (order: string) => ((await w.admin.from('order_shipment_polls').select('outcome, applied, trigger').eq('order_id', order).order('created_at')).data ?? []) as Array<{ outcome: string; applied: boolean; trigger: string }>
const ts = (v: unknown) => Date.parse(String(v))
const mine = (orders: string[]) => async () => (await w.admin.from('order_shipments').select('order_id, next_poll_at').in('order_id', orders)).data

vi.setConfig({ testTimeout: 40_000, hookTimeout: 120_000 })

describe.skipIf(!QA_ENABLED)('PR-05 tracking service + poller (fake provider, injectable clock)', () => {
  beforeAll(async () => {
    await acquireQaLock()
    w = await createWorld()
    await setShipmentFlag(w, w.acc, true)
    await setShipmentFlag(w, w.accForeign, true)
  }, 120_000)
  // Every test starts clean: shipments left by an earlier test answer "origin" (not a stale 429 / 401 scenario) and the breaker is closed.
  afterEach(async () => {
    scenarios.clear()
    await w.admin.from('order_shipment_settings').update({ credentials_paused_until: null, credentials_paused_reason: null }).in('account_id', [w.acc, w.accForeign])
  })
  afterAll(async () => {
    if (w) await w.dispose()
    releaseQaLock()
  }, 90_000)

  // ------------------------------------------------------------------------------------------------------------------ the loop
  it('ready_for_dispatch → registered → En origen → En tránsito → En destino → Entregado, one query per due time, then polling stops', async () => {
    const { order, num } = await shipment('flow')
    let r = await tick()
    expect(r).toMatchObject({ claimed: expect.any(Number), paused: null })
    expect(await row(order)).toMatchObject({ logistic_status: 'at_origin', tracking_state: 'active', consecutive_failures: 0 })
    expect(ts((await row(order)).next_poll_at)).toBe(clockMs + 10 * 60_000)
    // not due yet: not queried again
    advance(5)
    await tick()
    expect((await pollRows(order))).toHaveLength(1)
    scenarios.set(num, 'transit')
    advance(6)
    await tick()
    expect((await row(order)).logistic_status).toBe('in_transit')
    scenarios.set(num, `destination@${now().toISOString()}`)
    advance(11)
    await tick()
    expect(await row(order)).toMatchObject({ logistic_status: 'at_destination', destination_episode: 1, destination_entered_source: 'shalom' })
    expect(ts((await row(order)).next_poll_at)).toBe(clockMs + 60 * 60_000) // 12 h in production defaults, 60 min in this accelerated config
    scenarios.set(num, 'delivered')
    advance(61)
    r = await tick()
    expect(await row(order)).toMatchObject({ logistic_status: 'delivered', tracking_state: 'delivered', next_poll_at: null })
    const polls = (await pollRows(order)).length
    advance(24 * 60)
    await tick()
    expect((await pollRows(order)).length).toBe(polls) // delivered: never queried again
    const types = ((await w.admin.from('order_shipment_events').select('event_type').eq('order_id', order).order('created_at')).data ?? []).map((e) => (e as { event_type: string }).event_type)
    expect(types).toEqual(['shipment_registered', 'status_changed', 'status_changed', 'status_changed', 'status_changed', 'delivered'])
  })

  it('duplicate cron ticks do not query twice; two concurrent ticks never share a shipment', async () => {
    const made = await Promise.all([shipment('c1'), shipment('c2'), shipment('c3'), shipment('c4'), shipment('c5'), shipment('c6')])
    const orders = made.map((m) => m.order)
    const [a, b] = await Promise.all([tick(), tick()])
    const total = (await Promise.all(orders.map(async (o) => (await pollRows(o)).length))).reduce((x, y) => x + y, 0)
    expect(total).toBe(6) // each shipment queried exactly once
    expect(a.claimed + b.claimed).toBeGreaterThanOrEqual(6)
    expect(a.errors + b.errors).toBe(0)
    const again = await tick() // same instant: nothing is due any more
    expect(again.claimed).toBe(0)
    expect((await mine(orders)())?.every((r) => ts((r as { next_poll_at: string }).next_poll_at) > clockMs)).toBe(true)
  })

  // ------------------------------------------------------------------------------------------------------------------ errors
  it.each([
    ['not_found', 'not_found', 'order'], ['invalid', 'invalid_identifier', 'order'], ['degraded_order', 'degraded_order', 'order'],
    ['server_500', 'server_error', 'integration'], ['server_502', 'server_error', 'integration'], ['server_503', 'server_error', 'integration'], ['server_504', 'server_error', 'integration'],
    ['invalid_json', 'invalid_json', 'integration'], ['degraded_login', 'degraded_integration', 'integration'], ['timeout', 'timeout', 'integration'], ['hang', 'timeout', 'integration'],
  ])('%s → %s (%s error): recorded, backed off, the order keeps its state and WACRM is untouched', async (scenario, outcome, kind) => {
    const { order, num } = await shipment(`e-${scenario}`)
    await tick() // first a good answer
    scenarios.set(num, scenario)
    advance(11)
    const s = await tick()
    expect(s.errors).toBe(0)
    expect(await row(order)).toMatchObject({ logistic_status: 'at_origin', tracking_state: 'active', consecutive_failures: 1, last_error_kind: kind })
    expect((await pollRows(order)).at(-1)).toMatchObject({ outcome, applied: true })
    expect(ts((await row(order)).next_poll_at)).toBe(clockMs + 5 * 60_000) // backoff step 1 of the test config
    // it recovers on its own
    scenarios.set(num, 'transit')
    advance(6)
    await tick()
    expect(await row(order)).toMatchObject({ logistic_status: 'in_transit', consecutive_failures: 0, last_error_kind: null })
  })

  it('an unknown Shalom state does not advance the order and is shown as a technical exception', async () => {
    const { order, num } = await shipment('unknown')
    await tick()
    scenarios.set(num, 'unknown')
    advance(11)
    await tick()
    expect(await row(order)).toMatchObject({ logistic_status: 'at_origin', last_error_kind: 'exception', last_error_code: 'unknown_status', consecutive_failures: 0 })
    expect((await pollRows(order)).at(-1)).toMatchObject({ outcome: 'unknown_state' })
  })

  it('429 pauses the REST of the tick (claims handed back, no failure counted) and honours Retry-After', async () => {
    const a = await shipment('r1', 'rate_limited')
    const b = await shipment('r2')
    const c = await shipment('r3')
    advance(1)
    const s = await tick()
    expect(s.paused).toBe('rate_limited')
    const rows = await Promise.all([a, b, c].map((x) => row(x.order)))
    const limited = rows.filter((r) => r.last_error_kind === 'integration')
    expect(limited).toHaveLength(1) // only the one that was answered with 429
    expect(limited[0].last_error_code).toBe('rate_limited')
    expect(ts(limited[0].next_poll_at)).toBe(clockMs + 2_000) // Retry-After: 2 s (the fake's value), within [1, 900]
    // the others were never queried in this tick: no claim left behind, no failure counted
    for (const r of rows.filter((x) => x.last_error_kind === null)) expect(r).toMatchObject({ claim_token: null, consecutive_failures: 0 })
    expect(s.byOutcome.rate_limited).toBe(1)
  })

  it('401 / 403 / degraded auth are GLOBAL credentials failures: the breaker pauses every query, orders are not blamed, polling resumes after the pause', async () => {
    const a = await shipment('k1', 'credentials_401')
    const b = await shipment('k2')
    advance(1)
    const s = await tick()
    expect(s.paused).toBe('credentials')
    expect(await row(a.order)).toMatchObject({ consecutive_failures: 0, last_error_kind: 'credentials', tracking_state: 'active', logistic_status: null })
    const paused = (await w.admin.from('order_shipment_settings').select('credentials_paused_until').eq('account_id', w.acc).single()).data as { credentials_paused_until: string }
    expect(ts(paused.credentials_paused_until)).toBe(clockMs + CFG.credentialsPauseMinutes * 60_000)
    // while paused nothing is queried for anybody
    scenarios.set(a.num, 'origin')
    advance(5)
    expect((await tick()).claimed).toBe(0)
    advance(CFG.credentialsPauseMinutes + 1)
    const resumed = await tick()
    expect(resumed.claimed).toBeGreaterThanOrEqual(2)
    expect((await row(a.order)).logistic_status).toBe('at_origin')
    expect((await row(b.order)).logistic_status).toBe('at_origin')
    for (const scenario of ['credentials_403', 'degraded_auth']) {
      scenarios.set(a.num, scenario)
      advance(11)
      expect((await tick()).paused).toBe('credentials')
      advance(CFG.credentialsPauseMinutes + 1)
      scenarios.set(a.num, 'origin')
      await tick()
    }
    expect(await row(a.order)).toMatchObject({ consecutive_failures: 0 })
  })

  it('a guide not found is NOT marked permanently: it becomes requires_attention only after the window, keeps its history, and a person can re-arm it', async () => {
    const { order, num } = await shipment('404', 'not_found')
    await tick()
    expect(await row(order)).toMatchObject({ tracking_state: 'active', consecutive_failures: 1 })
    advance(6)
    await tick()
    expect(await row(order)).toMatchObject({ tracking_state: 'active', consecutive_failures: 2 }) // still inside the 24 h window
    advance(25 * 60)
    await tick()
    expect(await row(order)).toMatchObject({ tracking_state: 'requires_attention', next_poll_at: null })
    advance(24 * 60)
    expect((await pollRows(order)).length).toBe(3)
    expect(await tick()).toMatchObject({ claimed: expect.any(Number) })
    expect((await pollRows(order)).length).toBe(3) // paused until a person acts
    // the guide is right after all (Shalom had not registered it yet): a person refreshes
    scenarios.set(num, 'origin')
    const r = await refreshShipment(w.ctxOf(w.logi, w.acc), w.admin, order, deps())
    expect(r).toMatchObject({ ok: true, body: { queried: true, outcome: 'ok' } })
    expect(await row(order)).toMatchObject({ tracking_state: 'active', logistic_status: 'at_origin', consecutive_failures: 0 })
    expect((await pollRows(order)).at(-1)).toMatchObject({ trigger: 'manual', outcome: 'ok' })
  })

  it('not_configured never calls anything and never breaks the tick', async () => {
    const { order } = await shipment('nc')
    const s = await tick({ provider: notConfiguredProvider })
    expect(s.errors).toBe(0)
    expect(await row(order)).toMatchObject({ last_error_kind: 'integration', last_error_code: 'not_configured', logistic_status: null })
  })

  // ------------------------------------------------------------------------------------------------------------------ actor-facing service
  describe('service', () => {
    it('register: validates the guide, needs a ready order, normalizes the code, is idempotent; roles / flags enforced by the database', async () => {
      const order = await mkReadyOrder(w, w.acc, `svc-reg-${(n += 1)}`)
      const ctx = w.ctxOf(w.logi, w.acc)
      expect(await registerShipment(ctx, w.admin, order, { numero: '12', codigo: 'x' })).toMatchObject({ ok: false, status: 422, error: 'invalid_identifier' })
      expect(await registerShipment(ctx, w.admin, 'nope', { numero: '12345678', codigo: '7M99' })).toMatchObject({ ok: false, status: 400 })
      expect(await registerShipment(ctx, w.admin, order, { numero: '12345678', codigo: ' 7m99 ' })).toMatchObject({ ok: true, status: 201, body: { created: true, identifier_version: 1 } })
      expect(await registerShipment(ctx, w.admin, order, { numero: '12345678', codigo: '7M99' })).toMatchObject({ ok: true, status: 200, body: { created: false } })
      expect(await registerShipment(ctx, w.admin, order, { numero: '87654321', codigo: '7M99' })).toMatchObject({ ok: false, status: 409, error: 'already_registered' })
      const notReady = await w.mkOrder(w.acc, `svc-nr-${(n += 1)}`)
      expect(await registerShipment(ctx, w.admin, notReady, { numero: '12345678', codigo: '7M99' })).toMatchObject({ ok: false, status: 409, error: 'not_ready_for_dispatch' })
      const other = await mkReadyOrder(w, w.acc, `svc-reg2-${(n += 1)}`)
      for (const actor of [w.comm, w.viewer]) expect(await registerShipment(w.ctxOf(actor, w.acc), w.admin, other, { numero: '12345678', codigo: '7M99' })).toMatchObject({ ok: false, status: 404 })
      expect(await registerShipment(w.ctxOf(w.foreign, w.accForeign), w.admin, other, { numero: '12345678', codigo: '7M99' })).toMatchObject({ ok: false, status: 404 })
      await setShipmentFlag(w, w.acc, false)
      expect(await registerShipment(ctx, w.admin, other, { numero: '12345678', codigo: '7M99' })).toMatchObject({ ok: false, status: 403, error: 'feature_disabled' })
      await setShipmentFlag(w, w.acc, true)
      expect((await w.admin.from('order_shipments').select('id').eq('order_id', other)).data).toEqual([])
    })

    it('correct: bumps the version, restarts the tracking and an in-flight answer of the old guide is discarded; supervisor stop; delivered is locked', async () => {
      const { order, num } = await shipment('svc-corr', 'transit')
      await tick()
      expect((await row(order)).logistic_status).toBe('in_transit')
      const ctx = w.ctxOf(w.sup, w.acc)
      expect(await correctShipment(ctx, w.admin, order, { numero: 'abc', codigo: 'x' })).toMatchObject({ ok: false, status: 422 })
      expect(await correctShipment(ctx, w.admin, order, { numero: '99999999', codigo: 'zz11', expectedVersion: 7 })).toMatchObject({ ok: false, status: 409, error: 'stale' })
      expect(await correctShipment(ctx, w.admin, order, { numero: '99999999', codigo: 'zz11', expectedVersion: 1 }, now())).toMatchObject({ ok: true, body: { changed: true, identifier_version: 2 } })
      expect(await row(order)).toMatchObject({ tracking_number: '99999999', tracking_code: 'ZZ11', logistic_status: null, identifier_version: 2 })
      expect(scenarios.get(num)).toBe('transit') // the old guide's fake answer no longer applies: the new guide has its own scenario
      scenarios.set('99999999', 'origin')
      advance(1)
      await tick()
      expect((await row(order)).logistic_status).toBe('at_origin')
      // a viewer / commercial / logistics-only cannot stop; the supervisor can
      for (const actor of [w.comm, w.viewer, w.logi]) expect(await stopShipment(w.ctxOf(actor, w.acc), w.admin, order, 'manual')).toMatchObject({ ok: false, status: 404 })
      expect(await stopShipment(ctx, w.admin, order, 'order_cancelled', now())).toMatchObject({ ok: true, body: { changed: true } })
      expect(await row(order)).toMatchObject({ tracking_state: 'stopped', stop_reason: 'order_cancelled', next_poll_at: null })
      expect(await correctShipment(ctx, w.admin, order, { numero: '55555555', codigo: 'AAAA' })).toMatchObject({ ok: false, status: 409, error: 'stopped' })
      advance(24 * 60)
      const before = (await pollRows(order)).length
      await tick()
      expect((await pollRows(order)).length).toBe(before)
    })

    it('forced refresh is rate limited per order (429 with retry_after_seconds) and denied to non-operators', async () => {
      const { order } = await shipment('svc-refresh')
      await tick()
      const ctx = w.ctxOf(w.logi, w.acc)
      advance(1)
      expect(await refreshShipment(ctx, w.admin, order, deps())).toMatchObject({ ok: true, body: { queried: true } })
      advance(1)
      const limited = await refreshShipment(ctx, w.admin, order, deps())
      expect(limited).toMatchObject({ ok: false, status: 429, error: 'rate_limited' })
      expect((limited as { extra?: { retry_after_seconds?: number } }).extra?.retry_after_seconds).toBeGreaterThan(0)
      advance(5)
      expect(await refreshShipment(w.ctxOf(w.sup, w.acc), w.admin, order, deps())).toMatchObject({ ok: true })
      for (const actor of [w.comm, w.viewer]) expect(await refreshShipment(w.ctxOf(actor, w.acc), w.admin, order, deps())).toMatchObject({ ok: false, status: 404 })
      // the order of another account is invisible
      expect(await refreshShipment(w.ctxOf(w.foreign, w.accForeign), w.admin, order, deps())).toMatchObject({ ok: false, status: 404 })
    })

    it('the panel and the list summary: operators read under RLS; everybody else gets nothing; the claim token is never exposed', async () => {
      const { order } = await shipment('svc-read')
      await tick()
      const op = await getShipmentPanel(w.ctxOf(w.logi, w.acc), order, false)
      expect(op).toMatchObject({ ok: true, body: { eligible: true, can_stop: false, shipment: { logistic_status: 'at_origin', tracking_state: 'active' } } })
      if (op.ok) {
        expect(op.body.events.length).toBeGreaterThan(0)
        expect(op.body.polls.length).toBeGreaterThan(0)
        expect(JSON.stringify(op.body)).not.toMatch(/claim_token|lease_until/)
      }
      expect(await getShipmentPanel(w.ctxOf(w.sup, w.acc), order, true)).toMatchObject({ ok: true, body: { can_stop: true } })
      for (const actor of [w.comm, w.viewer]) expect(await getShipmentPanel(w.ctxOf(actor, w.acc), order, false)).toMatchObject({ ok: false, status: 404 })
      expect(await getShipmentPanel(w.ctxOf(w.foreign, w.accForeign), order, false)).toMatchObject({ ok: false, status: 404 })
      const notShipped = await mkReadyOrder(w, w.acc, `svc-ns-${(n += 1)}`)
      expect(await getShipmentPanel(w.ctxOf(w.logi, w.acc), notShipped, false)).toMatchObject({ ok: true, body: { eligible: true, shipment: null } })
      expect(await getShipmentSummary(w.ctxOf(w.logi, w.acc), [order, notShipped])).toMatchObject({ ok: true, body: { summaries: { [order]: { logistic_status: 'at_origin', alert_open: false } } } })
      const s = await getShipmentSummary(w.ctxOf(w.logi, w.acc), [order, notShipped])
      expect(s.ok && Object.keys(s.body.summaries)).toEqual([order])
      expect(await getShipmentSummary(w.ctxOf(w.logi, w.acc), [])).toMatchObject({ ok: false, status: 400 })
      expect(await getShipmentSummary(w.ctxOf(w.comm, w.acc), [order])).toMatchObject({ ok: false, status: 404 })
      // another account asking for these ids sees no shipments
      const foreign = await getShipmentSummary(w.ctxOf(w.foreign, w.accForeign), [order])
      expect(foreign).toMatchObject({ ok: true, body: { summaries: {} } })
    })
  })

  // ------------------------------------------------------------------------------------------------------------------ alert through the poller
  describe('15-day alert through the cron tick', () => {
    const at = async (label: string, arrival: string) => {
      const s = await shipment(label, `destination@${arrival}`)
      await tick()
      expect((await row(s.order)).logistic_status).toBe('at_destination')
      return s
    }
    const alerts = async (order: string) => ((await w.admin.from('order_shipment_alerts').select('id, status, destination_episode, resolved_reason').eq('order_id', order)).data ?? []) as Array<{ id: string; status: string; resolved_reason: string | null }>

    it('day 14: none. Day 15: ONE alert + notifications for Logistics/Supervisor; repeated ticks never duplicate; tracking keeps going; acknowledge; delivered resolves it', async () => {
      const arrival = new Date(clockMs - 86_400_000).toISOString() // Shalom says it reached destination yesterday
      const { order, num } = await at('alert', arrival)
      const day15 = limaDay0(arrival) + 15 * 86_400_000 // 00:00 Lima of calendar day 15
      clockMs = day15 - 60_000 // 23:59 Lima of day 14
      await tick()
      expect(await alerts(order)).toEqual([])
      clockMs = day15 // 00:00 Lima of day 15
      const t = await tick()
      expect(t.alertsCreated).toBeGreaterThanOrEqual(1)
      expect(await alerts(order)).toHaveLength(1)
      for (let i = 0; i < 3; i += 1) { advance(15); await tick() }
      expect(await alerts(order)).toHaveLength(1)
      expect((await row(order)).tracking_state).toBe('active') // the alert does not stop the tracking
      const { data: notifs } = await w.admin.from('notifications').select('user_id, type').eq('order_id', order)
      const users = new Set((notifs ?? []).map((x) => (x as { user_id: string }).user_id))
      expect([w.logi.id, w.logi2.id, w.sup.id].every((id) => users.has(id))).toBe(true)
      expect([w.comm.id, w.viewer.id, w.foreign.id].some((id) => users.has(id))).toBe(false)
      const [alert] = await alerts(order)
      expect(await acknowledgeAlert(w.ctxOf(w.comm, w.acc), w.admin, alert.id)).toMatchObject({ ok: false, status: 404 })
      expect(await acknowledgeAlert(w.ctxOf(w.logi, w.acc), w.admin, alert.id, now())).toMatchObject({ ok: true, body: { changed: true } })
      expect(await acknowledgeAlert(w.ctxOf(w.logi, w.acc), w.admin, 'nope')).toMatchObject({ ok: false, status: 400 })
      // Shalom finally says delivered: the alert is resolved (history kept) and the polling ends
      scenarios.set(num, 'delivered')
      advance(24 * 60)
      await tick()
      expect(await alerts(order)).toEqual([{ id: alert.id, status: 'resolved', destination_episode: 1, resolved_reason: 'delivered' }])
      expect((await row(order)).tracking_state).toBe('delivered')
    })

    it('when Shalom is down the alert clock still runs', async () => {
      const arrival = now().toISOString()
      const { order, num } = await at('down', arrival)
      scenarios.set(num, 'server_503')
      clockMs = limaDay0(arrival) + 15 * 86_400_000 + 3_600_000
      const t = await tick()
      expect(t.byOutcome.server_error).toBeGreaterThanOrEqual(1)
      expect(await alerts(order)).toHaveLength(1)
    })
  })
})

// Types are referenced above only to keep the helper signatures honest
export type { QaActor }
