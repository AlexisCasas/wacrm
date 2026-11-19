// @vitest-environment node
/**
 * PR-05A · the day-15 CUSTOMER MESSAGE against the REAL local stack: due once per episode (ledger), sent through the EXISTING send core (same conversation),
 * failed / uncertain / skipped handling, retries without duplicates, two workers, the switches, roles and cross-account. WhatsApp is never reached:
 * either an injected fake send (fast) or the real send core with only `sendTemplateMessage` mocked (to prove the message lands in the order's conversation).
 * Skipped unless LOCAL_URL is set. LOCAL ONLY (see logistics/test-support/qa-env).
 *
 *   eval "$(npx supabase status -o env | sed 's/^/export /')"; LOCAL_URL=$API_URL LOCAL_ANON=$ANON_KEY LOCAL_SERVICE=$SERVICE_ROLE_KEY npx vitest run src/lib/orders/shalom/customer-message.qa.test.ts
 */
import { randomBytes } from 'node:crypto'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const meta = vi.hoisted(() => ({ impl: null as null | (() => Promise<{ messageId: string }>), calls: [] as Array<Record<string, unknown>> }))
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/meta-api')>()
  return {
    ...actual,
    sendTemplateMessage: async (args: Record<string, unknown>) => {
      meta.calls.push(args)
      if (!meta.impl) throw new Error('Meta mock not configured')
      return meta.impl()
    },
  }
})

import { createWorld, QA_ENABLED, type QaWorld } from '@/lib/orders/logistics/test-support/qa-env'
import { readShalomConfig } from '@/lib/orders/shalom/config'
import { processCustomerMessages, resolveCustomerMessage, retryCustomerMessage, type SendFn } from '@/lib/orders/shalom/customer-message'
import { runShalomTick } from '@/lib/orders/shalom/poller'
import { createFakeProvider } from '@/lib/orders/shalom/providers'
import { acquireQaLock, releaseQaLock } from '@/lib/orders/shalom/test-support/qa-lock'
import { clearCredentialsBreaker, setShipmentFlag } from '@/lib/orders/shalom/test-support/ready-order'
import { at, shalomOps } from '@/lib/orders/shalom/test-support/shalom-ops'
import { encrypt } from '@/lib/whatsapp/encryption'
import { SendMessageError } from '@/lib/whatsapp/send-message'

let w: QaWorld
let o: ReturnType<typeof shalomOps>
const TEMPLATE = 'qa_pendiente_recojo'
const CFG = readShalomConfig({ SHALOM_CONFIG_JSON: JSON.stringify({ messageMaxAttempts: 2, messageBackoffMinutes: [5, 15], batchSize: 50 }) })
const ARRIVAL = '2026-11-01T15:00:00Z' // long ago: every evaluation is past day 15
const NOW = at(0)

let sendCalls: Array<{ conversationId: string; templateName?: string; params?: string[] }> = []
let sendImpl: () => Promise<{ messageId: string; whatsappMessageId: string }> = async () => ({ messageId: 'row-x', whatsappMessageId: `wamid.${randomBytes(4).toString('hex')}` })
const fakeSend: SendFn = async (_db, _acc, p) => {
  sendCalls.push({ conversationId: p.conversationId, templateName: p.templateName ?? undefined, params: p.templateParams })
  const r = await sendImpl()
  // the persisted message row id must be a real messages.id for the ledger FK: use NULL-safe fake by inserting nothing and returning an unknown id is not allowed
  return { messageId: r.messageId, whatsappMessageId: r.whatsappMessageId }
}
const sendOk = () => { sendImpl = async () => ({ messageId: '', whatsappMessageId: `wamid.${randomBytes(4).toString('hex')}` }) }
const metaRejected = () => { sendImpl = async () => { throw new SendMessageError('meta_error', 'Template rejected by Meta', 502) } }
const metaLost = () => { sendImpl = async () => { throw new SendMessageError('meta_error', 'fetch failed', 502) } }

const deps = (over: Record<string, unknown> = {}) => ({ cfg: CFG, now: () => new Date(clockMs), sendMessage: fakeSend, ...over }) as never
let clockMs = Date.parse(NOW)
const advanceMin = (m: number) => { clockMs += m * 60_000 }
const messageOf = async (order: string) => ((await w.admin.from('order_shipment_messages').select('*').eq('order_id', order)).data ?? []) as Array<Record<string, any>> // eslint-disable-line @typescript-eslint/no-explicit-any
const evaluate = (nowIso: string) => w.admin.rpc('evaluate_pickup_day15', { p_now: nowIso, p_days: 15 })

/** An order En destino for a long time, with its message already DUE (ledger row created). */
async function due(label: string) {
  const { order } = await o.shipAt(label, 'at_destination', { destinationAt: ARRIVAL })
  expect(((await evaluate(NOW)).data as { messages_due: number }).messages_due).toBeGreaterThanOrEqual(1)
  const [msg] = await messageOf(order)
  expect(msg).toMatchObject({ status: 'pending', destination_episode: 1 })
  return { order, msg }
}

vi.setConfig({ testTimeout: 40_000, hookTimeout: 120_000 })

describe.skipIf(!QA_ENABLED)('PR-05A customer message at day 15 En destino', () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.LOCAL_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.LOCAL_SERVICE
    await acquireQaLock()
    w = await createWorld()
    o = shalomOps(w)
    await setShipmentFlag(w, w.acc, true)
    await setShipmentFlag(w, w.accForeign, true)
    const s = await w.admin.from('order_shipment_settings').update({ destination_customer_message_enabled: true, customer_message_template_name: TEMPLATE, customer_message_template_language: 'es', customer_message_template_params: ['customer_name'] }).eq('account_id', w.acc)
    if (s.error) throw s.error
    const cfg = await w.admin.from('whatsapp_config').insert({ user_id: w.owner.id, account_id: w.acc, phone_number_id: '100000000000777', waba_id: '200000000000777', access_token: encrypt('qa-token-not-real'), status: 'connected' })
    if (cfg.error) throw cfg.error
    const tpl = await w.admin.from('message_templates').insert({ user_id: w.owner.id, account_id: w.acc, name: TEMPLATE, category: 'Utility', language: 'es', body_text: 'Hola {{1}}, tu pedido continúa pendiente de recojo en la agencia de destino.', status: 'APPROVED' })
    if (tpl.error) throw tpl.error
  }, 120_000)
  beforeEach(async () => {
    // the suite shares one account: park rows left by earlier tests so a tick only touches the message under test
    await w.admin.from('order_shipment_messages').update({ next_attempt_at: '2999-01-01T00:00:00Z' }).eq('account_id', w.acc).in('status', ['pending', 'failed'])
  })
  afterEach(() => {
    sendCalls = []
    sendOk()
    meta.calls.length = 0
    meta.impl = null
    clockMs = Date.parse(NOW)
  })
  afterAll(async () => {
    if (w) {
      await w.dispose()
      await clearCredentialsBreaker(w)
    }
    releaseQaLock()
  }, 90_000)

  // ------------------------------------------------------------------------------------------------------------------ day 14 / day 15
  describe('when it becomes due', () => {
    it('day 14: no state change, no ledger row; day 15 (America/Lima): alerted_15d + ONE ledger row + ONE due event; repeated evaluations never duplicate', async () => {
      const arrival = '2026-12-01T15:00:00Z'
      const { order } = await o.shipAt('d15', 'at_destination', { destinationAt: arrival, finishedAt: arrival })
      const lima0 = Date.UTC(2026, 11, 1) + 5 * 3_600_000
      const day15 = new Date(lima0 + 15 * 86_400_000).toISOString()
      const day14End = new Date(lima0 + 15 * 86_400_000 - 60_000).toISOString()
      expect((await evaluate(day14End)).data).toMatchObject({ alerted: 0, messages_due: 0 })
      expect(await o.shipment(order)).toMatchObject({ pickup_state: 'waiting_pickup' })
      expect(await messageOf(order)).toEqual([])
      expect((await evaluate(day15)).data).toMatchObject({ alerted: 1, messages_due: 1 })
      expect(await o.shipment(order)).toMatchObject({ pickup_state: 'alerted_15d', logistic_status: 'at_destination' })
      expect((await o.shipment(order)).pickup_alerted_at).toBeTruthy()
      for (let i = 0; i < 3; i += 1) expect((await evaluate(new Date(Date.parse(day15) + i * 900_000).toISOString())).data).toMatchObject({ alerted: 0, messages_due: 0 })
      expect(await messageOf(order)).toHaveLength(1)
      expect(await o.count(order, 'destination_customer_message_due')).toBe(1)
      const [m] = await messageOf(order)
      expect(m).toMatchObject({ kind: 'destination_15d_customer', template_name: TEMPLATE, template_language: 'es', status: 'pending', attempt: 0 })
      // same conversation as the order
      const conv = (await w.admin.from('order_confirmations').select('conversation_id').eq('id', order).single()).data as { conversation_id: string }
      expect(m.conversation_id).toBe(conv.conversation_id)
    })

    it('the INTERNAL alert is a separate mechanism: it still fires once, is not duplicated by the message evaluation, and does not depend on it', async () => {
      const { order } = await o.shipAt('alert', 'at_destination', { destinationAt: ARRIVAL })
      await w.admin.rpc('evaluate_destination_alerts', { p_now: at(10), p_days: 15 })
      await evaluate(at(10))
      await w.admin.rpc('evaluate_destination_alerts', { p_now: at(20), p_days: 15 })
      await evaluate(at(20))
      expect((await w.admin.from('order_shipment_alerts').select('id').eq('order_id', order)).data).toHaveLength(1)
      expect(await messageOf(order)).toHaveLength(1)
      expect(await o.count(order, 'alert_created')).toBe(1)
    })

    it('message switch OFF: the pickup still reaches alerted_15d, NO ledger row exists; turning it ON later (still En destino) makes it due once', async () => {
      await w.admin.from('order_shipment_settings').update({ destination_customer_message_enabled: false }).eq('account_id', w.acc)
      const { order } = await o.shipAt('switch', 'at_destination', { destinationAt: ARRIVAL })
      expect((await evaluate(at(10))).data).toMatchObject({ alerted: 1, messages_due: 0 })
      expect(await o.shipment(order)).toMatchObject({ pickup_state: 'alerted_15d' })
      expect(await messageOf(order)).toEqual([])
      expect((await processCustomerMessages(w.admin, deps())).claimed).toBe(0)
      await w.admin.from('order_shipment_settings').update({ destination_customer_message_enabled: true }).eq('account_id', w.acc)
      expect(((await evaluate(at(20))).data as { messages_due: number }).messages_due).toBeGreaterThanOrEqual(1)
      expect((await evaluate(at(30))).data).toMatchObject({ messages_due: 0 })
      expect(await messageOf(order)).toHaveLength(1)
    })

    it('needs BOTH flags: with shalom_tracking_enabled OFF nothing is evaluated for the account', async () => {
      const { order } = await o.shipAt('flags', 'at_destination', { destinationAt: ARRIVAL })
      await setShipmentFlag(w, w.acc, false)
      expect((await evaluate(at(10))).data).toMatchObject({ alerted: 0, messages_due: 0 })
      await setShipmentFlag(w, w.acc, true)
      await w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: false }).eq('account_id', w.acc)
      expect((await evaluate(at(10))).data).toMatchObject({ alerted: 0, messages_due: 0 })
      await w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: true }).eq('account_id', w.acc)
      expect(await messageOf(order)).toEqual([])
      expect((await evaluate(at(10))).data).toMatchObject({ alerted: 1, messages_due: 1 })
    })

    it('a NEW episode (guide correction + arriving again) gets its own message; the previous one stays as history', async () => {
      const { order } = await due('episode')
      await w.admin.rpc('correct_order_shipment_identifier', { p_account: w.acc, p_actor: w.sup.id, p_order: order, p_number: '88888888', p_code: 'ZZ11', p_now: at(20) })
      const [c] = await o.claim(at(21), order)
      await o.apply(c, { p_normalized: 'at_destination', p_destination_at: ARRIVAL, p_started_at: at(21), p_finished_at: at(22), p_raw_hash: 'again' })
      expect((await evaluate(at(30))).data).toMatchObject({ alerted: 1, messages_due: 1 })
      const rows = await messageOf(order)
      expect(rows.map((r) => r.destination_episode).sort()).toEqual([1, 2])
    })
  })

  // ------------------------------------------------------------------------------------------------------------------ sending
  describe('sending (through the existing send core)', () => {
    it('SUCCESS: sent once, into the order conversation with the configured template and variables; a second tick does NOT send again', async () => {
      const { order } = await due('ok')
      const r1 = await processCustomerMessages(w.admin, deps())
      expect(r1).toMatchObject({ claimed: 1, sent: 1, failed: 0, uncertain: 0, errors: 0 })
      expect(sendCalls).toHaveLength(1)
      expect(sendCalls[0]).toMatchObject({ templateName: TEMPLATE })
      expect(sendCalls[0].params).toHaveLength(1)
      const conv = (await w.admin.from('order_confirmations').select('conversation_id').eq('id', order).single()).data as { conversation_id: string }
      expect(sendCalls[0].conversationId).toBe(conv.conversation_id)
      expect((await messageOf(order))[0]).toMatchObject({ status: 'sent', attempt: 1, claim_token: null, error_code: null })
      expect((await messageOf(order))[0].wamid).toBeTruthy()
      advanceMin(60)
      for (let i = 0; i < 3; i += 1) expect((await processCustomerMessages(w.admin, deps())).claimed).toBe(0)
      expect(sendCalls).toHaveLength(1)
      expect(await o.count(order, 'destination_customer_message_sent')).toBe(1)
      // the Shalom side is untouched
      expect(await o.shipment(order)).toMatchObject({ logistic_status: 'at_destination', tracking_state: 'active', pickup_state: 'alerted_15d' })
    })

    it('real send core: the message is persisted in the SAME conversation (history), as a template message; no chat is created', async () => {
      const { order } = await due('core')
      meta.impl = async () => ({ messageId: `wamid.${randomBytes(6).toString('hex')}` })
      const conv = (await w.admin.from('order_confirmations').select('conversation_id').eq('id', order).single()).data as { conversation_id: string }
      const before = (await w.admin.from('conversations').select('id', { count: 'exact', head: true }).eq('account_id', w.acc)).count
      const r = await processCustomerMessages(w.admin, { cfg: CFG, now: () => new Date(clockMs) })
      expect(r).toMatchObject({ sent: 1, failed: 0, uncertain: 0 })
      expect(meta.calls).toHaveLength(1)
      const { data: msgs } = await w.admin.from('messages').select('id, content_type, template_name, sender_type, message_id').eq('conversation_id', conv.conversation_id)
      expect(msgs).toHaveLength(1)
      expect(msgs![0]).toMatchObject({ content_type: 'template', template_name: TEMPLATE })
      expect((await w.admin.from('conversations').select('id', { count: 'exact', head: true }).eq('account_id', w.acc)).count).toBe(before)
      const [m] = await messageOf(order)
      expect(m).toMatchObject({ status: 'sent', message_row_id: msgs![0].id, wamid: msgs![0].message_id })
    })

    it('FAILED (Meta rejects): the shipment is untouched, the internal alert still exists, the failure is visible; the automatic retry waits for its backoff and sends ONCE', async () => {
      const { order } = await due('failed')
      await w.admin.rpc('evaluate_destination_alerts', { p_now: at(10), p_days: 15 })
      metaRejected()
      const r1 = await processCustomerMessages(w.admin, deps())
      expect(r1).toMatchObject({ claimed: 1, failed: 1, sent: 0 })
      let [m] = await messageOf(order)
      expect(m).toMatchObject({ status: 'failed', attempt: 1, error_code: 'meta_rejected' })
      expect(Date.parse(m.next_attempt_at)).toBe(clockMs + 5 * 60_000)
      expect(await o.shipment(order)).toMatchObject({ logistic_status: 'at_destination', tracking_state: 'active', pickup_state: 'alerted_15d' }) // tracking independent
      expect((await w.admin.from('order_shipment_alerts').select('status').eq('order_id', order)).data).toEqual([{ status: 'open' }])
      expect(await o.count(order, 'destination_customer_message_failed')).toBe(1)
      // not yet due again
      expect((await processCustomerMessages(w.admin, deps())).claimed).toBe(0)
      advanceMin(6)
      sendOk()
      expect(await processCustomerMessages(w.admin, deps())).toMatchObject({ claimed: 1, sent: 1 })
      ;[m] = await messageOf(order)
      expect(m).toMatchObject({ status: 'sent', attempt: 2 })
      expect(sendCalls).toHaveLength(2) // one failed attempt + one success: never two successes
      advanceMin(600)
      expect((await processCustomerMessages(w.admin, deps())).claimed).toBe(0)
    })

    it('automatic attempts are bounded; after them only a PERSON can retry (controlled retry, no duplicate)', async () => {
      const { order } = await due('bounded')
      metaRejected()
      await processCustomerMessages(w.admin, deps())
      advanceMin(6)
      await processCustomerMessages(w.admin, deps())
      let [m] = await messageOf(order)
      expect(m).toMatchObject({ status: 'failed', attempt: 2, next_attempt_at: null }) // 2 = messageMaxAttempts of this suite
      advanceMin(1000)
      expect((await processCustomerMessages(w.admin, deps())).claimed).toBe(0)
      // a person retries
      sendOk()
      const retried = await retryCustomerMessage(w.ctxOf(w.logi, w.acc), w.admin, m.id, new Date(clockMs))
      expect(retried).toMatchObject({ ok: true, body: { queued: true } })
      expect((await messageOf(order))[0].status).toBe('pending')
      expect(await retryCustomerMessage(w.ctxOf(w.logi, w.acc), w.admin, m.id, new Date(clockMs))).toMatchObject({ ok: false, status: 409, error: 'not_failed' })
      expect(await processCustomerMessages(w.admin, deps())).toMatchObject({ claimed: 1, sent: 1 })
      ;[m] = await messageOf(order)
      expect(m).toMatchObject({ status: 'sent', attempt: 3 })
      expect(await o.count(order, 'destination_customer_message_retry_requested')).toBe(1)
    })

    it('configuration problems (template missing / not approved) are failures that wait for a person, never a crash, never an automatic loop', async () => {
      const { order } = await due('config')
      await w.admin.from('message_templates').update({ status: 'PAUSED' }).eq('account_id', w.acc).eq('name', TEMPLATE)
      try {
        expect(await processCustomerMessages(w.admin, deps())).toMatchObject({ claimed: 1, failed: 1 })
        expect((await messageOf(order))[0]).toMatchObject({ status: 'failed', error_code: 'template_not_approved', next_attempt_at: null })
        expect(sendCalls).toHaveLength(0)
      } finally {
        await w.admin.from('message_templates').update({ status: 'APPROVED' }).eq('account_id', w.acc).eq('name', TEMPLATE)
      }
    })

    it('UNCERTAIN (the outcome is unknown): never re-sent automatically; a person resolves it; roles enforced', async () => {
      const { order } = await due('uncertain')
      metaLost()
      expect(await processCustomerMessages(w.admin, deps())).toMatchObject({ claimed: 1, uncertain: 1 })
      let [m] = await messageOf(order)
      expect(m).toMatchObject({ status: 'uncertain', error_code: 'meta_unreachable' })
      expect(await o.shipment(order)).toMatchObject({ logistic_status: 'at_destination', tracking_state: 'active' }) // tracking continues
      sendOk()
      advanceMin(24 * 60)
      for (let i = 0; i < 3; i += 1) expect((await processCustomerMessages(w.admin, deps())).claimed).toBe(0)
      expect(sendCalls).toHaveLength(1) // no automatic resend, ever
      // a retry is not the way out of uncertain
      expect(await retryCustomerMessage(w.ctxOf(w.logi, w.acc), w.admin, m.id)).toMatchObject({ ok: false, error: 'needs_resolution' })
      // only operators resolve
      for (const actor of [w.comm, w.viewer]) expect(await resolveCustomerMessage(w.ctxOf(actor, w.acc), w.admin, m.id, 'confirmed_sent')).toMatchObject({ ok: false, status: 404 })
      expect(await resolveCustomerMessage(w.ctxOf(w.foreign, w.accForeign), w.admin, m.id, 'confirmed_sent')).toMatchObject({ ok: false, status: 404 })
      expect(await resolveCustomerMessage(w.ctxOf(w.logi, w.acc), w.admin, m.id, 'maybe')).toMatchObject({ ok: false, status: 400 })
      expect(await resolveCustomerMessage(w.ctxOf(w.sup, w.acc), w.admin, m.id, 'confirmed_not_sent', new Date(clockMs))).toMatchObject({ ok: true, body: { status: 'failed' } })
      ;[m] = await messageOf(order)
      expect(m).toMatchObject({ status: 'failed', resolution: 'confirmed_not_sent', resolved_by: w.sup.id, next_attempt_at: null })
      expect((await processCustomerMessages(w.admin, deps())).claimed).toBe(0) // still no automatic send
      expect(await resolveCustomerMessage(w.ctxOf(w.sup, w.acc), w.admin, m.id, 'confirmed_sent')).toMatchObject({ ok: false, status: 409, error: 'not_uncertain' })
    })

    it('UNCERTAIN resolved as "was delivered" closes it as sent (no resend)', async () => {
      const { order } = await due('uncertain-sent')
      metaLost()
      await processCustomerMessages(w.admin, deps())
      const [m] = await messageOf(order)
      expect(await resolveCustomerMessage(w.ctxOf(w.logi, w.acc), w.admin, m.id, 'confirmed_sent', new Date(clockMs))).toMatchObject({ ok: true, body: { status: 'sent' } })
      expect((await messageOf(order))[0]).toMatchObject({ status: 'sent', resolution: 'confirmed_sent' })
      sendOk()
      expect((await processCustomerMessages(w.admin, deps())).claimed).toBe(0)
      expect(sendCalls).toHaveLength(1)
    })

    it('a process that died mid-send leaves it uncertain (never resent); a claim that died before sending is simply retaken', async () => {
      const a = await due('stale-sending')
      const b = await due('stale-claimed')
      // claim both, as a worker that then crashed
      const { data: claimed } = await w.admin.rpc('claim_shipment_messages', { p_limit: 50, p_lease_seconds: 60, p_max_attempts: 2, p_order: null, p_now: new Date(clockMs).toISOString() })
      const mine = (claimed as Array<{ id: string; order_id: string; claim_token: string }>).filter((m) => [a.order, b.order].includes(m.order_id))
      expect(mine).toHaveLength(2)
      const sending = mine.find((m) => m.order_id === a.order)!
      expect((await w.admin.rpc('mark_shipment_message_sending', { p_account: w.acc, p_message: sending.id, p_token: sending.claim_token, p_lease_seconds: 60, p_now: new Date(clockMs).toISOString() })).data).toMatchObject({ ok: true })
      advanceMin(5) // both leases expired, no one finished
      const r = await processCustomerMessages(w.admin, deps())
      expect(r.sent).toBeGreaterThanOrEqual(1)
      expect((await messageOf(a.order))[0]).toMatchObject({ status: 'uncertain', error_code: 'process_interrupted' })
      expect((await messageOf(b.order))[0]).toMatchObject({ status: 'sent' })
      expect(sendCalls.filter((c) => c.templateName)).toHaveLength(sendCalls.length)
      expect(await o.count(a.order, 'destination_customer_message_uncertain')).toBe(1)
    })

    it('two workers at the same moment: ONE send per message (SKIP LOCKED + token)', async () => {
      const made = [await due('w1'), await due('w2'), await due('w3'), await due('w4')]
      sendImpl = async () => { await new Promise((r) => setTimeout(r, 120)); return { messageId: '', whatsappMessageId: `wamid.${randomBytes(4).toString('hex')}` } }
      const [a, b] = await Promise.all([processCustomerMessages(w.admin, deps()), processCustomerMessages(w.admin, deps())])
      expect(a.sent + b.sent).toBe(4)
      expect(sendCalls).toHaveLength(4)
      for (const m of made) expect((await messageOf(m.order))[0]).toMatchObject({ status: 'sent', attempt: 1 })
    })

    it('delivered (or corrected / stopped) before the send: the message is SKIPPED and never sent', async () => {
      const a = await due('skip-delivered')
      const [c] = await o.claim(at(200), a.order)
      await o.apply(c, { p_normalized: 'delivered', p_started_at: at(20), p_finished_at: at(20), p_raw_hash: 'dlv' })
      const b = await due('skip-stopped')
      await w.admin.rpc('stop_order_shipment', { p_account: w.acc, p_actor: w.sup.id, p_order: b.order, p_reason: 'manual', p_now: at(20) })
      const r = await processCustomerMessages(w.admin, deps())
      expect(r.skipped).toBeGreaterThanOrEqual(2)
      expect(sendCalls).toHaveLength(0)
      expect((await messageOf(a.order))[0]).toMatchObject({ status: 'skipped', error_code: 'tracking_not_active' })
      expect((await messageOf(b.order))[0]).toMatchObject({ status: 'skipped', error_code: 'tracking_not_active' })
      expect(await o.count(a.order, 'destination_customer_message_skipped')).toBe(1)
    })

    it('an order without a conversation fails visibly (no chat is ever created)', async () => {
      const { order } = await due('noconv')
      await w.admin.from('order_shipment_messages').update({ conversation_id: null }).eq('order_id', order)
      expect(await processCustomerMessages(w.admin, deps())).toMatchObject({ claimed: 1, failed: 1 })
      expect((await messageOf(order))[0]).toMatchObject({ status: 'failed', error_code: 'order_without_conversation' })
      expect(sendCalls).toHaveLength(0)
    })
  })

  // ------------------------------------------------------------------------------------------------------------------ tick level
  describe('the cron tick', () => {
    const provider = (scenario: () => string) => createFakeProvider(() => scenario())
    const arrivalNow = () => new Date(clockMs).toISOString()
    const limaDay15 = (iso: string) => Date.UTC(...(() => { const d = new Date(Date.parse(iso) - 5 * 3_600_000); return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()] as [number, number, number] })()) + 5 * 3_600_000 + 15 * 86_400_000

    it('day 14: 0 alert, 0 message. Day 15: 1 alert + 1 message attempt. Second tick the same day: 0 new alerts, 0 duplicate messages. Failed / uncertain never stop the tracking', async () => {
      clockMs = Date.parse('2027-03-01T15:00:00Z')
      const arrival = arrivalNow()
      const order = await o.ready('tick')
      await o.register(order, { now: arrival })
      let scenario = `destination@${arrival}`
      const prov = provider(() => scenario)
      let t = await runShalomTick(w.admin, deps({ provider: prov }))
      expect(await o.shipment(order)).toMatchObject({ logistic_status: 'at_destination', pickup_state: 'waiting_pickup' })
      const day15 = limaDay15(arrival)
      clockMs = day15 - 60_000
      t = await runShalomTick(w.admin, deps({ provider: prov }))
      expect(t.alertsCreated).toBe(0)
      expect(t.messages.claimed).toBe(0)
      expect(sendCalls).toHaveLength(0)
      clockMs = day15
      metaRejected()
      t = await runShalomTick(w.admin, deps({ provider: prov }))
      expect(t.pickup.alerted).toBeGreaterThanOrEqual(1)
      expect(t.pickup.messagesDue).toBeGreaterThanOrEqual(1)
      expect(t.alertsCreated).toBeGreaterThanOrEqual(1)
      expect(t.messages).toMatchObject({ claimed: 1, failed: 1 })
      expect(sendCalls).toHaveLength(1)
      // second tick, same day: nothing new
      t = await runShalomTick(w.admin, deps({ provider: prov }))
      expect(t.alertsCreated).toBe(0)
      expect(t.pickup).toMatchObject({ alerted: 0, messagesDue: 0 })
      expect(sendCalls).toHaveLength(1) // the retry waits for its backoff
      expect((await w.admin.from('order_shipment_alerts').select('id').eq('order_id', order)).data).toHaveLength(1)
      // the tracking carries on and still reads Shalom
      scenario = 'delivered'
      clockMs += 13 * 3_600_000
      t = await runShalomTick(w.admin, deps({ provider: prov }))
      expect(await o.shipment(order)).toMatchObject({ logistic_status: 'delivered', tracking_state: 'delivered', pickup_state: 'completed' })
      expect((await messageOf(order))[0].status).toMatch(/failed|skipped|sent/)
    })

    it('GLOBAL kill switch (skipQueries): no Shalom query and NO customer message, but the DB-only evaluation (day 15 state + ledger) keeps running', async () => {
      const { order } = await o.shipAt('kill', 'at_destination', { destinationAt: ARRIVAL })
      const t = await runShalomTick(w.admin, deps({ skipQueries: true, provider: provider(() => 'origin') }))
      expect(t.enabled).toBe(false)
      expect(t.claimed).toBe(0)
      expect(t.messages.claimed).toBe(0)
      expect(sendCalls).toHaveLength(0)
      expect(t.pickup.alerted).toBeGreaterThanOrEqual(1)
      expect((await messageOf(order))[0]).toMatchObject({ status: 'pending' })
    })

    it('message switch OFF while tracking runs: tracking and the pickup condition work, the customer message is not sent', async () => {
      await w.admin.from('order_shipment_settings').update({ destination_customer_message_enabled: false }).eq('account_id', w.acc)
      try {
        const { order } = await o.shipAt('msg-off', 'at_destination', { destinationAt: ARRIVAL })
        const t = await runShalomTick(w.admin, deps({ provider: provider(() => 'destination') }))
        expect(t.pickup.alerted).toBeGreaterThanOrEqual(1)
        expect(t.messages.claimed).toBe(0)
        expect(await messageOf(order)).toEqual([])
        expect(await o.shipment(order)).toMatchObject({ pickup_state: 'alerted_15d', tracking_state: 'active' })
      } finally {
        await w.admin.from('order_shipment_settings').update({ destination_customer_message_enabled: true }).eq('account_id', w.acc)
      }
    })
  })

  // ------------------------------------------------------------------------------------------------------------------ security
  describe('security', () => {
    it('RLS: operators read the ledger; Commercial, viewer and other accounts read nothing; nobody writes it from the browser; the RPCs are service-role only', async () => {
      const { order, msg } = await due('rls')
      const read = async (a: typeof w.logi) => ((await a.client.from('order_shipment_messages').select('id, status').eq('order_id', order)).data ?? []) as Array<{ id: string }>
      expect(await read(w.logi)).toHaveLength(1)
      expect(await read(w.sup)).toHaveLength(1)
      for (const a of [w.comm, w.viewer, w.foreign]) expect(await read(a)).toEqual([])
      for (const a of [w.logi, w.sup]) {
        expect((await a.client.from('order_shipment_messages').update({ status: 'sent' }).eq('id', msg.id).select('id')).data ?? []).toHaveLength(0)
        expect((await a.client.from('order_shipment_messages').delete().eq('id', msg.id).select('id')).data ?? []).toHaveLength(0)
        expect((await a.client.rpc('claim_shipment_messages', {})).error).not.toBeNull()
        expect((await a.client.rpc('evaluate_pickup_day15', {})).error).not.toBeNull()
        expect((await a.client.rpc('retry_shipment_message', { p_account: w.acc, p_actor: a.id, p_message: msg.id })).error).not.toBeNull()
      }
      expect((await messageOf(order))[0].status).toBe('pending')
    })

    it('the ledger is protected: identity immutable, sent is final, illegal transitions refused, direct delete refused', async () => {
      const { order, msg } = await due('guard')
      expect((await w.admin.from('order_shipment_messages').update({ destination_episode: 9 }).eq('id', msg.id)).error?.code).toBe('42501')
      expect((await w.admin.from('order_shipment_messages').update({ status: 'sent', wamid: 'x' }).eq('id', msg.id)).error?.code).toBe('22023') // pending -> sent is not a transition
      expect((await w.admin.from('order_shipment_messages').delete().eq('id', msg.id)).error?.code).toBe('42501')
      await processCustomerMessages(w.admin, deps())
      expect((await w.admin.from('order_shipment_messages').update({ error_code: 'x' }).eq('id', msg.id)).error?.code).toBe('42501') // sent is final
      expect((await messageOf(order))[0].status).toBe('sent')
    })

    it('cross-account: another account can not retry / resolve a message of this one', async () => {
      const { msg } = await due('xacc')
      for (const fn of [() => retryCustomerMessage(w.ctxOf(w.foreign, w.accForeign), w.admin, msg.id), () => resolveCustomerMessage(w.ctxOf(w.foreign, w.accForeign), w.admin, msg.id, 'confirmed_sent')]) {
        expect(await fn()).toMatchObject({ ok: false, status: 404 })
      }
      expect((await w.admin.from('order_shipment_messages').select('status').eq('id', msg.id).single()).data).toMatchObject({ status: 'pending' })
    })
  })
})
