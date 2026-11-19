// @vitest-environment node
/**
 * PR-05A/B · the PICKUP condition next to the Shalom status (En destino → waiting_pickup → … → completed), against the REAL local stack. Stage 1: the state
 * model and its coherence with the Shalom status. Skipped unless LOCAL_URL is set. LOCAL ONLY (see logistics/test-support/qa-env).
 *
 *   eval "$(npx supabase status -o env | sed 's/^/export /')"; LOCAL_URL=$API_URL LOCAL_ANON=$ANON_KEY LOCAL_SERVICE=$SERVICE_ROLE_KEY npx vitest run src/lib/orders/shalom/pickup-state.qa.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createWorld, QA_ENABLED, type QaWorld } from '@/lib/orders/logistics/test-support/qa-env'
import { acquireQaLock, releaseQaLock } from '@/lib/orders/shalom/test-support/qa-lock'
import { clearCredentialsBreaker, setShipmentFlag } from '@/lib/orders/shalom/test-support/ready-order'
import { at, day, shalomOps } from '@/lib/orders/shalom/test-support/shalom-ops'

let w: QaWorld
let o: ReturnType<typeof shalomOps>

vi.setConfig({ testTimeout: 30_000, hookTimeout: 570_000 })

describe.skipIf(!QA_ENABLED)('PR-05A/B pickup condition: model and coherence with the Shalom status', () => {
  beforeAll(async () => {
    await acquireQaLock()
    w = await createWorld()
    o = shalomOps(w)
    await setShipmentFlag(w, w.acc, true)
    await setShipmentFlag(w, w.accForeign, true)
  }, 570_000) // waits for the global QA lock (up to 8 min under a loaded full run)
  afterAll(async () => {
    if (w) {
      await w.dispose()
      await clearCredentialsBreaker(w)
    }
    releaseQaLock()
  }, 90_000)

  it('starts at none; entering En destino starts waiting_pickup (ONE event per episode); the Shalom status is untouched', async () => {
    const origin = await o.shipAt('p-origin', 'in_transit')
    expect(await o.shipment(origin.order)).toMatchObject({ pickup_state: 'none', pickup_state_at: null })
    expect(await o.count(origin.order, 'pickup_waiting_started')).toBe(0)

    const { order } = await o.shipAt('p-dest', 'at_destination', { destinationAt: '2026-12-01T12:00:00Z' })
    expect(await o.shipment(order)).toMatchObject({ logistic_status: 'at_destination', tracking_state: 'active', pickup_state: 'waiting_pickup', destination_episode: 1 })
    expect((await o.shipment(order)).pickup_state_at).toBeTruthy()
    const started = (await o.events(order)).filter((e) => e.event_type === 'pickup_waiting_started')
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ source: 'system', detail: { episode: 1 } })
  })

  it('the same state received again (more polls) does NOT repeat the event nor move the condition', async () => {
    const { order } = await o.shipAt('p-again', 'at_destination')
    for (let i = 0; i < 3; i += 1) {
      const [c] = await o.claim(day(1, i), order)
      await o.apply(c, { p_normalized: 'at_destination', p_started_at: day(1, i), p_finished_at: day(1, i), p_raw_hash: 'h-at_destination', p_next_poll_at: day(1, i) })
    }
    expect(await o.count(order, 'pickup_waiting_started')).toBe(1)
    expect((await o.shipment(order)).pickup_state).toBe('waiting_pickup')
  })

  it('delivered while waiting → completed (+ pickup_completed once); the shipment closes and keeps its history', async () => {
    const { order } = await o.shipAt('p-done', 'at_destination')
    const [c] = await o.claim(day(2), order)
    await o.apply(c, { p_normalized: 'delivered', p_started_at: day(2), p_finished_at: day(2), p_raw_hash: 'h-delivered' })
    expect(await o.shipment(order)).toMatchObject({ logistic_status: 'delivered', tracking_state: 'delivered', next_poll_at: null, pickup_state: 'completed' })
    const completed = (await o.events(order)).filter((e) => e.event_type === 'pickup_completed')
    expect(completed).toHaveLength(1)
    expect(completed[0].detail).toMatchObject({ episode: 1, from: 'waiting_pickup' })
    expect(await o.count(order, 'pickup_waiting_started')).toBe(1) // history intact
    expect(await o.count(order, 'pickup_abandonment_cleared')).toBe(0)
  })

  it('delivered WITHOUT ever being En destino leaves the condition at none (nothing to complete)', async () => {
    const { order } = await o.shipAt('p-direct', 'in_transit')
    const [c] = await o.claim(day(2), order)
    await o.apply(c, { p_normalized: 'delivered', p_started_at: day(2), p_finished_at: day(2), p_raw_hash: 'h-delivered' })
    expect(await o.shipment(order)).toMatchObject({ logistic_status: 'delivered', pickup_state: 'none' })
    expect(await o.count(order, 'pickup_completed')).toBe(0)
  })

  it('a guide correction that leaves En destino returns the condition to none (history kept); a NEW arrival is a NEW episode that waits again', async () => {
    const { order } = await o.shipAt('p-corr', 'at_destination')
    expect((await w.admin.rpc('correct_order_shipment_identifier', { p_account: w.acc, p_actor: w.sup.id, p_order: order, p_number: '88888888', p_code: 'ZZ11', p_now: day(3) })).data).toMatchObject({ ok: true, changed: true })
    expect(await o.shipment(order)).toMatchObject({ logistic_status: null, pickup_state: 'none', destination_episode: 1 })
    expect(await o.count(order, 'pickup_waiting_started')).toBe(1) // the first episode stays in the history
    const [c] = await o.claim(day(3, 1), order)
    await o.apply(c, { p_normalized: 'at_destination', p_started_at: day(3, 1), p_finished_at: day(3, 1), p_raw_hash: 'again' })
    expect(await o.shipment(order)).toMatchObject({ logistic_status: 'at_destination', pickup_state: 'waiting_pickup', destination_episode: 2 })
    const eps = (await o.events(order)).filter((e) => e.event_type === 'pickup_waiting_started').map((e) => e.detail.episode)
    expect(eps).toEqual([1, 2])
  })

  it('the shape is enforced by the database: a pickup condition can only exist En destino (completed only when delivered)', async () => {
    const { order } = await o.shipAt('p-shape', 'in_transit')
    for (const state of ['waiting_pickup', 'alerted_15d', 'completed']) {
      expect((await w.admin.from('order_shipments').update({ pickup_state: state }).eq('order_id', order)).error?.code).toBe('23514')
    }
    expect((await w.admin.from('order_shipments').update({ pickup_state: 'nonsense' }).eq('order_id', order)).error?.code).toBe('23514')
    expect(await o.shipment(order)).toMatchObject({ pickup_state: 'none' })
  })

  it('RLS: Logistics / Supervisor read the pickup columns; Commercial, viewer and other accounts read nothing', async () => {
    const { order } = await o.shipAt('p-rls', 'at_destination')
    const read = async (a: typeof w.logi) => ((await a.client.from('order_shipments').select('pickup_state').eq('order_id', order)).data ?? []) as Array<{ pickup_state: string }>
    expect(await read(w.logi)).toEqual([{ pickup_state: 'waiting_pickup' }])
    expect(await read(w.sup)).toEqual([{ pickup_state: 'waiting_pickup' }])
    for (const a of [w.comm, w.viewer, w.foreign]) expect(await read(a)).toEqual([])
    // the browser can not write the condition
    expect((await w.logi.client.from('order_shipments').update({ pickup_state: 'abandoned' }).eq('order_id', order).select('id')).data ?? []).toHaveLength(0)
    expect(await o.shipment(order)).toMatchObject({ pickup_state: 'waiting_pickup' })
    // the clock helpers of the suite are consistent
    expect(at(60)).toBe('2026-12-01T16:00:00.000Z')
  })
})
