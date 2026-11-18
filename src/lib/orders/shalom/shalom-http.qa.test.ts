// @vitest-environment node
/**
 * PR-05 · END TO END over HTTP against the RUNNING local app (real routes, real sessions, real database, real cron route) with the FAKE Shalom provider.
 * Skipped unless LOCAL_URL (Supabase) AND PR05_APP_URL are set. LOCAL ONLY.
 *
 * The app must be started with: SHALOM_PROVIDER=fake SHALOM_TRACKING_ENABLED=true SHALOM_FAKE_SCENARIO_FILE=<file> (and AUTOMATION_CRON_SECRET in .env.local).
 * WARNING: the cron route claims EVERY due shipment of every account that has the flag ON: do not run this while a manual UAT is in progress.
 *
 *   eval "$(npx supabase status -o env | sed 's/^/export /')"; LOCAL_URL=$API_URL LOCAL_ANON=$ANON_KEY LOCAL_SERVICE=$SERVICE_ROLE_KEY \
 *     PR05_APP_URL=http://localhost:3000 PR05_SCENARIO_FILE='C:\WACRM-LOCAL-QA\shalom-scenarios.json' npx vitest run src/lib/orders/shalom/shalom-http.qa.test.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createWorld, QA_ENABLED, type QaActor, type QaWorld } from '@/lib/orders/logistics/test-support/qa-env'
import { mkReadyOrder, setShipmentFlag } from '@/lib/orders/shalom/test-support/ready-order'
import { acquireQaLock, releaseQaLock } from '@/lib/orders/shalom/test-support/qa-lock'

const APP = process.env.PR05_APP_URL
const SCENARIO_FILE = process.env.PR05_SCENARIO_FILE
const RUN = QA_ENABLED && Boolean(APP) && Boolean(SCENARIO_FILE)

let w: QaWorld
let n = 0
let previousScenarios = ''
const scenarios: { default: string; byNumber: Record<string, string> } = { default: 'origin', byNumber: {} }
const persist = () => writeFileSync(SCENARIO_FILE!, JSON.stringify(scenarios))

function cronSecret(): string {
  const m = /^AUTOMATION_CRON_SECRET=(.*)$/m.exec(readFileSync('.env.local', 'utf8'))
  if (!m) throw new Error('AUTOMATION_CRON_SECRET missing in .env.local')
  return m[1].trim().replace(/^"|"$/g, '')
}

async function cookieOf(actor: QaActor): Promise<string> {
  const { data } = await actor.client.auth.getSession()
  const name = `sb-${new URL(process.env.LOCAL_URL!).hostname.split('.')[0]}-auth-token`
  const value = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64url')
  const size = 3180
  if (value.length <= size) return `${name}=${value}`
  return Array.from({ length: Math.ceil(value.length / size) }, (_, i) => `${name}.${i}=${value.slice(i * size, (i + 1) * size)}`).join('; ')
}
const cookies = new Map<string, string>()
async function call(actor: QaActor, method: string, path: string, body?: unknown) {
  if (!cookies.has(actor.id)) cookies.set(actor.id, await cookieOf(actor))
  const res = await fetch(`${APP}${path}`, { method, headers: { cookie: cookies.get(actor.id)!, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any
}
const cron = async (secret = cronSecret()) => {
  const res = await fetch(`${APP}/api/orders/shalom/cron`, { headers: { 'x-cron-secret': secret } })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any
}
const makeDue = (orders: string[]) => w.admin.from('order_shipments').update({ next_poll_at: new Date(Date.now() - 1000).toISOString() }).in('order_id', orders).eq('tracking_state', 'active')
const shipmentOf = async (order: string) => ((await w.admin.from('order_shipments').select('*').eq('order_id', order).single()).data ?? {}) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const mkNum = () => String(50_000_000 + (n += 1))
const base = (order: string) => `/api/orders/shalom/orders/${order}`

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

describe.skipIf(!RUN)('PR-05 over HTTP: real routes, sessions and cron (fake Shalom)', () => {
  beforeAll(async () => {
    await acquireQaLock()
    try { previousScenarios = readFileSync(SCENARIO_FILE!, 'utf8') } catch { previousScenarios = '' }
    persist()
    w = await createWorld()
    await setShipmentFlag(w, w.acc, true)
    await setShipmentFlag(w, w.accForeign, true)
  }, 120_000)
  // shipments left by an earlier test answer "origin" afterwards (not a stale 429 / 401), and the credentials breaker is closed
  afterEach(async () => {
    for (const k of Object.keys(scenarios.byNumber)) scenarios.byNumber[k] = 'origin'
    persist()
    await w.admin.from('order_shipment_settings').update({ credentials_paused_until: null, credentials_paused_reason: null }).in('account_id', [w.acc, w.accForeign])
  })
  afterAll(async () => {
    if (previousScenarios) writeFileSync(SCENARIO_FILE!, previousScenarios)
    if (w) await w.dispose()
    releaseQaLock()
  }, 90_000)

  it('who can reach the tracking: Logistics / Supervisor yes; Commercial, viewer, no area 403; another account 404; flags OFF 403', async () => {
    const order = await mkReadyOrder(w, w.acc, `h-auth-${(n += 1)}`)
    for (const actor of [w.logi, w.sup]) expect((await call(actor, 'GET', base(order))).status).toBe(200)
    for (const actor of [w.comm, w.viewer]) expect((await call(actor, 'GET', base(order))).status).toBe(403)
    await w.admin.from('profiles').update({ operational_role: null }).eq('user_id', w.logi2.id)
    expect((await call(w.logi2, 'GET', base(order))).status).toBe(403)
    await w.admin.from('profiles').update({ operational_role: 'logistics' }).eq('user_id', w.logi2.id)
    expect((await call(w.foreign, 'GET', base(order))).status).toBe(404)
    expect((await call(w.foreign, 'POST', base(order), { action: 'register', numero_orden: '12345678', codigo: '7M99' })).status).toBe(404)
    // shalom_tracking_enabled OFF → 403 for everybody of the account; PR-04's flag OFF → 403 as well
    await setShipmentFlag(w, w.acc, false)
    expect((await call(w.logi, 'GET', base(order))).body).toMatchObject({ error: 'feature_disabled' })
    await setShipmentFlag(w, w.acc, true)
    await w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: false }).eq('account_id', w.acc)
    expect((await call(w.logi, 'GET', base(order))).status).toBe(403)
    await w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: true }).eq('account_id', w.acc)
    expect((await call(w.logi, 'GET', '/api/orders/shalom/summary?ids=' + order)).status).toBe(200)
    expect((await call(w.comm, 'GET', '/api/orders/shalom/summary?ids=' + order)).status).toBe(403)
    expect((await call(w.logi, 'GET', '/api/orders/shalom/summary?ids=')).status).toBe(400)
  })

  it('cron: wrong / missing secret → 401, nothing runs', async () => {
    expect((await cron('wrong-secret')).status).toBe(401)
    expect((await fetch(`${APP}/api/orders/shalom/cron`)).status).toBe(401)
  })

  it('the complete UAT path: register → En origen → En tránsito → En destino → +15 days alert (once) → attend → Entregado → polling ends', async () => {
    const order = await mkReadyOrder(w, w.acc, `h-flow-${(n += 1)}`)
    const num = mkNum()
    // the order is eligible, no guide yet; a bad guide is refused; Commercial cannot register
    expect((await call(w.logi, 'GET', base(order))).body).toMatchObject({ eligible: true, shipment: null })
    expect((await call(w.logi, 'POST', base(order), { action: 'register', numero_orden: '12', codigo: 'x' })).status).toBe(422)
    expect((await call(w.comm, 'POST', base(order), { action: 'register', numero_orden: num, codigo: 'qa01' })).status).toBe(403)
    const reg = await call(w.logi, 'POST', base(order), { action: 'register', numero_orden: num, codigo: 'qa01' })
    expect(reg).toMatchObject({ status: 201, body: { created: true } })

    scenarios.byNumber[num] = 'origin'
    persist()
    const t = await cron()
    expect(t).toMatchObject({ status: 200, body: { enabled: true, provider: 'fake' } })
    expect(t.body.claimed).toBeGreaterThanOrEqual(1)
    expect(await shipmentOf(order)).toMatchObject({ logistic_status: 'at_origin', tracking_code: 'QA01' })
    // the derived list status is the PR-05 one
    expect((await call(w.sup, 'GET', `/api/orders/shalom/summary?ids=${order}`)).body.summaries[order]).toMatchObject({ logistic_status: 'at_origin', alert_open: false })

    scenarios.byNumber[num] = 'transit'
    persist()
    await makeDue([order])
    await cron()
    expect((await shipmentOf(order)).logistic_status).toBe('in_transit')

    scenarios.byNumber[num] = `destination@${new Date(Date.now() - 3_600_000).toISOString()}`
    persist()
    await makeDue([order])
    await cron()
    const atDest = await shipmentOf(order)
    expect(atDest).toMatchObject({ logistic_status: 'at_destination', destination_episode: 1, destination_entered_source: 'shalom' })

    // day 14 → nothing; day 15 → ONE alert (QA moves the arrival back; the product never edits it)
    const move = async (days: number) => w.admin.from('order_shipments').update({ destination_entered_at: new Date(Date.parse(atDest.destination_entered_at) - days * 86_400_000).toISOString() }).eq('order_id', order)
    await move(14)
    await cron()
    expect((await w.admin.from('order_shipment_alerts').select('id').eq('order_id', order)).data).toEqual([])
    await move(15)
    const day15 = await cron()
    expect(day15.body.alertsCreated).toBeGreaterThanOrEqual(1)
    await cron()
    await cron()
    const alerts = ((await w.admin.from('order_shipment_alerts').select('id, status').eq('order_id', order)).data ?? []) as Array<{ id: string; status: string }>
    expect(alerts).toHaveLength(1)
    expect((await shipmentOf(order)).tracking_state).toBe('active') // the alert does not stop anything

    // visible to Logistics and Supervisor, never to Commercial; the notification carries the order
    const panel = await call(w.logi, 'GET', base(order))
    expect(panel.body.alerts[0]).toMatchObject({ status: 'open' })
    expect((await call(w.sup, 'GET', base(order))).body.alerts).toHaveLength(1)
    expect((await call(w.comm, 'GET', base(order))).status).toBe(403)
    expect((await w.logi.client.from('notifications').select('order_id, type, read_at').eq('order_id', order)).data).toEqual([{ order_id: order, type: 'shipment_destination_alert', read_at: null }])
    expect(((await w.comm.client.from('notifications').select('id').eq('order_id', order)).data ?? [])).toHaveLength(0)
    expect((await call(w.comm, 'POST', `/api/orders/shalom/alerts/${alerts[0].id}/ack`, {})).status).toBe(403)
    expect((await call(w.foreign, 'POST', `/api/orders/shalom/alerts/${alerts[0].id}/ack`, {})).status).toBe(404)
    expect((await call(w.logi, 'POST', `/api/orders/shalom/alerts/${alerts[0].id}/ack`, {})).body).toMatchObject({ changed: true })
    expect((await call(w.sup, 'GET', base(order))).body.alerts[0].status).toBe('acknowledged')
    expect((await w.logi.client.from('notifications').select('read_at').eq('order_id', order)).data).toEqual([{ read_at: null }]) // attended ≠ read

    // Shalom says delivered: the alert is resolved, the order closes and is never polled again
    scenarios.byNumber[num] = 'delivered'
    persist()
    await makeDue([order])
    await cron()
    expect(await shipmentOf(order)).toMatchObject({ logistic_status: 'delivered', tracking_state: 'delivered', next_poll_at: null })
    expect((await w.admin.from('order_shipment_alerts').select('status, resolved_reason').eq('order_id', order)).data).toEqual([{ status: 'resolved', resolved_reason: 'delivered' }])
    const polls = (await w.admin.from('order_shipment_polls').select('id').eq('order_id', order)).data?.length
    await cron()
    expect((await w.admin.from('order_shipment_polls').select('id').eq('order_id', order)).data?.length).toBe(polls)
    expect((await call(w.logi, 'POST', base(order), { action: 'correct', numero_orden: mkNum(), codigo: 'zz11' })).status).toBe(409) // delivered is locked
  })

  it('error scenarios over HTTP: 404, 429, unknown, credentials; the cron answers 200 every time and WACRM keeps working', async () => {
    const mk = async (scenario: string) => {
      const order = await mkReadyOrder(w, w.acc, `h-err-${(n += 1)}`)
      const num = mkNum()
      scenarios.byNumber[num] = scenario
      persist()
      await call(w.logi, 'POST', base(order), { action: 'register', numero_orden: num, codigo: 'qe01' })
      return { order, num }
    }
    const a = await mk('not_found')
    const t = await cron()
    expect(t.status).toBe(200)
    expect(await shipmentOf(a.order)).toMatchObject({ tracking_state: 'active', consecutive_failures: 1, last_error_kind: 'order' })
    expect((await call(w.logi, 'GET', base(a.order))).body.shipment).toMatchObject({ last_error_kind: 'order', last_error_code: 'not_found' })

    const u = await mk('unknown')
    await cron()
    expect(await shipmentOf(u.order)).toMatchObject({ logistic_status: null, last_error_kind: 'exception' })

    const c = await mk('credentials_401')
    const cc = await cron()
    expect(cc.status).toBe(200)
    expect(await shipmentOf(c.order)).toMatchObject({ last_error_kind: 'credentials', consecutive_failures: 0 })
    expect((await cron()).body.claimed).toBe(0) // the global breaker is open
    await w.admin.from('order_shipment_settings').update({ credentials_paused_until: null, credentials_paused_reason: null }).in('account_id', [w.acc, w.accForeign])

    const r = await mk('rate_limited')
    await makeDue([r.order, a.order, u.order, c.order])
    const rl = await cron()
    expect(rl.status).toBe(200)
    // the answer carries counters only (no tokens, no customer data)
    expect(JSON.stringify(rl.body)).not.toMatch(/secret|token|password/i)
    // everything else in WACRM still answers
    expect((await call(w.logi, 'GET', '/api/orders/confirmed')).status).toBe(200)
  })

  it('correction, forced refresh (rate limited) and Supervisor-only stop over HTTP', async () => {
    const order = await mkReadyOrder(w, w.acc, `h-act-${(n += 1)}`)
    const num = mkNum()
    scenarios.byNumber[num] = 'transit'
    persist()
    await call(w.logi, 'POST', base(order), { action: 'register', numero_orden: num, codigo: 'qa09' })
    await cron()
    expect((await shipmentOf(order)).logistic_status).toBe('in_transit')

    const fixed = mkNum()
    scenarios.byNumber[fixed] = 'origin'
    persist()
    expect((await call(w.logi, 'POST', base(order), { action: 'correct', numero_orden: fixed, codigo: 'qa10', expected_version: 9 })).status).toBe(409)
    expect((await call(w.logi, 'POST', base(order), { action: 'correct', numero_orden: fixed, codigo: 'qa10', expected_version: 1 })).body).toMatchObject({ changed: true, identifier_version: 2 })
    expect(await shipmentOf(order)).toMatchObject({ identifier_version: 2, logistic_status: null, tracking_number: fixed })
    const refreshed = await call(w.logi, 'POST', base(order), { action: 'refresh' })
    expect(refreshed).toMatchObject({ status: 200, body: { queried: true, outcome: 'ok' } })
    expect((await shipmentOf(order)).logistic_status).toBe('at_origin')
    const limited = await call(w.sup, 'POST', base(order), { action: 'refresh' })
    expect(limited).toMatchObject({ status: 429, body: { error: 'rate_limited' } })
    expect(limited.body.retry_after_seconds).toBeGreaterThan(0)
    for (const actor of [w.logi, w.comm, w.viewer]) expect((await call(actor, 'POST', base(order), { action: 'stop', reason: 'manual' })).status).toBe(403)
    expect((await call(w.sup, 'POST', base(order), { action: 'stop', reason: 'order_cancelled' })).body).toMatchObject({ changed: true })
    expect(await shipmentOf(order)).toMatchObject({ tracking_state: 'stopped', stop_reason: 'order_cancelled', next_poll_at: null })
    expect((await call(w.logi, 'POST', base(order), { action: 'correct', numero_orden: mkNum(), codigo: 'qa11' })).status).toBe(409)
    const before = (await w.admin.from('order_shipment_polls').select('id').eq('order_id', order)).data?.length
    await cron()
    expect((await w.admin.from('order_shipment_polls').select('id').eq('order_id', order)).data?.length).toBe(before)
  })
})

