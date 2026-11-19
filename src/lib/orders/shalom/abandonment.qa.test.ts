// @vitest-environment node
/**
 * PR-05B · "EN ABANDONO" at 20 COMPLETE calendar days (America/Lima) En destino, against the REAL local stack. It is a WACRM operational condition
 * (order_shipments.pickup_state), never a Shalom status. Skipped unless LOCAL_URL is set. LOCAL ONLY.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createWorld, QA_ENABLED, type QaWorld } from '@/lib/orders/logistics/test-support/qa-env'
import { readShalomConfig } from '@/lib/orders/shalom/config'
import { runShalomTick } from '@/lib/orders/shalom/poller'
import { createFakeProvider } from '@/lib/orders/shalom/providers'
import { acquireQaLock, releaseQaLock } from '@/lib/orders/shalom/test-support/qa-lock'
import { clearCredentialsBreaker, setShipmentFlag } from '@/lib/orders/shalom/test-support/ready-order'
import { getShipmentPanel, getShipmentSummary, listAbandonedOrders } from '@/lib/orders/shalom/service'
import { shalomOps } from '@/lib/orders/shalom/test-support/shalom-ops'

let w: QaWorld
let o: ReturnType<typeof shalomOps>
const ARRIVAL = '2026-12-01T15:00:00Z' // 10:00 in Lima, calendar day 2026-12-01
const LIMA0 = Date.UTC(2026, 11, 1) + 5 * 3_600_000 // 2026-12-01 00:00 Lima
const limaDay = (n: number, minutes = 0) => new Date(LIMA0 + n * 86_400_000 + minutes * 60_000).toISOString()
const abandon = (nowIso: string, days = 20) => w.admin.rpc('evaluate_pickup_abandonment', { p_now: nowIso, p_days: days })
const day15 = (nowIso: string) => w.admin.rpc('evaluate_pickup_day15', { p_now: nowIso, p_days: 15 })

vi.setConfig({ testTimeout: 40_000, hookTimeout: 120_000 })

describe.skipIf(!QA_ENABLED)('PR-05B abandonment at day 20 En destino', () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.LOCAL_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.LOCAL_SERVICE
    await acquireQaLock()
    w = await createWorld()
    o = shalomOps(w)
    await setShipmentFlag(w, w.acc, true)
    await setShipmentFlag(w, w.accForeign, true)
  }, 120_000)
  afterAll(async () => {
    if (w) {
      await w.dispose()
      await clearCredentialsBreaker(w)
    }
    releaseQaLock()
  }, 90_000)

  it('day 19 (the 20th calendar day is not complete): not abandoned. Day 20: EN ABANDONO once. A second evaluation does not repeat. Day 21 stays. Shalom stays at_destination', async () => {
    const { order } = await o.shipAt('d20', 'at_destination', { destinationAt: ARRIVAL, finishedAt: ARRIVAL })
    await abandon(limaDay(20, -1))
    expect(await o.shipment(order)).toMatchObject({ pickup_state: 'waiting_pickup', pickup_abandoned_at: null })
    expect(await o.count(order, 'pickup_abandoned')).toBe(0)
    await day15(limaDay(15))
    expect(await o.shipment(order)).toMatchObject({ pickup_state: 'alerted_15d' })
    await abandon(limaDay(19, 23 * 60))
    expect(await o.shipment(order)).toMatchObject({ pickup_state: 'alerted_15d' })
    await abandon(limaDay(20))
    const s = await o.shipment(order)
    expect(s).toMatchObject({ pickup_state: 'abandoned', logistic_status: 'at_destination', tracking_state: 'active' })
    expect(s.pickup_abandoned_at).toBeTruthy()
    expect(s.next_poll_at).toBeTruthy() // still tracked
    const ev = (await o.events(order)).filter((e) => e.event_type === 'pickup_abandoned')
    expect(ev).toHaveLength(1)
    expect(ev[0].detail).toMatchObject({ episode: 1, days: 20 })
    for (const n of [21, 22]) await abandon(limaDay(n, 60))
    for (let i = 0; i < 3; i += 1) await abandon(limaDay(21, i * 15))
    expect(await o.count(order, 'pickup_abandoned')).toBe(1)
    expect(await o.shipment(order)).toMatchObject({ pickup_state: 'abandoned', logistic_status: 'at_destination' })
  })

  it("Shalom's own status set never gains an 'abandoned' value (it is a WACRM condition)", async () => {
    const { order } = await o.shipAt('shape', 'at_destination', { destinationAt: ARRIVAL })
    expect((await w.admin.from('order_shipments').update({ logistic_status: 'abandoned' }).eq('order_id', order)).error?.code).toBe('23514')
    expect((await w.admin.from('order_shipments').update({ pickup_state: 'abandoned' }).eq('order_id', order)).error?.code).toBe('23514') // needs pickup_abandoned_at
  })

  it('day 20 is detected WITHOUT the day-15 evaluation, the internal alert or any WhatsApp message (message switch OFF)', async () => {
    const { order } = await o.shipAt('independent', 'at_destination', { destinationAt: ARRIVAL })
    await abandon(limaDay(20))
    expect(await o.shipment(order)).toMatchObject({ pickup_state: 'abandoned', pickup_alerted_at: null })
    expect((await w.admin.from('order_shipment_alerts').select('id').eq('order_id', order)).data).toEqual([])
    expect((await w.admin.from('order_shipment_messages').select('id').eq('order_id', order)).data).toEqual([])
  })

  it('needs both flags: with the tracking flag OFF or logistics OFF nothing is abandoned', async () => {
    const { order } = await o.shipAt('flags', 'at_destination', { destinationAt: ARRIVAL })
    await setShipmentFlag(w, w.acc, false)
    await abandon(limaDay(25))
    expect(await o.shipment(order)).toMatchObject({ pickup_state: 'waiting_pickup' })
    await setShipmentFlag(w, w.acc, true)
    await w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: false }).eq('account_id', w.acc)
    await abandon(limaDay(25))
    expect(await o.shipment(order)).toMatchObject({ pickup_state: 'waiting_pickup' })
    await w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: true }).eq('account_id', w.acc)
    await abandon(limaDay(25))
    expect(await o.shipment(order)).toMatchObject({ pickup_state: 'abandoned' })
  })

  it('delivered later (day 22): delivered + tracking delivered + polling stopped + abandonment closed (completed), history kept, nothing deleted', async () => {
    const { order } = await o.shipAt('deliver', 'at_destination', { destinationAt: ARRIVAL })
    await day15(limaDay(15))
    await w.admin.rpc('evaluate_destination_alerts', { p_now: limaDay(15), p_days: 15 })
    await abandon(limaDay(20))
    expect((await o.shipment(order)).pickup_state).toBe('abandoned')
    const [c] = await o.claim(limaDay(22), order)
    const done = await o.apply(c, { p_normalized: 'delivered', p_started_at: limaDay(22), p_finished_at: limaDay(22, 1), p_now: limaDay(22, 1), p_raw_hash: 'dlv-22', p_next_poll_at: null })
    expect(done.data).toMatchObject({ applied: true })
    const s = await o.shipment(order)
    expect(s).toMatchObject({ logistic_status: 'delivered', tracking_state: 'delivered', pickup_state: 'completed', next_poll_at: null })
    expect(s.pickup_abandoned_at).toBeTruthy() // the historical timestamp stays
    expect((await w.admin.from('order_shipment_alerts').select('status').eq('order_id', order)).data?.every((a) => a.status !== 'open')).toBe(true)
    const types = (await o.events(order)).map((e) => e.event_type)
    expect(types).toEqual(expect.arrayContaining(['pickup_waiting_started', 'alert_created', 'pickup_abandoned', 'pickup_abandonment_cleared', 'delivered']))
    expect(types.filter((t) => t === 'pickup_abandoned')).toHaveLength(1)
    expect((await o.events(order)).find((e) => e.event_type === 'pickup_abandonment_cleared')?.detail).toMatchObject({ episode: 1, to: 'completed' })
    await abandon(limaDay(40)) // nothing reopens it, ever
    expect((await o.shipment(order)).pickup_state).toBe('completed')
  })

  it('a valid guide correction leaves En destino: the abandonment is NOT the current state, it stays as history; a new arrival is a new episode with its own day 15 / day 20', async () => {
    const { order } = await o.shipAt('episode', 'at_destination', { destinationAt: ARRIVAL })
    await abandon(limaDay(20))
    expect((await o.shipment(order)).pickup_state).toBe('abandoned')
    const fix = await w.admin.rpc('correct_order_shipment_identifier', { p_account: w.acc, p_actor: w.sup.id, p_order: order, p_number: '66666666', p_code: 'EP01', p_now: limaDay(21) })
    expect((fix.data as { ok?: boolean }).ok).toBe(true)
    expect(await o.shipment(order)).toMatchObject({ pickup_state: 'none' })
    const cleared = (await o.events(order)).filter((e) => e.event_type === 'pickup_abandonment_cleared')
    expect(cleared).toHaveLength(1)
    expect(cleared[0].detail).toMatchObject({ episode: 1 })
    expect(await o.count(order, 'pickup_abandoned')).toBe(1) // history kept
    const second = '2026-12-22T15:00:00Z' // arrives again on 22 Dec (Lima)
    const [c] = await o.claim(limaDay(22), order)
    await o.apply(c, { p_normalized: 'at_destination', p_destination_at: second, p_started_at: limaDay(22), p_finished_at: second, p_now: second, p_raw_hash: 'ep2' })
    expect(await o.shipment(order)).toMatchObject({ pickup_state: 'waiting_pickup', destination_episode: 2 })
    await abandon(limaDay(21 + 19, 600)) // 19 days after the new entry
    expect((await o.shipment(order)).pickup_state).toBe('waiting_pickup')
    await abandon(limaDay(21 + 20))
    expect((await o.shipment(order)).pickup_state).toBe('abandoned')
    const eps = (await o.events(order)).filter((e) => e.event_type === 'pickup_abandoned').map((e) => e.detail.episode)
    expect(eps).toEqual([1, 2])
  })

  it('the cron tick detects it even with the GLOBAL kill switch (no Shalom query) and reports it', async () => {
    const { order } = await o.shipAt('tick', 'at_destination', { destinationAt: ARRIVAL })
    const cfg = readShalomConfig({ SHALOM_CONFIG_JSON: JSON.stringify({ batchSize: 50 }) })
    const run = (n: number, m: number) => runShalomTick(w.admin, { cfg, now: () => new Date(limaDay(n, m)), skipQueries: true, provider: createFakeProvider(() => 'origin') } as never)
    const t = await run(30, 0)
    expect(t.enabled).toBe(false)
    expect(t.pickup.abandoned).toBeGreaterThanOrEqual(1)
    expect(await o.shipment(order)).toMatchObject({ pickup_state: 'abandoned', logistic_status: 'at_destination' })
    expect((await run(30, 15)).pickup.abandoned).toBe(0)
    expect(await o.count(order, 'pickup_abandoned')).toBe(1)
  })

  it('service reads (RLS): panel / summary / abandoned list carry the pickup condition for Logistics + Supervisor and NOTHING for Commercial, viewer or another account', async () => {
    const { order } = await o.shipAt('svc', 'at_destination', { destinationAt: ARRIVAL })
    await day15(limaDay(15))
    await abandon(limaDay(20))
    const caller = (a: typeof w.logi, acc: string) => ({ supabase: a.client, userId: a.id, accountId: acc }) as never
    for (const a of [w.logi, w.sup]) {
      const panel = await getShipmentPanel(caller(a, w.acc), order, false)
      expect(panel).toMatchObject({ ok: true, body: { shipment: { pickup_state: 'abandoned', logistic_status: 'at_destination' }, days_at_destination: expect.any(Number) } })
      if (panel.ok) expect(panel.body.days_at_destination).toBeGreaterThanOrEqual(0)
      const sum = await getShipmentSummary(caller(a, w.acc), [order])
      expect(sum).toMatchObject({ ok: true, body: { summaries: { [order]: { pickup_state: 'abandoned', logistic_status: 'at_destination' } } } })
      const list = await listAbandonedOrders(caller(a, w.acc))
      expect(list.ok && list.body.order_ids).toContain(order)
    }
    for (const a of [w.comm, w.viewer]) {
      expect(await listAbandonedOrders(caller(a, w.acc))).toMatchObject({ ok: false, status: 404 })
      expect(await getShipmentPanel(caller(a, w.acc), order, false)).toMatchObject({ ok: false, status: 404 })
    }
    expect(await listAbandonedOrders(caller(w.foreign, w.acc))).toMatchObject({ ok: false }) // another account's user asking for this account
    const foreign = await listAbandonedOrders(caller(w.foreign, w.accForeign))
    expect(foreign.ok && foreign.body.order_ids).not.toContain(order)
  })

  it('permissions: Logistics and Supervisor read the condition; Commercial, viewer and other accounts see nothing; nobody changes it from the browser or calls the evaluator', async () => {
    const { order } = await o.shipAt('perm', 'at_destination', { destinationAt: ARRIVAL })
    await abandon(limaDay(20))
    const read = async (a: typeof w.logi) => ((await a.client.from('order_shipments').select('pickup_state, pickup_abandoned_at').eq('order_id', order)).data ?? []) as Array<{ pickup_state: string }>
    for (const a of [w.logi, w.sup]) expect(await read(a)).toEqual([expect.objectContaining({ pickup_state: 'abandoned' })])
    for (const a of [w.comm, w.viewer, w.foreign]) expect(await read(a)).toEqual([])
    for (const a of [w.logi, w.sup, w.comm, w.foreign]) {
      expect((await a.client.from('order_shipments').update({ pickup_state: 'completed' }).eq('order_id', order).select('id')).data ?? []).toHaveLength(0)
      expect((await a.client.rpc('evaluate_pickup_abandonment', {})).error).not.toBeNull()
    }
    expect((await o.shipment(order)).pickup_state).toBe('abandoned')
  })
})
