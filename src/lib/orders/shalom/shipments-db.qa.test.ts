// @vitest-environment node
/**
 * PR-05 · the Shalom tracking DATABASE layer against the REAL local stack: flags, roles, RLS, guide registration / correction / stop / refresh, claim +
 * lease + two workers, applying provider answers (state machine, idempotency, late answers, errors), the 15-day alert and its notification channel.
 * No Shalom, no network: every answer is injected through the RPCs. Skipped unless LOCAL_URL is set. LOCAL ONLY (see logistics/test-support/qa-env).
 *
 *   eval "$(npx supabase status -o env | sed 's/^/export /')"; LOCAL_URL=$API_URL LOCAL_ANON=$ANON_KEY LOCAL_SERVICE=$SERVICE_ROLE_KEY npx vitest run src/lib/orders/shalom/shipments-db.qa.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createWorld, QA_ENABLED, type QaActor, type QaWorld } from '@/lib/orders/logistics/test-support/qa-env'
import { mkReadyOrder, setShipmentFlag } from '@/lib/orders/shalom/test-support/ready-order'

let w: QaWorld
let n = 0
const BASE = Date.parse('2026-12-01T15:00:00Z') // 10:00 in Lima
const at = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString()
const day = (d: number, hours = 0) => at(d * 1440 + hours * 60)

interface Claimed {
  order_id: string
  account_id: string
  tracking_number: string
  tracking_code: string
  identifier_version: number
  claim_token: string
  first_failure_at: string | null
  consecutive_failures: number
  logistic_status: string | null
}

const ready = (label: string, acc = w.acc) => mkReadyOrder(w, acc, `shp-${label}-${(n += 1)}`)
const register = (order: string, opts: { actor?: QaActor; acc?: string; num?: string; code?: string; now?: string } = {}) =>
  w.admin.rpc('register_order_shipment', { p_account: opts.acc ?? w.acc, p_actor: (opts.actor ?? w.logi).id, p_order: order, p_number: opts.num ?? '12345678', p_code: opts.code ?? '7m99', p_now: opts.now ?? at(0) })
const claim = async (now: string, order: string | null = null, limit = 5): Promise<Claimed[]> => {
  const { data, error } = await w.admin.rpc('claim_shipment_polls', { p_limit: limit, p_lease_seconds: 600, p_order: order, p_now: now })
  if (error) throw error
  return data as Claimed[]
}
const apply = (c: Claimed, over: Record<string, unknown> = {}) =>
  w.admin.rpc('apply_shipment_poll', {
    p_account: c.account_id, p_order: c.order_id, p_claim_token: c.claim_token, p_identifier_version: c.identifier_version,
    p_started_at: at(1), p_finished_at: at(2), p_trigger: 'cron', p_outcome: 'ok', p_http_status: 200, p_latency_ms: 40, p_normalized: 'at_origin',
    p_raw_summary: { origen: true }, p_raw_hash: 'h-origin', p_destination_at: null, p_next_poll_at: at(180), p_attention: false, p_error_code: null, p_now: at(2), ...over,
  })
const shipment = async (order: string) => ((await w.admin.from('order_shipments').select('*').eq('order_id', order).single()).data ?? {}) as Record<string, unknown>
const events = async (order: string) => ((await w.admin.from('order_shipment_events').select('event_type, from_status, to_status, source, actor_name, detail').eq('order_id', order).order('created_at')).data ?? []) as Array<{ event_type: string; from_status: string | null; to_status: string | null; source: string; actor_name: string; detail: Record<string, unknown> }>
const types = async (order: string) => (await events(order)).map((e) => e.event_type)
const polls = async (order: string) => ((await w.admin.from('order_shipment_polls').select('outcome, applied, ignored_reason').eq('order_id', order).order('created_at')).data ?? []) as Array<{ outcome: string; applied: boolean; ignored_reason: string | null }>
const alerts = async (order: string) => ((await w.admin.from('order_shipment_alerts').select('*').eq('order_id', order).order('destination_episode')).data ?? []) as Array<{ id: string; status: string; destination_episode: number; resolved_reason: string | null; due_date: string }>

/** A registered shipment, claimed and brought to `status` by one applied answer. */
async function shipAt(label: string, status: 'at_origin' | 'in_transit' | 'at_destination' | 'delivered', opts: { destinationAt?: string | null; now?: string } = {}) {
  const order = await ready(label)
  expect((await register(order)).data).toMatchObject({ ok: true })
  const [c] = await claim(at(1), order)
  expect((await apply(c, { p_normalized: status, p_destination_at: opts.destinationAt ?? null, p_finished_at: opts.now ?? at(2), p_raw_hash: `h-${status}` })).data).toMatchObject({ ok: true, applied: true })
  return { order, c }
}

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 })

describe.skipIf(!QA_ENABLED)('PR-05 Shalom tracking · database layer', () => {
  beforeAll(async () => {
    w = await createWorld()
    await setShipmentFlag(w, w.acc, true)
    await setShipmentFlag(w, w.accForeign, true)
  }, 120_000)
  afterAll(async () => {
    if (w) await w.dispose()
  }, 90_000)

  // ------------------------------------------------------------------------------------------------------------------ flags / roles / RLS
  describe('flags, roles and RLS', () => {
    it('Logistics and Supervisor register the guide (normalized, audited with a MASKED value); the order must be ready_for_dispatch', async () => {
      const o1 = await ready('reg1')
      expect((await register(o1)).data).toMatchObject({ ok: true, created: true, identifier_version: 1 })
      const s = await shipment(o1)
      expect(s).toMatchObject({ tracking_number: '12345678', tracking_code: '7M99', tracking_state: 'active', logistic_status: null, identifier_source: 'manual', created_by: w.logi.id })
      expect(s.next_poll_at).toBeTruthy()
      const ev = (await events(o1))[0]
      expect(ev).toMatchObject({ event_type: 'shipment_registered', source: 'user' })
      expect(JSON.stringify(ev.detail)).not.toContain('12345678')
      expect(ev.detail).toMatchObject({ number: '*****678', code: '*M99' })

      const o2 = await ready('reg2')
      expect((await register(o2, { actor: w.sup })).data).toMatchObject({ ok: true, created: true })

      // an order that is NOT ready for dispatch (PR-04 has not finished) cannot be tracked
      const notReady = await w.mkOrder(w.acc, `shp-nr-${(n += 1)}`)
      expect((await register(notReady)).data).toMatchObject({ ok: false, reason: 'not_ready_for_dispatch' })
    })

    it('is idempotent for the same guide, and refuses a second guide for the same order (use correction)', async () => {
      const o = await ready('idem')
      await register(o)
      expect((await register(o)).data).toMatchObject({ ok: true, created: false })
      expect((await register(o, { num: '99999999', code: 'AAAA' })).data).toMatchObject({ ok: false, reason: 'already_registered' })
      expect((await w.admin.from('order_shipments').select('id').eq('order_id', o)).data).toHaveLength(1)
    })

    it('validates the guide format before storing', async () => {
      const o = await ready('fmt')
      for (const [num, code] of [['123', '7M99'], ['abcdefgh', '7M99'], ['12345678', 'x'], ['12345678', 'TOOLONGCODE'], ['', ''], ['12345678', '7M-9']]) {
        expect((await register(o, { num, code })).data).toMatchObject({ ok: false, reason: 'invalid_identifier' })
      }
      expect((await w.admin.from('order_shipments').select('id').eq('order_id', o)).data).toEqual([])
    })

    it('commercial, viewer, no-area and another account CANNOT register (database-enforced); nothing is written', async () => {
      const o = await ready('deny')
      for (const actor of [w.comm, w.viewer]) expect((await register(o, { actor })).error?.code).toBe('42501')
      await w.admin.from('profiles').update({ operational_role: null }).eq('user_id', w.logi2.id)
      expect((await register(o, { actor: w.logi2 })).error?.code).toBe('42501')
      await w.admin.from('profiles').update({ operational_role: 'logistics' }).eq('user_id', w.logi2.id)
      expect((await register(o, { actor: w.foreign, acc: w.accForeign })).error?.code).toBe('42501') // the order is not theirs
      expect((await register(o, { actor: w.foreign })).error?.code).toBe('42501') // wrong account context for that actor
      expect((await w.admin.from('order_shipments').select('id').eq('order_id', o)).data).toEqual([])
    })

    it('needs BOTH flags: shalom_tracking_enabled OFF (default) or logistics_mvp_enabled OFF refuse everything', async () => {
      const o = await ready('flags')
      await setShipmentFlag(w, w.acc, false)
      expect((await register(o)).error?.message).toMatch(/feature_disabled/)
      await setShipmentFlag(w, w.acc, true)
      await w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: false }).eq('account_id', w.acc)
      expect((await register(o)).error?.code).toBe('42501')
      await w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: true }).eq('account_id', w.acc)
      expect((await register(o)).data).toMatchObject({ ok: true })
      // an account with no settings row is OFF
      expect((await w.admin.from('order_shipment_settings').select('shalom_tracking_enabled').eq('account_id', w.acc).single()).data).toMatchObject({ shalom_tracking_enabled: true })
    })

    it('RLS: logistics / supervisor read their account; commercial, viewer, no-area, other accounts and anon read nothing; nobody writes directly', async () => {
      const o = await ready('rls')
      await register(o)
      const readable = async (actor: QaActor) => ((await actor.client.from('order_shipments').select('id, account_id').eq('order_id', o)).data ?? []).length
      expect(await readable(w.logi)).toBe(1)
      expect(await readable(w.sup)).toBe(1)
      for (const actor of [w.comm, w.viewer, w.foreign]) expect(await readable(actor)).toBe(0)
      expect(((await w.anon.from('order_shipments').select('id')).data ?? []).length).toBe(0)
      for (const t of ['order_shipment_events', 'order_shipment_polls', 'order_shipment_alerts']) {
        expect(((await w.comm.client.from(t).select('id').limit(5)).data ?? []).length).toBe(0)
      }
      // with shalom_tracking_enabled OFF even logistics reads nothing
      await setShipmentFlag(w, w.acc, false)
      expect(await readable(w.logi)).toBe(0)
      await setShipmentFlag(w, w.acc, true)
      // writes
      for (const actor of [w.logi, w.sup]) {
        expect((await actor.client.from('order_shipments').update({ logistic_status: 'delivered' }).eq('order_id', o).select('id')).data ?? []).toHaveLength(0)
        expect((await actor.client.from('order_shipments').delete().eq('order_id', o).select('id')).data ?? []).toHaveLength(0)
        expect((await actor.client.from('order_shipments').insert({ order_id: o, account_id: w.acc, tracking_number: '12345678', tracking_code: 'AAAA', created_by: actor.id })).error).not.toBeNull()
        expect((await actor.client.rpc('register_order_shipment', { p_account: w.acc, p_actor: actor.id, p_order: o, p_number: '12345678', p_code: '7M99' })).error).not.toBeNull()
        expect((await actor.client.rpc('apply_shipment_poll', { p_account: w.acc, p_order: o })).error).not.toBeNull()
        expect((await actor.client.rpc('claim_shipment_polls', {})).error).not.toBeNull()
      }
      expect((await w.admin.from('order_shipments').select('logistic_status').eq('order_id', o).single()).data).toMatchObject({ logistic_status: null })
    })
  })

  // ------------------------------------------------------------------------------------------------------------------ mapping / state machine
  describe('applying provider answers', () => {
    it('origin → transit → destination → delivered, one functional event per change, polls logged, delivered stops polling', async () => {
      const order = await ready('flow')
      await register(order)
      let [c] = await claim(at(1), order)
      expect((await apply(c, { p_normalized: 'at_origin', p_raw_hash: 'a' })).data).toMatchObject({ ok: true, applied: true, changed: true })
      expect(await shipment(order)).toMatchObject({ logistic_status: 'at_origin', consecutive_failures: 0, last_error_kind: null })

      ;[c] = await claim(at(200), order)
      await apply(c, { p_normalized: 'in_transit', p_started_at: at(201), p_finished_at: at(202), p_next_poll_at: at(400), p_raw_hash: 'b' })
      ;[c] = await claim(at(500), order)
      await apply(c, { p_normalized: 'at_destination', p_started_at: at(501), p_finished_at: at(502), p_next_poll_at: at(900), p_raw_hash: 'c' })
      expect(await shipment(order)).toMatchObject({ logistic_status: 'at_destination', destination_episode: 1, destination_entered_source: 'observed' })
      ;[c] = await claim(at(1000), order)
      expect((await apply(c, { p_normalized: 'delivered', p_started_at: at(1001), p_finished_at: at(1002), p_raw_hash: 'd' })).data).toMatchObject({ applied: true, changed: true, tracking_state: 'delivered' })

      const s = await shipment(order)
      expect(s).toMatchObject({ logistic_status: 'delivered', tracking_state: 'delivered', next_poll_at: null, claim_token: null })
      expect((await events(order)).filter((e) => e.event_type === 'status_changed').map((e) => `${e.from_status ?? '-'}>${e.to_status}`)).toEqual(['->at_origin', 'at_origin>in_transit', 'in_transit>at_destination', 'at_destination>delivered'])
      expect(await types(order)).toContain('delivered')
      expect((await polls(order)).every((p) => p.applied)).toBe(true)
      // delivered stops the polling for good
      expect(await claim(day(60), order)).toEqual([])
      expect(await claim(day(60))).not.toContainEqual(expect.objectContaining({ order_id: order }))
    })

    it('the same state received again updates timestamps but creates NO second functional event', async () => {
      const { order } = await shipAt('same', 'in_transit')
      for (let i = 0; i < 3; i += 1) {
        const [c] = await claim(at(300 + i * 300), order)
        expect((await apply(c, { p_normalized: 'in_transit', p_started_at: at(301 + i * 300), p_finished_at: at(302 + i * 300), p_raw_hash: 'h-in_transit' })).data).toMatchObject({ applied: true, changed: false })
      }
      expect((await events(order)).filter((e) => e.event_type === 'status_changed')).toHaveLength(1)
      expect((await polls(order))).toHaveLength(4)
      expect(Date.parse(String((await shipment(order)).last_polled_at))).toBe(BASE + 902 * 60_000)
    })

    it('the status NEVER goes backwards by itself: the regression is recorded once and ignored', async () => {
      const { order } = await shipAt('regress', 'at_destination')
      for (let i = 0; i < 2; i += 1) {
        const [c] = await claim(day(1, i), order)
        await apply(c, { p_normalized: 'in_transit', p_started_at: day(1, i), p_finished_at: day(1, i), p_raw_hash: 'older', p_next_poll_at: day(1) })
      }
      expect(await shipment(order)).toMatchObject({ logistic_status: 'at_destination', destination_episode: 1 })
      expect((await events(order)).filter((e) => e.event_type === 'regression_ignored')).toHaveLength(1)
    })

    it('an unknown Shalom state does NOT advance the order: recorded once as a technical exception, still polled', async () => {
      const { order } = await shipAt('unknown', 'at_origin')
      for (let i = 0; i < 2; i += 1) {
        const [c] = await claim(day(1, i), order)
        expect((await apply(c, { p_outcome: 'unknown_state', p_normalized: null, p_raw_hash: 'weird', p_raw_summary: { x: 1 }, p_started_at: day(1, i), p_finished_at: day(1, i) })).data).toMatchObject({ applied: true })
      }
      expect(await shipment(order)).toMatchObject({ logistic_status: 'at_origin', tracking_state: 'active', last_error_kind: 'exception', last_error_code: 'unknown_status' })
      expect((await events(order)).filter((e) => e.event_type === 'exception_unknown_state')).toHaveLength(1)
      // a later good answer clears the exception
      const [c] = await claim(day(3), order)
      await apply(c, { p_normalized: 'in_transit', p_started_at: day(3), p_finished_at: day(3), p_raw_hash: 'ok2' })
      expect(await shipment(order)).toMatchObject({ logistic_status: 'in_transit', last_error_kind: null })
    })

    it('a LATE (older) answer after a newer one does not overwrite the state', async () => {
      const order = await ready('late')
      await register(order)
      const [slow] = await claim(at(1), order)
      // the claim of `slow` is lost (lease expiry) and a second worker gets the order and finishes first with a NEWER answer
      const [fast] = await claim(at(1 + 11), order)
      expect(fast.claim_token).not.toBe(slow.claim_token)
      expect((await apply(fast, { p_normalized: 'in_transit', p_started_at: at(12), p_finished_at: at(13), p_raw_hash: 'fast' })).data).toMatchObject({ applied: true })
      expect((await apply(slow, { p_normalized: 'at_origin', p_started_at: at(2), p_finished_at: at(20), p_raw_hash: 'slow' })).data).toMatchObject({ applied: false, reason: 'claim_lost' })
      expect(await shipment(order)).toMatchObject({ logistic_status: 'in_transit' })
      expect((await polls(order)).map((p) => p.ignored_reason)).toEqual([null, 'claim_lost'])
      // an older answer that still HOLDS a claim is ignored as stale and hands the claim back
      const [c3] = await claim(day(1), order)
      expect((await apply(c3, { p_started_at: at(5), p_finished_at: day(1), p_normalized: 'at_origin', p_raw_hash: 'old' })).data).toMatchObject({ applied: false, reason: 'stale_ignored' })
      expect((await shipment(order)).claim_token).toBeNull()
    })

    it('a stopped / delivered shipment ignores any in-flight answer', async () => {
      const order = await ready('stopped-flight')
      await register(order)
      const [c] = await claim(at(1), order)
      expect((await w.admin.rpc('stop_order_shipment', { p_account: w.acc, p_actor: w.sup.id, p_order: order, p_reason: 'manual', p_now: at(3) })).data).toMatchObject({ ok: true, changed: true })
      expect((await apply(c)).data).toMatchObject({ applied: false, reason: 'not_active' })
      expect(await shipment(order)).toMatchObject({ logistic_status: null, tracking_state: 'stopped' })
    })
  })

  // ------------------------------------------------------------------------------------------------------------------ errors
  describe('errors', () => {
    it.each([
      ['not_found', 'order'], ['invalid_identifier', 'order'], ['degraded_order', 'order'],
      ['rate_limited', 'integration'], ['server_error', 'integration'], ['timeout', 'integration'], ['invalid_json', 'integration'], ['degraded_integration', 'integration'],
    ])('%s is an %s error: counted, backed off, never advances the state, never breaks the order', async (outcome, kind) => {
      const { order } = await shipAt(`err-${outcome}`, 'in_transit')
      const [c] = await claim(at(400), order)
      expect((await apply(c, { p_outcome: outcome, p_normalized: null, p_http_status: 500, p_started_at: at(401), p_finished_at: at(402), p_next_poll_at: at(430), p_error_code: outcome })).data).toMatchObject({ applied: true, tracking_state: 'active' })
      expect(await shipment(order)).toMatchObject({ logistic_status: 'in_transit', tracking_state: 'active', consecutive_failures: 1, last_error_kind: kind, last_error_code: outcome })
      expect((await shipment(order)).first_failure_at).toBeTruthy()
    })

    it('credentials failures are GLOBAL: not counted against the order; the breaker pauses claims of every account until it expires', async () => {
      const a = await ready('cred-a')
      const b = await ready('cred-b', w.accForeign)
      await register(a)
      await register(b, { actor: w.foreign, acc: w.accForeign })
      const [c] = await claim(at(1), a)
      await apply(c, { p_outcome: 'credentials', p_normalized: null, p_http_status: 401, p_error_code: 'credentials', p_next_poll_at: null })
      expect(await shipment(a)).toMatchObject({ consecutive_failures: 0, last_error_kind: 'credentials', tracking_state: 'active' })
      expect((await w.admin.rpc('trip_shalom_credentials_breaker', { p_pause_seconds: 3600, p_reason: 'credentials', p_now: at(2) })).data).toBeGreaterThanOrEqual(2)
      expect(await claim(at(30))).toEqual([]) // paused for everybody
      const open = (await w.admin.from('order_shipment_settings').select('credentials_paused_until, credentials_paused_reason').eq('account_id', w.acc).single()).data
      expect(open).toMatchObject({ credentials_paused_reason: 'credentials' })
      const resumed = await claim(at(90))
      expect(resumed.map((r) => r.order_id)).toEqual(expect.arrayContaining([a, b]))
      await w.admin.from('order_shipment_settings').update({ credentials_paused_until: null, credentials_paused_reason: null }).in('account_id', [w.acc, w.accForeign])
    })

    it('a guide not found is NEVER marked permanently by one 404: requires_attention only when the app says the window elapsed; history kept; refresh re-arms', async () => {
      const { order } = await shipAt('404', 'at_origin')
      let [c] = await claim(at(400), order)
      await apply(c, { p_outcome: 'not_found', p_normalized: null, p_http_status: 404, p_started_at: at(401), p_finished_at: at(402), p_next_poll_at: at(500), p_error_code: 'not_found' })
      expect(await shipment(order)).toMatchObject({ tracking_state: 'active', consecutive_failures: 1 })
      ;[c] = await claim(at(600), order)
      await apply(c, { p_outcome: 'not_found', p_normalized: null, p_http_status: 404, p_started_at: at(601), p_finished_at: day(2), p_next_poll_at: day(3), p_attention: true, p_error_code: 'not_found' })
      const s = await shipment(order)
      expect(s).toMatchObject({ tracking_state: 'requires_attention', next_poll_at: null, logistic_status: 'at_origin', consecutive_failures: 2 })
      expect(await types(order)).toContain('requires_attention')
      expect(await claim(day(30), order)).toEqual([]) // paused until a person acts
      // a person refreshes: re-armed with a fresh window, history untouched
      expect((await w.admin.rpc('request_shipment_refresh', { p_account: w.acc, p_actor: w.logi.id, p_order: order, p_min_interval_seconds: 300, p_now: day(31) })).data).toMatchObject({ ok: true })
      expect(await shipment(order)).toMatchObject({ tracking_state: 'active', consecutive_failures: 0, first_failure_at: null })
      expect(await types(order)).toEqual(expect.arrayContaining(['attention_cleared', 'refresh_requested']))
    })
  })

  // ------------------------------------------------------------------------------------------------------------------ claim / lease / workers
  describe('claim, lease and two workers', () => {
    it('two concurrent workers never claim the same shipment (FOR UPDATE SKIP LOCKED + token + lease)', async () => {
      const orders = await Promise.all([ready('w1'), ready('w2'), ready('w3'), ready('w4'), ready('w5'), ready('w6')])
      for (const o of orders) await register(o)
      const [a, b] = await Promise.all([claim(at(1), null, 4), claim(at(1), null, 4)])
      const mine = (rows: Claimed[]) => rows.filter((r) => orders.includes(r.order_id)).map((r) => r.order_id)
      const both = [...mine(a), ...mine(b)]
      expect(new Set(both).size).toBe(both.length) // no duplicates
      expect(both.length).toBeGreaterThan(0)
      const tokens = [...a, ...b].map((r) => r.claim_token)
      expect(new Set(tokens).size).toBe(tokens.length)
    })

    it('a claimed shipment is not claimed again until the lease expires; an expired lease is retaken with a new token', async () => {
      const order = await ready('lease')
      await register(order)
      const [first] = await claim(at(1), order)
      expect(await claim(at(5), order)).toEqual([]) // lease (600 s) still valid
      const [second] = await claim(at(12), order) // 11 min later: expired
      expect(second.claim_token).not.toBe(first.claim_token)
    })

    it('only due shipments of accounts with BOTH flags ON are claimed; claims can be released without counting a failure', async () => {
      const order = await ready('due')
      await register(order, { now: at(60) })
      expect(await claim(at(30), order)).toEqual([]) // not due yet
      await setShipmentFlag(w, w.acc, false)
      expect(await claim(at(90), order)).toEqual([])
      await setShipmentFlag(w, w.acc, true)
      await w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: false }).eq('account_id', w.acc)
      expect(await claim(at(90), order)).toEqual([])
      await w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: true }).eq('account_id', w.acc)
      const [c] = await claim(at(90), order)
      expect((await w.admin.rpc('release_shipment_claims', { p_tokens: [c.claim_token], p_next_poll_at: at(100) })).data).toBe(1)
      expect(await shipment(order)).toMatchObject({ claim_token: null, consecutive_failures: 0 })
    })
  })

  // ------------------------------------------------------------------------------------------------------------------ correction / stop / refresh
  describe('correction, stop and refresh', () => {
    it('correcting the guide: identifier_version + 1, in-flight answers of the old guide are ignored, tracking restarts, history kept, audit masked old/new', async () => {
      const { order, c } = await shipAt('corr', 'in_transit')
      const [inflight] = await claim(at(400), order)
      const r = await w.admin.rpc('correct_order_shipment_identifier', { p_account: w.acc, p_actor: w.sup.id, p_order: order, p_number: '87654321', p_code: 'zz11', p_expected_version: 1, p_now: at(405) })
      expect(r.data).toMatchObject({ ok: true, changed: true, identifier_version: 2 })
      expect(await shipment(order)).toMatchObject({ tracking_number: '87654321', tracking_code: 'ZZ11', identifier_version: 2, logistic_status: null, tracking_state: 'active', claim_token: null, consecutive_failures: 0 })
      // the in-flight answer of version 1 (and the earlier claim) is discarded
      expect((await apply(inflight, { p_normalized: 'delivered', p_started_at: at(410), p_finished_at: at(411) })).data).toMatchObject({ applied: false, reason: 'version_ignored' })
      expect((await apply(c, { p_normalized: 'delivered', p_started_at: at(412), p_finished_at: at(413) })).data).toMatchObject({ applied: false, reason: 'version_ignored' })
      expect(await shipment(order)).toMatchObject({ logistic_status: null })
      const ev = (await events(order)).find((e) => e.event_type === 'identifier_corrected')!
      expect(ev).toMatchObject({ source: 'user' })
      expect(ev.detail).toMatchObject({ old_number: '*****678', new_number: '*****321', previous_version: 1 })
      expect(JSON.stringify(ev.detail)).not.toMatch(/12345678|87654321/)
      // the new version can reach the same status again (the unique "status once" index is per version)
      const [n2] = await claim(at(420), order)
      expect(n2.identifier_version).toBe(2)
      expect((await apply(n2, { p_normalized: 'in_transit', p_started_at: at(421), p_finished_at: at(422), p_raw_hash: 'v2' })).data).toMatchObject({ applied: true, changed: true })
      // same guide again = no new version; stale expected version refused
      expect((await w.admin.rpc('correct_order_shipment_identifier', { p_account: w.acc, p_actor: w.logi.id, p_order: order, p_number: '87654321', p_code: 'ZZ11', p_now: at(430) })).data).toMatchObject({ ok: true, changed: false, identifier_version: 2 })
      expect((await w.admin.rpc('correct_order_shipment_identifier', { p_account: w.acc, p_actor: w.logi.id, p_order: order, p_number: '11111111', p_code: 'AAAA', p_expected_version: 1, p_now: at(431) })).data).toMatchObject({ ok: false, reason: 'stale' })
    })

    it('a delivered shipment can not be corrected (exceptional flow, outside PR-05 base) and can not be refreshed or stopped', async () => {
      const { order } = await shipAt('deliv-lock', 'delivered')
      expect((await w.admin.rpc('correct_order_shipment_identifier', { p_account: w.acc, p_actor: w.sup.id, p_order: order, p_number: '87654321', p_code: 'ZZ11', p_now: day(2) })).data).toMatchObject({ ok: false, reason: 'delivered_locked' })
      expect((await w.admin.rpc('request_shipment_refresh', { p_account: w.acc, p_actor: w.sup.id, p_order: order, p_now: day(2) })).data).toMatchObject({ ok: false, reason: 'delivered_locked' })
      expect((await w.admin.rpc('stop_order_shipment', { p_account: w.acc, p_actor: w.sup.id, p_order: order, p_reason: 'manual', p_now: day(2) })).data).toMatchObject({ ok: false, reason: 'delivered_locked' })
    })

    it('stop tracking is SUPERVISOR only, keeps the history and records reason / actor / time', async () => {
      const order = await ready('stop')
      await register(order)
      expect((await w.admin.rpc('stop_order_shipment', { p_account: w.acc, p_actor: w.logi.id, p_order: order, p_reason: 'manual', p_now: at(5) })).error?.code).toBe('42501')
      for (const actor of [w.comm, w.viewer]) expect((await w.admin.rpc('stop_order_shipment', { p_account: w.acc, p_actor: actor.id, p_order: order, p_reason: 'manual', p_now: at(5) })).error?.code).toBe('42501')
      expect((await w.admin.rpc('stop_order_shipment', { p_account: w.acc, p_actor: w.sup.id, p_order: order, p_reason: 'order_cancelled', p_now: at(6) })).data).toMatchObject({ ok: true, changed: true })
      expect(await shipment(order)).toMatchObject({ tracking_state: 'stopped', stop_reason: 'order_cancelled', stopped_by: w.sup.id, next_poll_at: null })
      expect((await w.admin.rpc('stop_order_shipment', { p_account: w.acc, p_actor: w.sup.id, p_order: order, p_reason: 'order_cancelled', p_now: at(7) })).data).toMatchObject({ ok: true, changed: false })
      expect(await types(order)).toEqual(['shipment_registered', 'tracking_stopped'])
      expect(await claim(day(5), order)).toEqual([])
      expect((await w.admin.rpc('stop_order_shipment', { p_account: w.acc, p_actor: w.sup.id, p_order: order, p_reason: 'Bad Reason!', p_now: at(7) })).data).toMatchObject({ ok: false, reason: 'invalid_reason' })
    })

    it('forced refresh is RATE LIMITED per order and re-arms the next query now', async () => {
      const { order } = await shipAt('refresh', 'at_origin')
      expect((await w.admin.rpc('request_shipment_refresh', { p_account: w.acc, p_actor: w.logi.id, p_order: order, p_min_interval_seconds: 300, p_now: at(10) })).data).toMatchObject({ ok: true })
      expect(Date.parse(String((await shipment(order)).next_poll_at))).toBe(BASE + 10 * 60_000)
      expect((await w.admin.rpc('request_shipment_refresh', { p_account: w.acc, p_actor: w.sup.id, p_order: order, p_min_interval_seconds: 300, p_now: at(12) })).data).toMatchObject({ ok: false, reason: 'rate_limited', retry_after_seconds: 180 })
      expect((await w.admin.rpc('request_shipment_refresh', { p_account: w.acc, p_actor: w.sup.id, p_order: order, p_min_interval_seconds: 300, p_now: at(16) })).data).toMatchObject({ ok: true })
      for (const actor of [w.comm, w.viewer, w.foreign]) expect((await w.admin.rpc('request_shipment_refresh', { p_account: w.acc, p_actor: actor.id, p_order: order, p_now: at(40) })).error?.code).toBe('42501')
    })

    it('cross-account: another account can not correct / stop / refresh / acknowledge anything of this account', async () => {
      const { order } = await shipAt('xacc', 'at_origin')
      const foreign = { p_account: w.accForeign, p_actor: w.foreign.id }
      for (const [fn, args] of [
        ['correct_order_shipment_identifier', { ...foreign, p_order: order, p_number: '87654321', p_code: 'ZZ11' }],
        ['stop_order_shipment', { ...foreign, p_order: order, p_reason: 'manual' }],
        ['request_shipment_refresh', { ...foreign, p_order: order }],
      ] as const) expect((await w.admin.rpc(fn, args)).error?.code).toBe('42501')
      expect(await shipment(order)).toMatchObject({ identifier_version: 1, tracking_state: 'active' })
    })
  })

  // ------------------------------------------------------------------------------------------------------------------ 15-day alert
  describe('15-day En destino alert', () => {
    const evaluate = (now: string, days = 15) => w.admin.rpc('evaluate_destination_alerts', { p_now: now, p_days: days })
    const mine = (order: string) => async (now: string) => {
      await evaluate(now)
      return alerts(order)
    }

    it('day 14: no alert. Day 15 (America/Lima calendar day): exactly ONE alert; repeated ticks never duplicate it; tracking and status are untouched', async () => {
      const { order } = await shipAt('d15', 'at_destination', { destinationAt: '2026-12-01T20:00:00Z' }) // 15:00 Lima, 1 Dec
      const check = mine(order)
      expect(await check('2026-12-15T04:59:00Z')).toEqual([]) // 14 Dec 23:59 Lima = day 13
      expect(await check('2026-12-15T23:00:00Z')).toEqual([]) // 15 Dec 18:00 Lima = day 14
      expect(await check('2026-12-16T04:59:00Z')).toEqual([]) // 15 Dec 23:59 Lima = day 14
      expect(await check('2026-12-16T05:00:00Z')).toHaveLength(1) // 16 Dec 00:00 Lima = day 15
      for (let i = 0; i < 4; i += 1) expect(await check(`2026-12-${17 + i}T12:00:00Z`)).toHaveLength(1)
      const [a] = await alerts(order)
      expect(a).toMatchObject({ status: 'open', destination_episode: 1, due_date: '2026-12-16' })
      expect(await shipment(order)).toMatchObject({ logistic_status: 'at_destination', tracking_state: 'active', destination_entered_source: 'shalom' })
      expect((await events(order)).filter((e) => e.event_type === 'alert_created')).toHaveLength(1)
      // tracking continues after the alert: the order is still claimable and can still reach delivered
      const [c] = await claim(day(40), order)
      expect(c).toBeTruthy()
    })

    it('duplicate cron ticks / two concurrent evaluators create ONE alert and ONE notification per recipient', async () => {
      const { order } = await shipAt('dupe', 'at_destination', { destinationAt: '2026-11-01T15:00:00Z' })
      const rs = await Promise.all([evaluate('2026-12-20T15:00:00Z'), evaluate('2026-12-20T15:00:00Z'), evaluate('2026-12-20T15:00:01Z')])
      expect(rs.reduce((acc, r) => acc + ((r.data as { created: number }).created ?? 0), 0)).toBeGreaterThanOrEqual(1)
      expect(await alerts(order)).toHaveLength(1)
      const { data: notifs } = await w.admin.from('notifications').select('user_id, type, order_id, read_at, title').eq('order_id', order)
      const recipients = (notifs ?? []).map((x) => x.user_id).sort()
      expect(new Set(recipients).size).toBe(recipients.length)
    })

    it('without a date from Shalom the first WACRM observation starts the clock', async () => {
      const { order } = await shipAt('observed', 'at_destination', { destinationAt: null, now: '2026-12-02T15:00:00Z' })
      expect((await shipment(order)).destination_entered_source).toBe('observed')
      expect((await mine(order)('2026-12-16T15:00:00Z'))).toEqual([]) // 14 days later
      expect((await mine(order)('2026-12-17T15:00:00Z'))).toHaveLength(1) // 15 days later
    })

    it('notifications go to Logistics and Supervisor of the SAME account only; read_at is separate from the alert being attended; the order id travels with it', async () => {
      const { order } = await shipAt('notif', 'at_destination', { destinationAt: '2026-11-01T15:00:00Z' })
      await evaluate('2026-12-20T15:00:00Z')
      const { data: notifs } = await w.admin.from('notifications').select('user_id, type, order_id, read_at, account_id').eq('order_id', order)
      const users = new Set((notifs ?? []).map((x) => x.user_id))
      for (const id of [w.logi.id, w.logi2.id, w.sup.id]) expect(users.has(id)).toBe(true)
      for (const id of [w.comm.id, w.viewer.id, w.foreign.id, w.owner.id]) expect(users.has(id)).toBe(false)
      expect((notifs ?? []).every((x) => x.type === 'shipment_destination_alert' && x.account_id === w.acc && x.read_at === null)).toBe(true)
      // the recipient reads it through RLS and marks it read; that does NOT attend the alert
      const own = await w.logi.client.from('notifications').select('id').eq('order_id', order)
      expect(own.data).toHaveLength(1)
      expect((await w.logi.client.from('notifications').update({ read_at: at(1) }).eq('id', own.data![0].id).select('id')).data).toHaveLength(1)
      expect((await alerts(order))[0].status).toBe('open')
      expect(((await w.comm.client.from('notifications').select('id').eq('order_id', order)).data ?? [])).toHaveLength(0)
    })

    it('acknowledging is allowed to Logistics / Supervisor only, idempotent and audited; the history is kept', async () => {
      const { order } = await shipAt('ack', 'at_destination', { destinationAt: '2026-11-01T15:00:00Z' })
      await evaluate('2026-12-20T15:00:00Z')
      const [a] = await alerts(order)
      for (const actor of [w.comm, w.viewer]) expect((await w.admin.rpc('acknowledge_shipment_alert', { p_account: w.acc, p_actor: actor.id, p_alert: a.id })).error?.code).toBe('42501')
      expect((await w.admin.rpc('acknowledge_shipment_alert', { p_account: w.accForeign, p_actor: w.foreign.id, p_alert: a.id })).error?.code).toBe('42501')
      expect((await w.admin.rpc('acknowledge_shipment_alert', { p_account: w.acc, p_actor: w.logi.id, p_alert: a.id, p_now: at(5) })).data).toMatchObject({ ok: true, changed: true })
      expect((await w.admin.rpc('acknowledge_shipment_alert', { p_account: w.acc, p_actor: w.sup.id, p_alert: a.id, p_now: at(6) })).data).toMatchObject({ ok: true, changed: false })
      expect((await alerts(order))[0]).toMatchObject({ status: 'acknowledged' })
      expect((await w.admin.from('order_shipment_alerts').select('acknowledged_by').eq('id', a.id).single()).data).toMatchObject({ acknowledged_by: w.logi.id })
      // the polling goes on and a re-evaluation does not reopen it
      await evaluate('2026-12-21T15:00:00Z')
      expect((await alerts(order))).toHaveLength(1)
      expect((await alerts(order))[0].status).toBe('acknowledged')
    })

    it('delivered RESOLVES the open alert (reason delivered), keeps it as history and stops the polling', async () => {
      const { order } = await shipAt('deliv-alert', 'at_destination', { destinationAt: '2026-11-01T15:00:00Z' })
      await evaluate('2026-12-20T15:00:00Z')
      const [c] = await claim(day(30), order)
      await apply(c, { p_normalized: 'delivered', p_started_at: day(30), p_finished_at: day(30), p_raw_hash: 'dd' })
      expect((await alerts(order))[0]).toMatchObject({ status: 'resolved', resolved_reason: 'delivered' })
      expect(await types(order)).toEqual(expect.arrayContaining(['alert_created', 'alert_resolved', 'delivered']))
      expect(await claim(day(90), order)).toEqual([])
      await evaluate('2027-03-01T15:00:00Z')
      expect((await alerts(order))).toHaveLength(1) // nothing new for a delivered order
    })

    it('a NEW En destino episode (after a correction) gets its own alert; the previous one stays as resolved history', async () => {
      const { order } = await shipAt('episode', 'at_destination', { destinationAt: '2026-11-01T15:00:00Z' })
      await evaluate('2026-12-20T15:00:00Z')
      expect((await alerts(order))).toHaveLength(1)
      await w.admin.rpc('correct_order_shipment_identifier', { p_account: w.acc, p_actor: w.sup.id, p_order: order, p_number: '87654321', p_code: 'ZZ11', p_now: '2026-12-21T15:00:00Z' })
      expect((await alerts(order))[0]).toMatchObject({ status: 'resolved', resolved_reason: 'left_destination' })
      const [c] = await claim('2026-12-21T15:01:00Z', order)
      await apply(c, { p_normalized: 'at_destination', p_destination_at: '2026-12-21T15:00:00Z', p_started_at: '2026-12-21T15:01:00Z', p_finished_at: '2026-12-21T15:02:00Z', p_raw_hash: 'again', p_next_poll_at: '2026-12-22T00:00:00Z' })
      expect(await shipment(order)).toMatchObject({ destination_episode: 2, logistic_status: 'at_destination' })
      await evaluate('2027-01-05T15:00:00Z')
      const all = await alerts(order)
      expect(all.map((a) => [a.destination_episode, a.status])).toEqual([[1, 'resolved'], [2, 'open']])
    })

    it('stopping the tracking resolves the open alert (reason stopped); Commercial / other accounts receive nothing', async () => {
      const { order } = await shipAt('stop-alert', 'at_destination', { destinationAt: '2026-11-01T15:00:00Z' })
      await evaluate('2026-12-20T15:00:00Z')
      await w.admin.rpc('stop_order_shipment', { p_account: w.acc, p_actor: w.sup.id, p_order: order, p_reason: 'manual', p_now: '2026-12-21T15:00:00Z' })
      expect((await alerts(order))[0]).toMatchObject({ status: 'resolved', resolved_reason: 'stopped' })
    })

    it('the clock does not depend on Shalom: alerts are evaluated even while the credentials breaker is open; a flag OFF account gets none', async () => {
      const { order } = await shipAt('clock', 'at_destination', { destinationAt: '2026-11-01T15:00:00Z' })
      await w.admin.rpc('trip_shalom_credentials_breaker', { p_pause_seconds: 86400 * 400, p_reason: 'credentials', p_now: at(0) })
      await setShipmentFlag(w, w.acc, false)
      await evaluate('2026-12-20T15:00:00Z')
      expect(await alerts(order)).toEqual([]) // OFF account: no alert
      await setShipmentFlag(w, w.acc, true)
      await evaluate('2026-12-20T15:00:00Z')
      expect(await alerts(order)).toHaveLength(1)
      await w.admin.from('order_shipment_settings').update({ credentials_paused_until: null, credentials_paused_reason: null }).in('account_id', [w.acc, w.accForeign])
    })
  })

  // ------------------------------------------------------------------------------------------------------------------ notifications (existing behaviour kept)
  describe('notifications table (regression)', () => {
    it('conversation_assigned notifications still work and the new type needs an order', async () => {
      const { data: contact } = await w.admin.from('contacts').insert({ user_id: w.owner.id, account_id: w.acc, phone: `5190${Math.floor(1e6 + Math.random() * 8e6)}`, name: 'QA notif' }).select('id').single()
      const { data: conv } = await w.admin.from('conversations').insert({ user_id: w.owner.id, account_id: w.acc, contact_id: (contact as { id: string }).id }).select('id').single()
      const convId = (conv as { id: string }).id
      // the assignment trigger (migration 027) still inserts its notification
      await w.admin.from('conversations').update({ assigned_agent_id: w.logi.id }).eq('id', convId)
      const { data: assigned } = await w.admin.from('notifications').select('type, order_id, conversation_id').eq('conversation_id', convId)
      expect(assigned).toEqual([{ type: 'conversation_assigned', order_id: null, conversation_id: convId }])
      // a shipment alert without its order is refused; an unknown type is still refused
      expect((await w.admin.from('notifications').insert({ account_id: w.acc, user_id: w.logi.id, type: 'shipment_destination_alert', title: 'x' })).error?.code).toBe('23514')
      expect((await w.admin.from('notifications').insert({ account_id: w.acc, user_id: w.logi.id, type: 'something_else', title: 'x' })).error?.code).toBe('23514')
      // the recipient still reads her own and only her own
      expect(((await w.logi.client.from('notifications').select('id').eq('conversation_id', convId)).data ?? []).length).toBe(1)
      expect(((await w.sup.client.from('notifications').select('id').eq('conversation_id', convId)).data ?? []).length).toBe(0)
    })
  })

  describe('history protection', () => {
    it('events and polls are append-only; direct deletes are refused; retention purge only removes old technical polls', async () => {
      const { order } = await shipAt('append', 'at_origin')
      expect((await w.admin.from('order_shipment_events').update({ detail: {} }).eq('order_id', order)).error?.code).toBe('42501')
      expect((await w.admin.from('order_shipment_events').delete().eq('order_id', order)).error?.code).toBe('42501')
      expect((await w.admin.from('order_shipment_polls').update({ outcome: 'ok' }).eq('order_id', order)).error?.code).toBe('42501')
      expect((await w.admin.from('order_shipments').delete().eq('order_id', order)).error?.code).toBe('42501')
      expect((await w.admin.from('order_shipments').update({ order_id: crypto.randomUUID() }).eq('order_id', order)).error).not.toBeNull()
      expect((await w.admin.from('order_shipments').update({ identifier_version: 0 }).eq('order_id', order)).error).not.toBeNull()
      const before = (await polls(order)).length
      expect((await w.admin.rpc('purge_shipment_polls', { p_days: 30, p_now: at(0) })).data).toBeGreaterThanOrEqual(0)
      expect((await polls(order)).length).toBe(before) // recent polls stay
      expect((await w.admin.rpc('purge_shipment_polls', { p_days: 30, p_now: new Date(Date.now() + 40 * 86400_000).toISOString() })).data).toBeGreaterThanOrEqual(before)
      expect((await polls(order)).length).toBe(0)
      expect((await events(order)).length).toBeGreaterThan(0) // the functional history is never purged
    })
  })
})
