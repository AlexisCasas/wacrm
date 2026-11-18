import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getCurrentAccount = vi.fn()
const resolveAccess = vi.fn()
const rpc = vi.fn()
const svc = {
  getShipmentPanel: vi.fn(), registerShipment: vi.fn(), correctShipment: vi.fn(), stopShipment: vi.fn(), refreshShipment: vi.fn(), acknowledgeAlert: vi.fn(), getShipmentSummary: vi.fn(),
}
const runShalomTick = vi.fn()
const collectShalomHealth = vi.fn()

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: () => getCurrentAccount(),
  toErrorResponse: (e: Error) => new Response(JSON.stringify({ error: e.message }), { status: e.message === 'Unauthorized' ? 401 : 500 }),
}))
vi.mock('@/lib/orders/confirmed-orders', () => ({ resolveConfirmedOrdersAccess: (c: unknown) => resolveAccess(c) }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ admin: true }) }))
vi.mock('@/lib/orders/shalom/service', () => ({
  getShipmentPanel: (...a: unknown[]) => svc.getShipmentPanel(...a),
  registerShipment: (...a: unknown[]) => svc.registerShipment(...a),
  correctShipment: (...a: unknown[]) => svc.correctShipment(...a),
  stopShipment: (...a: unknown[]) => svc.stopShipment(...a),
  refreshShipment: (...a: unknown[]) => svc.refreshShipment(...a),
  acknowledgeAlert: (...a: unknown[]) => svc.acknowledgeAlert(...a),
  getShipmentSummary: (...a: unknown[]) => svc.getShipmentSummary(...a),
  MAX_SUMMARY_IDS: 50,
}))
vi.mock('@/lib/orders/shalom/poller', () => ({ runShalomTick: (...a: unknown[]) => runShalomTick(...a), collectShalomHealth: (...a: unknown[]) => collectShalomHealth(...a) }))

import { POST as ACK } from './alerts/[id]/ack/route'
import { GET as CRON } from './cron/route'
import { GET as PANEL, POST as ACTION } from './orders/[orderId]/route'
import { GET as SUMMARY } from './summary/route'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const OTHER = '55555555-5555-4555-8555-555555555555'
const ORDER = '22222222-2222-4222-8222-222222222222'
const ALERT = '99999999-9999-4999-8999-999999999999'
let user = 0
const ctx = (role = 'agent') => ({ supabase: { rpc }, userId: `user-${(user += 1)}`, accountId: ACCOUNT, role })
const params = { params: Promise.resolve({ orderId: ORDER }) }
const post = (body: unknown) => new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const ok = (body: unknown = {}) => ({ ok: true, status: 200, body })
const ENV = { ...process.env }

beforeEach(() => {
  for (const f of Object.values(svc)) f.mockReset().mockResolvedValue(ok())
  getCurrentAccount.mockResolvedValue(ctx())
  resolveAccess.mockResolvedValue({ kind: 'ok', operationalRole: 'logistics' })
  rpc.mockReset().mockResolvedValue({ data: true, error: null })
})
afterEach(() => {
  process.env = { ...ENV }
})

const endpoints: Array<[string, () => Promise<Response>]> = [
  ['panel', () => PANEL(new Request('http://x'), params)],
  ['action', () => ACTION(post({ action: 'refresh' }), params)],
  ['ack', () => ACK(post({}), { params: Promise.resolve({ id: ALERT }) })],
  ['summary', () => SUMMARY(new Request(`http://x/?ids=${ORDER}`))],
]

describe.each(endpoints)('%s endpoint authority', (_name, call) => {
  it('no session → 401; logistics flag OFF → 403 feature_disabled; Commercial / no area → 403; viewer → 403; shalom_tracking_enabled OFF → 403; nothing reaches the service', async () => {
    getCurrentAccount.mockRejectedValueOnce(new Error('Unauthorized'))
    expect((await call()).status).toBe(401)
    resolveAccess.mockResolvedValueOnce({ kind: 'disabled' })
    const off = await call()
    expect(off.status).toBe(403)
    expect(await off.json()).toEqual({ error: 'feature_disabled' })
    resolveAccess.mockResolvedValueOnce({ kind: 'forbidden' })
    const commercial = await call()
    expect(commercial.status).toBe(403)
    expect(await commercial.json()).toEqual({ error: 'operational_role_required' })
    getCurrentAccount.mockResolvedValueOnce(ctx('viewer'))
    expect((await call()).status).toBe(403)
    rpc.mockResolvedValueOnce({ data: false, error: null }) // PR-04 flag ON but shalom_tracking_enabled OFF (the database says no)
    const shalomOff = await call()
    expect(shalomOff.status).toBe(403)
    expect(await shalomOff.json()).toEqual({ error: 'feature_disabled' })
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000' } })
    expect((await call()).status).toBe(500)
    for (const f of Object.values(svc)) expect(f).not.toHaveBeenCalled()
  })

  it('the database access check is asked with the SESSION account (never a request value)', async () => {
    await call()
    expect(rpc).toHaveBeenCalledWith('order_shipments_access', { p_account_id: ACCOUNT })
  })
})

describe('order actions', () => {
  it('register / correct: the account and actor come from the session; only the guide is read from the body', async () => {
    await ACTION(post({ action: 'register', numero_orden: '12345678', codigo: '7M99', account_id: OTHER, user_id: OTHER, actor: OTHER, order_id: OTHER }), params)
    const [c, , orderId, input] = svc.registerShipment.mock.calls[0]
    expect(c).toMatchObject({ accountId: ACCOUNT })
    expect(orderId).toBe(ORDER)
    expect(input).toEqual({ numero: '12345678', codigo: '7M99' })
    expect(JSON.stringify(svc.registerShipment.mock.calls[0].slice(0, 4))).not.toContain(OTHER)
    await ACTION(post({ action: 'correct', numero_orden: '87654321', codigo: 'ZZ11', expected_version: 3 }), params)
    expect(svc.correctShipment.mock.calls[0][3]).toEqual({ numero: '87654321', codigo: 'ZZ11', expectedVersion: 3 })
  })

  it('stop is SUPERVISOR only: a logistics operator gets 403 and the service is never called', async () => {
    const denied = await ACTION(post({ action: 'stop', reason: 'manual' }), params)
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: 'supervisor_required' })
    expect(svc.stopShipment).not.toHaveBeenCalled()
    resolveAccess.mockResolvedValue({ kind: 'ok', operationalRole: 'supervisor' })
    expect((await ACTION(post({ action: 'stop', reason: 'order_cancelled' }), params)).status).toBe(200)
    expect(svc.stopShipment.mock.calls[0][3]).toBe('order_cancelled')
    // the panel tells the UI whether this person may stop
    await PANEL(new Request('http://x'), params)
    expect(svc.getShipmentPanel.mock.calls[0][2]).toBe(true)
  })

  it('refresh honours the GLOBAL kill switch: with it OFF no provider is ever reached; ON it refreshes through the resolved provider (not_configured by default)', async () => {
    delete process.env.SHALOM_TRACKING_ENABLED
    const off = await ACTION(post({ action: 'refresh' }), params)
    expect(off.status).toBe(409)
    expect(await off.json()).toEqual({ error: 'tracking_disabled' })
    expect(svc.refreshShipment).not.toHaveBeenCalled()
    process.env.SHALOM_TRACKING_ENABLED = 'true'
    expect((await ACTION(post({ action: 'refresh' }), params)).status).toBe(200)
    const deps = svc.refreshShipment.mock.calls[0][3] as { provider: { name: string } }
    expect(deps.provider.name).toBe('not_configured') // no real provider exists
  })

  it('service verdicts pass through (403 / 404 / 409 / 422 / 429 with retry_after_seconds); invalid body / action are 400', async () => {
    svc.registerShipment.mockResolvedValueOnce({ ok: false, status: 409, error: 'not_ready_for_dispatch' })
    expect((await ACTION(post({ action: 'register', numero_orden: '12345678', codigo: '7M99' }), params)).status).toBe(409)
    svc.correctShipment.mockResolvedValueOnce({ ok: false, status: 422, error: 'invalid_identifier' })
    expect((await ACTION(post({ action: 'correct', numero_orden: 'x', codigo: 'y' }), params)).status).toBe(422)
    process.env.SHALOM_TRACKING_ENABLED = 'true'
    svc.refreshShipment.mockResolvedValueOnce({ ok: false, status: 429, error: 'rate_limited', extra: { retry_after_seconds: 120 } })
    const limited = await ACTION(post({ action: 'refresh' }), params)
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({ error: 'rate_limited', retry_after_seconds: 120 })
    expect((await ACTION(post({ action: 'delete_everything' }), params)).status).toBe(400)
    expect((await ACTION(new Request('http://x', { method: 'POST', body: 'nope' }), params)).status).toBe(400)
  })
})

describe('alerts and summary', () => {
  it('ack: wired to the session; the answer is never cached', async () => {
    const r = await ACK(post({ account_id: OTHER }), { params: Promise.resolve({ id: ALERT }) })
    expect(r.status).toBe(200)
    expect(r.headers.get('Cache-Control')).toBe('no-store')
    const [c, , id] = svc.acknowledgeAlert.mock.calls[0]
    expect(c).toMatchObject({ accountId: ACCOUNT })
    expect(id).toBe(ALERT)
  })

  it('summary: 1..50 ids only', async () => {
    expect((await SUMMARY(new Request('http://x/?ids='))).status).toBe(400)
    const many = Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`).join(',')
    expect((await SUMMARY(new Request(`http://x/?ids=${many}`))).status).toBe(400)
    expect((await SUMMARY(new Request(`http://x/?ids=${ORDER}`))).status).toBe(200)
  })
})

describe('GET /api/orders/shalom/cron', () => {
  const call = (secret?: string) => CRON(new Request('http://x', { headers: secret === undefined ? {} : { 'x-cron-secret': secret } }))
  beforeEach(() => {
    runShalomTick.mockReset().mockResolvedValue({ enabled: true, claimed: 0, applied: 0, ignored: 0, byOutcome: {}, paused: null, alertsCreated: 0, alertsNotified: 0, purgedPolls: 0, errors: 0, durationMs: 1 })
    collectShalomHealth.mockReset().mockResolvedValue({ active: 0 })
  })

  it('same protection as the other crons: not configured → 503; missing / wrong secret → 401; nothing runs', async () => {
    delete process.env.AUTOMATION_CRON_SECRET
    expect((await call('x')).status).toBe(503)
    process.env.AUTOMATION_CRON_SECRET = 'cron-secret'
    expect((await call()).status).toBe(401)
    expect((await call('wrong-secret')).status).toBe(401)
    expect(runShalomTick).not.toHaveBeenCalled()
  })

  it('GLOBAL KILL SWITCH: unless SHALOM_TRACKING_ENABLED=true the tick makes NO query (skipQueries) but the DB-only alert clock still runs', async () => {
    process.env.AUTOMATION_CRON_SECRET = 'cron-secret'
    delete process.env.SHALOM_TRACKING_ENABLED
    await call('cron-secret')
    expect(runShalomTick.mock.calls[0][1]).toMatchObject({ skipQueries: true })
    process.env.SHALOM_TRACKING_ENABLED = 'true'
    const res = await call('cron-secret')
    expect(runShalomTick.mock.calls[1][1]).toMatchObject({ skipQueries: false })
    expect(await res.json()).toMatchObject({ provider: 'not_configured', health: { active: 0 } })
  })

  it('the fake provider is only resolved outside production; a failure is a 500 that leaks nothing', async () => {
    process.env.AUTOMATION_CRON_SECRET = 'cron-secret'
    ;(process.env as Record<string, string>).NODE_ENV = 'development'
    process.env.SHALOM_PROVIDER = 'fake'
    expect(await (await call('cron-secret')).json()).toMatchObject({ provider: 'fake' })
    ;(process.env as Record<string, string>).NODE_ENV = 'production'
    expect(await (await call('cron-secret')).json()).toMatchObject({ provider: 'not_configured' })
    runShalomTick.mockRejectedValueOnce(new Error('secret-db-detail'))
    const failed = await call('cron-secret')
    expect(failed.status).toBe(500)
    expect(JSON.stringify(await failed.json())).not.toContain('secret-db-detail')
  })
})
