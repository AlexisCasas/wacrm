// @vitest-environment node
/**
 * The IMMEDIATE customer notice when a shipment first reaches En destino (kind `destination_arrival_customer`) against the REAL local stack. It reuses the PR-05A
 * ledger / claim / retry / uncertain machinery, so these tests prove the NEW parts (trigger, kind, configuration, inertness, idempotency per episode) and that the
 * shared policy applies to it. WhatsApp is never reached: an injected fake send (fast) or the real send core with only `sendTemplateMessage` mocked.
 * Skipped unless LOCAL_URL is set. LOCAL ONLY (see logistics/test-support/qa-env).
 *
 *   eval "$(npx supabase status -o env | sed 's/^/export /')"; LOCAL_URL=$API_URL LOCAL_ANON=$ANON_KEY LOCAL_SERVICE=$SERVICE_ROLE_KEY npx vitest run src/lib/orders/shalom/arrival-message.qa.test.ts
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
import { processCustomerMessages, retryCustomerMessage, resolveCustomerMessage, type SendFn } from '@/lib/orders/shalom/customer-message'
import { runShalomTick } from '@/lib/orders/shalom/poller'
import { createFakeProvider, notConfiguredProvider, resolveShalomProvider } from '@/lib/orders/shalom/providers'
import { acquireQaLock, releaseQaLock } from '@/lib/orders/shalom/test-support/qa-lock'
import { clearCredentialsBreaker, setShipmentFlag } from '@/lib/orders/shalom/test-support/ready-order'
import { at, shalomOps } from '@/lib/orders/shalom/test-support/shalom-ops'
import { encrypt } from '@/lib/whatsapp/encryption'
import { SendMessageError } from '@/lib/whatsapp/send-message'

let w: QaWorld
let o: ReturnType<typeof shalomOps>
const ARRIVAL_TEMPLATE = 'qa_pedido_llegada_destino'
const DAY15_TEMPLATE = 'qa_pendiente_recojo'
const ARRIVAL_KIND = 'destination_arrival_customer'
const CFG = readShalomConfig({ SHALOM_CONFIG_JSON: JSON.stringify({ messageMaxAttempts: 2, messageBackoffMinutes: [5, 15], batchSize: 50 }) })
const NOW = at(0)
const ARRIVED_AT = '2026-12-01T14:00:00Z'

let sendCalls: Array<{ conversationId: string; templateName?: string; params?: string[] }> = []
let sendImpl: () => Promise<{ messageId: string; whatsappMessageId: string }> = async () => ({ messageId: '', whatsappMessageId: `wamid.${randomBytes(4).toString('hex')}` })
const fakeSend: SendFn = async (_db, _acc, p) => {
  sendCalls.push({ conversationId: p.conversationId, templateName: p.templateName ?? undefined, params: p.templateParams })
  const r = await sendImpl()
  return { messageId: r.messageId, whatsappMessageId: r.whatsappMessageId }
}
const sendOk = () => { sendImpl = async () => ({ messageId: '', whatsappMessageId: `wamid.${randomBytes(4).toString('hex')}` }) }
const metaRejected = () => { sendImpl = async () => { throw new SendMessageError('meta_error', 'Template rejected by Meta', 502) } }
const metaLost = () => { sendImpl = async () => { throw new SendMessageError('meta_error', 'fetch failed', 502) } }

let clockMs = Date.parse(NOW)
const advanceMin = (m: number) => { clockMs += m * 60_000 }
const deps = (over: Record<string, unknown> = {}) => ({ cfg: CFG, now: () => new Date(clockMs), sendMessage: fakeSend, ...over }) as never
const messagesOf = async (order: string) => ((await w.admin.from('order_shipment_messages').select('*').eq('order_id', order).order('created_at')).data ?? []) as Array<Record<string, any>> // eslint-disable-line @typescript-eslint/no-explicit-any
const arrivalOf = async (order: string) => (await messagesOf(order)).filter((m) => m.kind === ARRIVAL_KIND)
const setSettings = async (patch: Record<string, unknown>, acc = w.acc) => { const r = await w.admin.from('order_shipment_settings').update(patch).eq('account_id', acc); if (r.error) throw r.error }
const conversationOf = async (order: string) => ((await w.admin.from('order_confirmations').select('conversation_id').eq('id', order).single()).data as { conversation_id: string }).conversation_id

/** A shipment that reaches En destino for the first time (one applied answer), with every switch ON: the arrival notice becomes due by itself. */
const arrive = (label: string, opts: { acc?: string; actor?: typeof w.logi } = {}) => o.shipAt(label, 'at_destination', { destinationAt: ARRIVED_AT, ...opts })

/** Registers + claims with every switch ON, lets `before` change the configuration, and only THEN applies the En destino answer (the moment the trigger looks at the switches). */
async function arriveAfter(label: string, before: () => Promise<void>) {
  const order = await o.ready(label)
  const reg = await o.register(order)
  if ((reg.data as { ok?: boolean })?.ok !== true) throw new Error('register failed')
  const [c] = await o.claim(at(1), order)
  await before()
  const done = await o.apply(c, { p_normalized: 'at_destination', p_destination_at: ARRIVED_AT, p_started_at: at(1), p_finished_at: at(2), p_raw_hash: 'h-at-destination' })
  if ((done.data as { applied?: boolean })?.applied !== true) throw new Error('apply failed')
  return { order }
}

vi.setConfig({ testTimeout: 40_000, hookTimeout: 570_000 })

describe('the Shalom provider is untouched by the arrival notice', () => {
  it('resolves exactly as before (no variables = not_configured; the real provider still needs all of them)', () => {
    expect(resolveShalomProvider({})).toBe(notConfiguredProvider)
    expect(resolveShalomProvider({ SHALOM_PROVIDER: 'shalom_http' })).toBe(notConfiguredProvider)
    expect(resolveShalomProvider({ SHALOM_PROVIDER: 'fake', NODE_ENV: 'production' })).toBe(notConfiguredProvider)
  })
})

describe.skipIf(!QA_ENABLED)('immediate arrival notice (destination_arrival_customer)', () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.LOCAL_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.LOCAL_SERVICE
    await acquireQaLock()
    w = await createWorld()
    o = shalomOps(w)
    await setShipmentFlag(w, w.acc, true)
    await setShipmentFlag(w, w.accForeign, true)
    await setSettings({
      destination_customer_message_enabled: true,
      arrival_message_template_name: ARRIVAL_TEMPLATE, arrival_message_template_language: 'es', arrival_message_template_params: ['customer_name', 'product', 'destination'],
      customer_message_template_name: DAY15_TEMPLATE, customer_message_template_language: 'es', customer_message_template_params: ['customer_name'],
    })
    const cfg = await w.admin.from('whatsapp_config').insert({ user_id: w.owner.id, account_id: w.acc, phone_number_id: '100000000000778', waba_id: '200000000000778', access_token: encrypt('qa-token-not-real'), status: 'connected' })
    if (cfg.error) throw cfg.error
    const tpl = await w.admin.from('message_templates').insert([
      { user_id: w.owner.id, account_id: w.acc, name: ARRIVAL_TEMPLATE, category: 'Utility', language: 'es', body_text: 'Hola {{1}}, tu pedido de {{2}} ya llegó a destino ({{3}}). Puedes acercarte a la agencia a recogerlo con tu DNI.', status: 'APPROVED' },
      { user_id: w.owner.id, account_id: w.acc, name: DAY15_TEMPLATE, category: 'Utility', language: 'es', body_text: 'Hola {{1}}, tu pedido continúa pendiente de recojo en la agencia de destino.', status: 'APPROVED' },
    ])
    if (tpl.error) throw tpl.error
  }, 570_000)
  beforeEach(async () => {
    // park rows left by earlier tests so a tick only touches the message under test
    await w.admin.from('order_shipment_messages').update({ next_attempt_at: '2999-01-01T00:00:00Z' }).eq('account_id', w.acc).in('status', ['pending', 'failed'])
  })
  afterEach(async () => {
    sendCalls = []
    sendOk()
    meta.calls.length = 0
    meta.impl = null
    clockMs = Date.parse(NOW)
    // every test starts from the fully configured state
    await setSettings({ destination_customer_message_enabled: true, arrival_message_template_name: ARRIVAL_TEMPLATE, arrival_message_template_language: 'es', arrival_message_template_params: ['customer_name', 'product', 'destination'] })
    await setShipmentFlag(w, w.acc, true)
    await w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: true }).eq('account_id', w.acc)
  })
  afterAll(async () => {
    if (w) {
      await w.dispose()
      await clearCredentialsBreaker(w)
    }
    releaseQaLock()
  }, 90_000)

  // ------------------------------------------------------------------------------------------------------------------ the trigger
  describe('when it becomes due', () => {
    it('the FIRST arrival at En destino creates ONE pending ledger row (arrival kind) and ONE due event, in the order\'s own conversation with the configured template snapshot', async () => {
      const { order } = await arrive('first')
      const rows = await messagesOf(order)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ kind: ARRIVAL_KIND, status: 'pending', destination_episode: 1, attempt: 0, template_name: ARRIVAL_TEMPLATE, template_language: 'es', template_params: ['customer_name', 'product', 'destination'] })
      expect(rows[0].conversation_id).toBe(await conversationOf(order))
      expect(await o.count(order, 'destination_arrival_message_due')).toBe(1)
      // the day-15 mechanism is a separate one: nothing of it exists yet
      expect(await o.count(order, 'destination_customer_message_due')).toBe(0)
      expect(await o.shipment(order)).toMatchObject({ logistic_status: 'at_destination', tracking_state: 'active', pickup_state: 'waiting_pickup' })
    })

    it('at_origin and in_transit create nothing; delivered without ever being En destino creates nothing; a shipment that was En destino and is then delivered before the send is skipped', async () => {
      const origin = await o.shipAt('origin', 'at_origin')
      const transit = await o.shipAt('transit', 'in_transit')
      const delivered = await o.shipAt('delivered-direct', 'delivered')
      for (const s of [origin, transit, delivered]) expect(await messagesOf(s.order)).toEqual([])
      expect(await processCustomerMessages(w.admin, deps())).toMatchObject({ claimed: 0 })
      expect(sendCalls).toHaveLength(0)

      const { order, c } = await arrive('then-delivered')
      const [c2] = await o.claim(at(300), order)
      expect(c2).toBeTruthy()
      await o.apply(c2, { p_normalized: 'delivered', p_started_at: at(300), p_finished_at: at(301), p_raw_hash: 'h-delivered', p_now: at(301) })
      expect(c).toBeTruthy()
      expect(await processCustomerMessages(w.admin, deps())).toMatchObject({ claimed: 1, skipped: 1, sent: 0 })
      expect(sendCalls).toHaveLength(0)
      expect((await arrivalOf(order))[0]).toMatchObject({ status: 'skipped', error_code: expect.stringMatching(/^(tracking_not_active|no_longer_at_destination)$/) })
    })

    it('a repeated refresh that keeps En destino (same or older answers) never creates a second row or a second event', async () => {
      const { order } = await arrive('refresh')
      for (let i = 0; i < 3; i += 1) {
        const t = 200 + i * 800
        const [c] = await o.claim(at(t), order)
        expect(c).toBeTruthy()
        await o.apply(c, { p_normalized: 'at_destination', p_destination_at: ARRIVED_AT, p_started_at: at(t), p_finished_at: at(t + 1), p_raw_hash: `h-again-${i}`, p_now: at(t + 1), p_next_poll_at: at(t + 700) })
      }
      const [back] = await o.claim(at(3000), order)
      expect(back).toBeTruthy()
      await o.apply(back, { p_normalized: 'in_transit', p_started_at: at(3000), p_finished_at: at(3001), p_raw_hash: 'h-back', p_now: at(3001) }) // a regression is ignored
      expect(await arrivalOf(order)).toHaveLength(1)
      expect(await o.count(order, 'destination_arrival_message_due')).toBe(1)
    })

    it('switch OFF: no row, no event, no claim, no WhatsApp and no side effect; turning it ON later does NOT notify shipments that were already En destino', async () => {
      await setSettings({ destination_customer_message_enabled: false })
      const { order } = await arrive('off')
      expect(await messagesOf(order)).toEqual([])
      expect(await o.count(order, 'destination_arrival_message_due')).toBe(0)
      expect(await processCustomerMessages(w.admin, deps())).toMatchObject({ claimed: 0 })
      await setSettings({ destination_customer_message_enabled: true })
      expect(await processCustomerMessages(w.admin, deps())).toMatchObject({ claimed: 0 })
      expect(await messagesOf(order)).toEqual([])
      expect(sendCalls).toHaveLength(0)
      expect(meta.calls).toHaveLength(0)
      expect(await o.shipment(order)).toMatchObject({ logistic_status: 'at_destination' }) // tracking itself keeps working
    })

    it('needs every switch AND the arrival template: tracking flag OFF, logistics flag OFF or no arrival template create nothing (an account that only uses the day-15 message is unchanged)', async () => {
      const a = await arriveAfter('no-tracking-flag', () => setShipmentFlag(w, w.acc, false))
      await setShipmentFlag(w, w.acc, true)
      const b = await arriveAfter('no-logistics-flag', async () => { await w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: false }).eq('account_id', w.acc) })
      await w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: true }).eq('account_id', w.acc)
      const c = await arriveAfter('no-template', () => setSettings({ arrival_message_template_name: null, arrival_message_template_language: null, arrival_message_template_params: null }))
      for (const s of [a, b, c]) expect(await messagesOf(s.order)).toEqual([])
      expect(await o.count(c.order, 'destination_arrival_message_due')).toBe(0)
    })

    it('cross-account: another account (no arrival configuration) gets nothing, and this account\'s tick never touches its orders', async () => {
      const foreign = await arrive('foreign', { acc: w.accForeign, actor: w.foreign })
      expect(await messagesOf(foreign.order)).toEqual([])
      const mine = await arrive('mine')
      expect(await processCustomerMessages(w.admin, deps())).toMatchObject({ claimed: 1, sent: 1 })
      expect((await w.admin.from('order_shipment_messages').select('id').eq('account_id', w.accForeign)).data ?? []).toEqual([])
      expect((await arrivalOf(mine.order))[0].status).toBe('sent')
    })

    it('a NEW legitimate episode (guide corrected, arriving again) gets its own notice; the first one stays as history', async () => {
      const { order } = await arrive('episode')
      await processCustomerMessages(w.admin, deps())
      await w.admin.rpc('correct_order_shipment_identifier', { p_account: w.acc, p_actor: w.sup.id, p_order: order, p_number: '88888881', p_code: 'ZZ11', p_now: at(20) })
      const [c] = await o.claim(at(21), order)
      await o.apply(c, { p_normalized: 'at_destination', p_destination_at: ARRIVED_AT, p_started_at: at(21), p_finished_at: at(22), p_raw_hash: 'again', p_now: at(22) })
      const rows = await arrivalOf(order)
      expect(rows.map((r) => [r.destination_episode, r.status])).toEqual([[1, 'sent'], [2, 'pending']])
      expect(await o.count(order, 'destination_arrival_message_due')).toBe(2)
    })

    it('coexists with the day-15 reminder: same episode, two ledger rows of different kind, each due exactly once', async () => {
      const { order } = await arrive('coexist')
      await processCustomerMessages(w.admin, deps())
      expect(((await w.admin.rpc('evaluate_pickup_day15', { p_now: at(40 * 1440), p_days: 15 })).data as { messages_due: number }).messages_due).toBeGreaterThanOrEqual(1)
      await w.admin.rpc('evaluate_pickup_day15', { p_now: at(41 * 1440), p_days: 15 })
      const rows = await messagesOf(order)
      expect(rows.map((r) => r.kind).sort()).toEqual(['destination_15d_customer', ARRIVAL_KIND])
      expect(rows.filter((r) => r.kind === ARRIVAL_KIND)).toHaveLength(1)
      expect(await o.count(order, 'destination_arrival_message_due')).toBe(1)
    })
  })

  // ------------------------------------------------------------------------------------------------------------------ sending
  describe('sending (the shared sender, unchanged)', () => {
    it('SUCCESS: sent exactly once, into the order\'s conversation, with the three variables; sent / further ticks never send again', async () => {
      const { order } = await arrive('ok')
      const r1 = await processCustomerMessages(w.admin, deps())
      expect(r1).toMatchObject({ claimed: 1, sent: 1, failed: 0, uncertain: 0, errors: 0 })
      expect(sendCalls).toHaveLength(1)
      expect(sendCalls[0]).toMatchObject({ templateName: ARRIVAL_TEMPLATE, conversationId: await conversationOf(order) })
      expect(sendCalls[0].params).toHaveLength(3)
      expect((await arrivalOf(order))[0]).toMatchObject({ status: 'sent', attempt: 1, error_code: null })
      advanceMin(120)
      for (let i = 0; i < 3; i += 1) expect((await processCustomerMessages(w.admin, deps())).claimed).toBe(0)
      expect(sendCalls).toHaveLength(1)
      expect(await o.shipment(order)).toMatchObject({ logistic_status: 'at_destination', tracking_state: 'active' })
    })

    it('real send core: the notice is persisted in the SAME conversation as a template message; no chat is created; the number is the account\'s configured one', async () => {
      const { order } = await arrive('core')
      meta.impl = async () => ({ messageId: `wamid.${randomBytes(6).toString('hex')}` })
      const conv = await conversationOf(order)
      const before = (await w.admin.from('conversations').select('id', { count: 'exact', head: true }).eq('account_id', w.acc)).count
      expect(await processCustomerMessages(w.admin, { cfg: CFG, now: () => new Date(clockMs) })).toMatchObject({ sent: 1, failed: 0, uncertain: 0 })
      expect(meta.calls).toHaveLength(1)
      expect(meta.calls[0]).toMatchObject({ phoneNumberId: '100000000000778', templateName: ARRIVAL_TEMPLATE })
      const { data: msgs } = await w.admin.from('messages').select('id, content_type, template_name, message_id').eq('conversation_id', conv)
      expect(msgs).toHaveLength(1)
      expect(msgs![0]).toMatchObject({ content_type: 'template', template_name: ARRIVAL_TEMPLATE })
      expect((await w.admin.from('conversations').select('id', { count: 'exact', head: true }).eq('account_id', w.acc)).count).toBe(before)
      expect((await arrivalOf(order))[0]).toMatchObject({ status: 'sent', message_row_id: msgs![0].id, wamid: msgs![0].message_id })
    })

    it('two workers at the same moment: ONE send per notice', async () => {
      const made = [await arrive('w1'), await arrive('w2'), await arrive('w3'), await arrive('w4')]
      sendImpl = async () => { await new Promise((r) => setTimeout(r, 120)); return { messageId: '', whatsappMessageId: `wamid.${randomBytes(4).toString('hex')}` } }
      const [a, b] = await Promise.all([processCustomerMessages(w.admin, deps()), processCustomerMessages(w.admin, deps())])
      expect(a.sent + b.sent).toBe(4)
      expect(sendCalls).toHaveLength(4)
      for (const m of made) expect((await arrivalOf(m.order))[0]).toMatchObject({ status: 'sent', attempt: 1 })
    })

    it('FAILED (Meta rejects): bounded automatic retries with the existing backoff, then only a PERSON can retry; the shipment and the tracking are untouched; never a duplicate', async () => {
      const { order } = await arrive('failed')
      metaRejected()
      expect(await processCustomerMessages(w.admin, deps())).toMatchObject({ claimed: 1, failed: 1 })
      let [m] = await arrivalOf(order)
      expect(m).toMatchObject({ status: 'failed', attempt: 1 })
      expect(m.next_attempt_at).toBeTruthy()
      expect(await o.shipment(order)).toMatchObject({ logistic_status: 'at_destination', tracking_state: 'active' })
      expect((await processCustomerMessages(w.admin, deps())).claimed).toBe(0) // not before its backoff
      advanceMin(6)
      expect(await processCustomerMessages(w.admin, deps())).toMatchObject({ claimed: 1, failed: 1 }) // 2nd (and last) automatic attempt
      ;[m] = await arrivalOf(order)
      expect(m).toMatchObject({ status: 'failed', attempt: 2, next_attempt_at: null })
      advanceMin(24 * 60)
      expect((await processCustomerMessages(w.admin, deps())).claimed).toBe(0) // exhausted: it waits for a person
      sendOk()
      expect(await retryCustomerMessage(w.ctxOf(w.logi, w.acc), w.admin, m.id, new Date(clockMs))).toMatchObject({ ok: true })
      expect(await processCustomerMessages(w.admin, deps())).toMatchObject({ claimed: 1, sent: 1 })
      expect((await arrivalOf(order))[0].status).toBe('sent')
      expect(await arrivalOf(order)).toHaveLength(1)
    })

    it('UNCERTAIN: never re-sent automatically; a retry is refused; Commercial / viewer / other accounts can not resolve; Supervisor / Logistics resolve', async () => {
      const { order } = await arrive('uncertain')
      metaLost()
      expect(await processCustomerMessages(w.admin, deps())).toMatchObject({ claimed: 1, uncertain: 1 })
      const [m] = await arrivalOf(order)
      expect(m).toMatchObject({ status: 'uncertain', error_code: 'meta_unreachable' })
      sendOk()
      advanceMin(24 * 60)
      for (let i = 0; i < 3; i += 1) expect((await processCustomerMessages(w.admin, deps())).claimed).toBe(0)
      expect(sendCalls).toHaveLength(1)
      expect(await retryCustomerMessage(w.ctxOf(w.logi, w.acc), w.admin, m.id)).toMatchObject({ ok: false, error: 'needs_resolution' })
      for (const actor of [w.comm, w.viewer]) expect(await resolveCustomerMessage(w.ctxOf(actor, w.acc), w.admin, m.id, 'confirmed_sent')).toMatchObject({ ok: false, status: 404 })
      expect(await resolveCustomerMessage(w.ctxOf(w.foreign, w.accForeign), w.admin, m.id, 'confirmed_sent')).toMatchObject({ ok: false, status: 404 })
      expect(await resolveCustomerMessage(w.ctxOf(w.logi, w.acc), w.admin, m.id, 'confirmed_sent', new Date(clockMs))).toMatchObject({ ok: true, body: { status: 'sent' } })
      expect((await processCustomerMessages(w.admin, deps())).claimed).toBe(0)
    })

    it('configuration problems (template not approved / missing) are failures that wait for a person, never a crash and never an automatic loop', async () => {
      const { order } = await arrive('cfg')
      await w.admin.from('message_templates').update({ status: 'PENDING' }).eq('account_id', w.acc).eq('name', ARRIVAL_TEMPLATE)
      expect(await processCustomerMessages(w.admin, deps())).toMatchObject({ claimed: 1, failed: 1 })
      expect((await arrivalOf(order))[0]).toMatchObject({ status: 'failed', error_code: 'template_not_approved', next_attempt_at: null })
      await w.admin.from('message_templates').update({ status: 'APPROVED' }).eq('account_id', w.acc).eq('name', ARRIVAL_TEMPLATE)
      advanceMin(24 * 60)
      expect((await processCustomerMessages(w.admin, deps())).claimed).toBe(0)
      expect(sendCalls).toHaveLength(0)
    })
  })

  // ------------------------------------------------------------------------------------------------------------------ cron tick
  describe('the cron tick', () => {
    it('GLOBAL kill switch (skipQueries): the arrival row is created by the DB (no Shalom involved) but NOTHING is sent; with the switch back ON the tick sends it once', async () => {
      const { order } = await arrive('tick')
      const provider = createFakeProvider(() => 'destination')
      const previous = process.env.SHALOM_CUSTOMER_MESSAGES_ENABLED
      try {
        process.env.SHALOM_CUSTOMER_MESSAGES_ENABLED = 'true'
        const off = await runShalomTick(w.admin, { provider, cfg: CFG, now: () => new Date(clockMs), skipQueries: true, sendMessage: fakeSend })
        expect(off.messages.claimed).toBe(0)
        expect(sendCalls).toHaveLength(0)

        process.env.SHALOM_CUSTOMER_MESSAGES_ENABLED = 'false'
        const trackingOnly = await runShalomTick(w.admin, { provider, cfg: CFG, now: () => new Date(clockMs), skipQueries: false, sendMessage: fakeSend })
        expect(trackingOnly.messages.claimed).toBe(0)
        expect(sendCalls).toHaveLength(0)

        process.env.SHALOM_CUSTOMER_MESSAGES_ENABLED = 'true'
        const on = await runShalomTick(w.admin, { provider, cfg: CFG, now: () => new Date(clockMs), skipQueries: false, sendMessage: fakeSend })
        expect(on.messages).toMatchObject({ sent: 1 })
        expect(sendCalls).toHaveLength(1)
        expect((await arrivalOf(order))[0].status).toBe('sent')
      } finally {
        if (previous === undefined) delete process.env.SHALOM_CUSTOMER_MESSAGES_ENABLED
        else process.env.SHALOM_CUSTOMER_MESSAGES_ENABLED = previous
      }
    })
  })

  // ------------------------------------------------------------------------------------------------------------------ security
  describe('security', () => {
    it('RLS: operators read the ledger row; Commercial, viewer and other accounts read nothing; nobody writes it from the browser; the trigger function is not callable', async () => {
      const { order } = await arrive('rls')
      const [msg] = await arrivalOf(order)
      const read = async (a: typeof w.logi) => ((await a.client.from('order_shipment_messages').select('id, kind').eq('order_id', order)).data ?? []) as Array<{ id: string; kind: string }>
      expect((await read(w.logi)).map((r) => r.kind)).toEqual([ARRIVAL_KIND])
      expect((await read(w.sup)).map((r) => r.kind)).toEqual([ARRIVAL_KIND])
      for (const a of [w.comm, w.viewer, w.foreign]) expect(await read(a)).toEqual([])
      for (const a of [w.logi, w.sup]) {
        expect((await a.client.from('order_shipment_messages').update({ status: 'sent' }).eq('id', msg.id).select('id')).data ?? []).toHaveLength(0)
        expect((await a.client.from('order_shipment_messages').insert({ account_id: w.acc, order_id: order, destination_episode: 9, kind: ARRIVAL_KIND })).error).not.toBeNull()
        expect((await a.client.rpc('order_shipments_arrival_message', {})).error).not.toBeNull()
      }
      expect((await w.admin.rpc('order_shipments_arrival_message', {})).error).not.toBeNull() // not even service_role: it is a trigger function
      expect((await arrivalOf(order))[0].status).toBe('pending')
    })

    it('Commercial can not retry or resolve a logistics notice and triggers nothing: only Logistics / Supervisor operate it', async () => {
      const { order } = await arrive('roles')
      metaRejected()
      await processCustomerMessages(w.admin, deps())
      const [m] = await arrivalOf(order)
      expect(m.status).toBe('failed')
      for (const actor of [w.comm, w.viewer]) expect(await retryCustomerMessage(w.ctxOf(actor, w.acc), w.admin, m.id)).toMatchObject({ ok: false, status: 404 })
      expect(await retryCustomerMessage(w.ctxOf(w.foreign, w.accForeign), w.admin, m.id)).toMatchObject({ ok: false, status: 404 })
      expect((await arrivalOf(order))[0].status).toBe('failed')
      sendOk()
      expect(await retryCustomerMessage(w.ctxOf(w.sup, w.acc), w.admin, m.id, new Date(clockMs))).toMatchObject({ ok: true })
    })

    it('the ledger rules are unchanged for the new kind: identity immutable, sent is final, no direct delete, no unknown kind', async () => {
      const { order } = await arrive('guard')
      const [msg] = await arrivalOf(order)
      expect((await w.admin.from('order_shipment_messages').update({ kind: 'destination_15d_customer' }).eq('id', msg.id)).error?.code).toBe('42501')
      expect((await w.admin.from('order_shipment_messages').delete().eq('id', msg.id)).error?.code).toBe('42501')
      expect((await w.admin.from('order_shipment_messages').insert({ account_id: w.acc, order_id: order, destination_episode: 7, kind: 'destination_whatever' })).error).not.toBeNull()
      await processCustomerMessages(w.admin, deps())
      expect((await w.admin.from('order_shipment_messages').update({ error_code: 'x' }).eq('id', msg.id)).error?.code).toBe('42501')
    })
  })
})
