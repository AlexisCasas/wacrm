// @vitest-environment node
/**
 * PR-05C · (1) AUDIT of PR-03's manual "Derivar a Comercial" (it already exists and is not rebuilt) and (2) the durable automatic return Logistica -> Comercial
 * 10 minutes after the canonical "pedido completamente finalizado" signal. REAL local stack. Skipped unless LOCAL_URL is set. LOCAL ONLY.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createWorld, QA_ENABLED, type QaWorld } from '@/lib/orders/logistics/test-support/qa-env'
import { runFinalizedReturn } from '@/lib/conversations/finalized-return'
import { setShipmentFlag } from '@/lib/orders/shalom/test-support/ready-order'
import { shalomOps } from '@/lib/orders/shalom/test-support/shalom-ops'

let w: QaWorld
let o: ReturnType<typeof shalomOps>
const T = Date.parse('2027-01-10T15:00:00Z')
const at = (min: number) => new Date(T + min * 60_000)
const iso = (min: number) => at(min).toISOString()

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const routing = async (conv: string) => ((await w.admin.from('conversation_routing').select('*').eq('conversation_id', conv).maybeSingle()).data ?? null) as Row | null
const events = async (conv: string) => ((await w.admin.from('conversation_routing_events').select('*').eq('conversation_id', conv).order('created_at')).data ?? []) as Row[]
const fin = async (order: string) => ((await w.admin.from('order_finalizations').select('*').eq('order_id', order).single()).data ?? {}) as Row
const mark = (order: string, minute = 0, acc = w.acc) => w.admin.rpc('mark_order_finalized', { p_account: acc, p_order: order, p_source: 'qa_simulation', p_actor: null, p_now: iso(minute) })
const tick = (minute: number) => runFinalizedReturn(w.admin, { now: at(minute), graceMinutes: 10 })

/** An order whose conversation is in the LOGISTICS stage, with a little history. */
async function scenario(label: string) {
  const order = await o.ready(label)
  const conv = ((await w.admin.from('order_confirmations').select('conversation_id').eq('id', order).single()).data as { conversation_id: string }).conversation_id
  const r = await w.admin.from('conversation_routing').insert({ conversation_id: conv, account_id: w.acc, stage: 'logistics', version: 1 })
  if (r.error) throw r.error
  const m = await w.admin.from('messages').insert([
    { conversation_id: conv, sender_type: 'customer', content_type: 'text', content_text: 'Hola, ya pagué', status: 'delivered' },
    { conversation_id: conv, sender_type: 'agent', content_type: 'text', content_text: 'Recibido, embalamos', status: 'sent' },
  ])
  if (m.error) throw m.error
  return { order, conv }
}
const messageIds = async (conv: string) => (((await w.admin.from('messages').select('id').eq('conversation_id', conv).order('id')).data ?? []) as Array<{ id: string }>).map((x) => x.id)
const canSee = async (a: typeof w.logi, conv: string) => ((await a.client.from('conversations').select('id').eq('id', conv)).data ?? []).length === 1
const derive = (a: typeof w.logi, conv: string) => a.client.rpc('derive_conversation_to_commercial', { p_conversation_id: conv })

vi.setConfig({ testTimeout: 40_000, hookTimeout: 120_000 })

describe.skipIf(!QA_ENABLED)('PR-05C · routing return after "pedido completamente finalizado"', () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.LOCAL_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.LOCAL_SERVICE
    w = await createWorld()
    o = shalomOps(w)
    await setShipmentFlag(w, w.acc, true)
  }, 120_000)
  afterAll(async () => {
    if (w) await w.dispose()
  }, 90_000)

  // ------------------------------------------------------------------------------------------------------------------------ the existing manual button
  describe('manual "Derivar a Comercial" (PR-03, audited, NOT rebuilt)', () => {
    it('Logistica derives IMMEDIATELY: same conversation, same history, Comercial now sees it, Logistica keeps it (shared); audit has the human actor', async () => {
      const { conv } = await scenario('manual')
      const before = await messageIds(conv)
      expect(await canSee(w.comm, conv)).toBe(false)
      expect(await canSee(w.logi, conv)).toBe(true)
      const r = await derive(w.logi, conv)
      expect(r.error).toBeNull()
      expect(r.data).toEqual([{ stage: 'shared', changed: true }])
      expect(await routing(conv)).toMatchObject({ stage: 'shared', version: 2, updated_by: w.logi.id })
      expect(await canSee(w.comm, conv)).toBe(true) // the same conversation_id is now Comercial's too
      expect(await canSee(w.logi, conv)).toBe(true)
      expect(await messageIds(conv)).toEqual(before) // history untouched
      const ev = (await events(conv)).filter((e) => e.reason === 'derived_to_commercial')
      expect(ev).toHaveLength(1)
      expect(ev[0]).toMatchObject({ from_stage: 'logistics', to_stage: 'shared', actor_user_id: w.logi.id })
      // idempotent: a second click / another operator = no change, no event
      expect(((await derive(w.logi, conv)).data as Row[])[0]).toMatchObject({ stage: 'shared', changed: false })
      expect(((await derive(w.sup, conv)).data as Row[])[0]).toMatchObject({ changed: false })
      expect((await events(conv)).filter((e) => e.reason === 'derived_to_commercial')).toHaveLength(1)
    })

    it('does not touch the order or its logistics (routing and order state are independent)', async () => {
      const { order, conv } = await scenario('independent')
      const a = await w.admin.from('order_logistics').select('status, updated_at').eq('order_id', order).single()
      await derive(w.logi, conv)
      const b = await w.admin.from('order_logistics').select('status, updated_at').eq('order_id', order).single()
      expect(b.data).toEqual(a.data)
      expect((await w.admin.from('order_confirmations').select('delivery_status').eq('id', order).single()).data).toMatchObject({ delivery_status: 'held' })
    })

    it('permissions: Supervisor yes; Commercial, viewer and another account NO; it needs the logistics stage', async () => {
      const a = await scenario('perm-a')
      expect((await derive(w.comm, a.conv)).error?.code).toBe('42501')
      expect((await derive(w.viewer, a.conv)).error?.code).toBe('42501')
      expect((await derive(w.foreign, a.conv)).error?.code).toBe('42501')
      expect((await routing(a.conv))?.stage).toBe('logistics')
      expect(((await derive(w.sup, a.conv)).data as Row[])[0]).toMatchObject({ stage: 'shared', changed: true })
      // a commercial-stage chat is not derived (nothing to hand over)
      const c = await o.ready('perm-c')
      const conv = ((await w.admin.from('order_confirmations').select('conversation_id').eq('id', c).single()).data as { conversation_id: string }).conversation_id
      expect((await derive(w.logi, conv)).error?.code).toBe('22023')
    })
  })

  // ------------------------------------------------------------------------------------------------------------------------ the automatic return
  describe('automatic return (order_finalized_at + 10 min)', () => {
    it('caso 2/3: +9 min stays logistics; exactly +10 min returns to commercial (SYSTEM, same conversation / history), and Comercial now sees it, Logistica no longer', async () => {
      const { order, conv } = await scenario('auto')
      const before = await messageIds(conv)
      expect((await mark(order, 0)).data).toMatchObject({ ok: true, created: true })
      expect(await fin(order)).toMatchObject({ return_state: 'pending', routing_stage_at: 'logistics', routing_version_at: 1 })
      expect(await tick(9)).toMatchObject({ returned: 0 })
      expect((await routing(conv))?.stage).toBe('logistics')
      expect(await canSee(w.comm, conv)).toBe(false)
      expect(await tick(10)).toMatchObject({ returned: 1, errors: 0 })
      expect(await routing(conv)).toMatchObject({ stage: 'commercial', version: 2, updated_by: null })
      expect(await canSee(w.comm, conv)).toBe(true)
      expect(await canSee(w.logi, conv)).toBe(false)
      expect(await messageIds(conv)).toEqual(before) // not copied, not moved, not hidden
      expect(await fin(order)).toMatchObject({ return_state: 'returned' })
      const ev = (await events(conv)).filter((e) => e.reason === 'order_finalized_grace_elapsed')
      expect(ev).toHaveLength(1)
      expect(ev[0]).toMatchObject({ from_stage: 'logistics', to_stage: 'commercial', actor_user_id: null, actor_name: 'system', order_id: order })
      // the order itself is untouched
      expect((await w.admin.from('order_confirmations').select('delivery_status').eq('id', order).single()).data).toMatchObject({ delivery_status: 'held' })
    })

    it('caso 4: many later ticks = ONE transition, ONE event', async () => {
      const { order, conv } = await scenario('idem')
      await mark(order, 0)
      for (const m of [10, 11, 12, 30, 600]) await tick(m)
      expect((await events(conv)).filter((e) => e.reason === 'order_finalized_grace_elapsed')).toHaveLength(1)
      expect(await routing(conv)).toMatchObject({ stage: 'commercial', version: 2 })
    })

    it('two workers at the same moment = ONE application', async () => {
      const made = []
      for (const l of ['c1', 'c2', 'c3']) {
        const s = await scenario(l)
        await mark(s.order, 0)
        made.push(s)
      }
      const [a, b] = await Promise.all([tick(10), tick(10)])
      expect(a.returned + b.returned).toBeGreaterThanOrEqual(3)
      for (const s of made) {
        expect((await events(s.conv)).filter((e) => e.reason === 'order_finalized_grace_elapsed')).toHaveLength(1)
        expect((await routing(s.conv))?.version).toBe(2)
      }
    })

    it('caso 5: Logistica derives at +5, the cron at +10 does NOT make a second transition and does not undo it', async () => {
      const { order, conv } = await scenario('manual-first')
      await mark(order, 0)
      await derive(w.logi, conv)
      await tick(10)
      expect(await routing(conv)).toMatchObject({ stage: 'shared', version: 2 })
      expect((await events(conv)).map((e) => e.reason)).toEqual(['derived_to_commercial'])
      expect(await fin(order)).toMatchObject({ return_state: 'skipped_not_logistics' })
    })

    it('caso 6: a later HUMAN routing decision is never overwritten (stage changed, or the version moved while still logistics)', async () => {
      const a = await scenario('human-stage')
      await mark(a.order, 0)
      await w.admin.from('conversation_routing').update({ stage: 'shared', version: 2, updated_by: w.sup.id }).eq('conversation_id', a.conv)
      await tick(10)
      expect(await routing(a.conv)).toMatchObject({ stage: 'shared', version: 2 })
      expect(await fin(a.order)).toMatchObject({ return_state: 'skipped_not_logistics' })

      // a NEW order was confirmed after finalization: the chat is logistics AGAIN but with a newer version -> the old signal must not return it
      const b = await scenario('human-version')
      await mark(b.order, 0)
      await w.admin.from('conversation_routing').update({ stage: 'shared', version: 2 }).eq('conversation_id', b.conv)
      await w.admin.from('conversation_routing').update({ stage: 'logistics', version: 3 }).eq('conversation_id', b.conv)
      await tick(10)
      expect(await routing(b.conv)).toMatchObject({ stage: 'logistics', version: 3 })
      expect(await fin(b.order)).toMatchObject({ return_state: 'skipped_routing_changed' })
      expect((await events(b.conv)).filter((e) => e.reason === 'order_finalized_grace_elapsed')).toEqual([])
    })

    it('caso 7: durable — nothing in memory: a brand new client / process applies it later (the "restart")', async () => {
      const { order, conv } = await scenario('restart')
      await mark(order, 0)
      expect(await tick(3)).toMatchObject({ returned: 0 })
      // "restart": a fresh service-role client, as a new app process would build; time moves on
      const { createClient } = await import('@supabase/supabase-js')
      const fresh = createClient(process.env.LOCAL_URL as string, process.env.LOCAL_SERVICE as string, { auth: { persistSession: false } })
      expect(await runFinalizedReturn(fresh, { now: at(45), graceMinutes: 10 })).toMatchObject({ returned: 1 })
      expect((await routing(conv))?.stage).toBe('commercial')
    })

    it('a correction BEFORE the time cancels the automation; declaring it again restarts the clock', async () => {
      const { order, conv } = await scenario('clear')
      await mark(order, 0)
      expect((await w.admin.rpc('clear_order_finalized', { p_account: w.acc, p_order: order, p_reason: 'qa_correction', p_now: iso(5) })).data).toMatchObject({ ok: true, changed: true })
      await tick(10)
      expect((await routing(conv))?.stage).toBe('logistics')
      expect(await fin(order)).toMatchObject({ return_state: 'skipped_cleared' })
      expect((await mark(order, 20)).data).toMatchObject({ reopened: true })
      expect(await tick(29)).toMatchObject({ returned: 0 })
      expect(await tick(30)).toMatchObject({ returned: 1 })
      expect((await routing(conv))?.stage).toBe('commercial')
      // once applied it can neither be cleared nor re-declared
      expect((await w.admin.rpc('clear_order_finalized', { p_account: w.acc, p_order: order, p_now: iso(40) })).data).toMatchObject({ ok: false, reason: 'already_resolved' })
      expect((await mark(order, 50)).data).toMatchObject({ created: false, return_state: 'returned' })
    })

    it('the signal is idempotent (first declaration wins) and a conversation-less order is a recorded NO-OP', async () => {
      const { order } = await scenario('first-wins')
      await mark(order, 0)
      await mark(order, 5)
      expect((await fin(order)).finalized_at).toBe(iso(0).replace('.000Z', '+00:00'))
      const bare = await w.mkOrder(w.acc, `bare-${Date.now()}`)
      await mark(bare, 0)
      await tick(10)
      expect(await fin(bare)).toMatchObject({ return_state: 'skipped_no_conversation' })
    })

    it('an order is always independent of Shalom / pickup: nothing in the shipment changes', async () => {
      const s = await o.shipAt('shalom', 'at_destination', { destinationAt: '2026-12-01T15:00:00Z' })
      const conv = ((await w.admin.from('order_confirmations').select('conversation_id').eq('id', s.order).single()).data as { conversation_id: string }).conversation_id
      await w.admin.from('conversation_routing').insert({ conversation_id: conv, account_id: w.acc, stage: 'logistics', version: 1 })
      const before = await o.shipment(s.order)
      await mark(s.order, 0)
      await tick(10)
      expect((await routing(conv))?.stage).toBe('commercial')
      const after = await o.shipment(s.order)
      for (const k of ['logistic_status', 'tracking_state', 'pickup_state', 'destination_episode', 'identifier_version']) expect(after[k]).toBe(before[k])
    })
  })

  // ------------------------------------------------------------------------------------------------------------------------ security
  describe('security', () => {
    it('caso 8 / cross-account: other accounts and browsers can neither declare, read nor write the signal; the functions are service-role only', async () => {
      const { order, conv } = await scenario('sec')
      await mark(order, 0)
      expect((await mark(order, 0, w.accForeign)).error?.code).toBe('42501') // the order is not that account's
      for (const a of [w.logi, w.sup, w.comm, w.viewer, w.foreign]) {
        expect((await a.client.from('order_finalizations').select('order_id').eq('order_id', order)).data ?? []).toEqual([])
        expect((await a.client.from('order_finalizations').insert({ order_id: order, account_id: w.acc, finalized_at: iso(0), source: 'x' })).error).not.toBeNull()
        expect((await a.client.from('order_finalizations').update({ return_state: 'returned' }).eq('order_id', order).select('order_id')).data ?? []).toEqual([])
        for (const fn of ['mark_order_finalized', 'clear_order_finalized', 'return_finalized_conversations']) expect((await a.client.rpc(fn, {})).error).not.toBeNull()
        expect((await a.client.from('conversation_routing').update({ stage: 'commercial' }).eq('conversation_id', conv).select('conversation_id')).data ?? []).toEqual([])
      }
      expect((await routing(conv))?.stage).toBe('logistics')
      // another account's pending signal is evaluated only against ITS OWN routing: nothing leaks across accounts
      expect((await w.admin.from('conversation_routing').select('conversation_id').eq('account_id', w.accForeign).eq('conversation_id', conv)).data).toEqual([])
    })

    it('the audit reason is shaped (system only, logistics -> commercial) and the finalization rows are protected', async () => {
      const { order, conv } = await scenario('shape')
      const bad = await w.admin.from('conversation_routing_events').insert({ account_id: w.acc, conversation_id: conv, from_stage: 'logistics', to_stage: 'commercial', reason: 'order_finalized_grace_elapsed', actor_user_id: w.logi.id, actor_name: 'x', order_id: order })
      expect(bad.error?.code).toBe('23514')
      await mark(order, 0)
      expect((await w.admin.from('order_finalizations').update({ account_id: w.accForeign }).eq('order_id', order)).error?.code).toBe('42501')
      expect((await w.admin.from('order_finalizations').delete().eq('order_id', order)).error?.code).toBe('42501')
      await tick(10)
      expect((await w.admin.from('order_finalizations').update({ return_state: 'pending', return_at: null }).eq('order_id', order)).error?.code).toBe('42501')
    })

    it('flag OFF: no signal can be declared and nothing returns', async () => {
      const { order, conv } = await scenario('flag')
      await w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: false }).eq('account_id', w.acc)
      try {
        expect((await mark(order, 0)).error?.code).toBe('42501')
      } finally {
        await w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: true }).eq('account_id', w.acc)
      }
      await mark(order, 0)
      await w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: false }).eq('account_id', w.acc)
      try {
        await tick(60)
        expect((await routing(conv))?.stage).toBe('logistics')
      } finally {
        await w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: true }).eq('account_id', w.acc)
      }
      await tick(60)
      expect((await routing(conv))?.stage).toBe('commercial')
    })
  })

  afterAll(() => undefined)
})
