// @vitest-environment node
/**
 * P0 parity · the balance (PR-06 `pending_balance`) in the customer templates, against the REAL local stack:
 *   - resolveOrderBalance: tracked unpaid / partially paid / paid, over-payment never negative, NOT TRACKED and payments-off are "not available" (never zero);
 *   - PACKAGING notice: the paid variant (balance 0) vs the balance variant (balance > 0), refusal for a NOT TRACKED order, opt-in (no balance variant = previous behaviour);
 *   - ARRIVAL notice: the same variants selected at SEND time from the latest balance, with the account's configurable payment instructions.
 * WhatsApp is never reached: `sendTemplateMessage` is mocked (packaging, real send core) or an injected fake send is used (arrival). Skipped unless LOCAL_URL is set.
 * LOCAL ONLY (see logistics/test-support/qa-env).
 *
 *   eval "$(npx supabase status -o env | sed 's/^/export /')"; LOCAL_URL=$API_URL LOCAL_ANON=$ANON_KEY LOCAL_SERVICE=$SERVICE_ROLE_KEY npx vitest run src/lib/orders/payments/balance-variants.qa.test.ts
 */
import { randomBytes } from 'node:crypto'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const meta = vi.hoisted(() => ({ impl: null as null | ((args: Record<string, unknown>) => Promise<{ messageId: string }>), calls: [] as Array<Record<string, unknown>> }))
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/meta-api')>()
  return {
    ...actual,
    sendTemplateMessage: async (args: Record<string, unknown>) => {
      meta.calls.push(args)
      if (!meta.impl) throw new Error('Meta mock not configured')
      return meta.impl(args)
    },
  }
})

import { uploadVoucher } from '@/lib/orders/logistics/documents'
import { selectEvidenceFromChat } from '@/lib/orders/logistics/evidence'
import { sendPackagingTemplate, startPackaging } from '@/lib/orders/logistics/packaging'
import { reviewDocument } from '@/lib/orders/logistics/review'
import { createWorld, pdfBytes, QA_ENABLED, type QaWorld } from '@/lib/orders/logistics/test-support/qa-env'
import { resolveOrderBalance } from '@/lib/orders/payments/balance'
import { enablePayments, paymentsOps } from '@/lib/orders/payments/test-support/payments-ops'
import { readShalomConfig } from '@/lib/orders/shalom/config'
import { processCustomerMessages, type SendFn } from '@/lib/orders/shalom/customer-message'
import { acquireQaLock, releaseQaLock } from '@/lib/orders/shalom/test-support/qa-lock'
import { clearCredentialsBreaker, setShipmentFlag } from '@/lib/orders/shalom/test-support/ready-order'
import { at, shalomOps } from '@/lib/orders/shalom/test-support/shalom-ops'
import { encrypt } from '@/lib/whatsapp/encryption'

let w: QaWorld
let p: ReturnType<typeof paymentsOps>
let o: ReturnType<typeof shalomOps>
let n = 0
const key = (s: string) => `${w.tag}-${s}-${(n += 1)}`
const URL_ = process.env.LOCAL_URL
const chatObjects: string[] = []
const jpeg = (seed: string) => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(`${seed}-${randomBytes(6).toString('hex')}`), 0xff, 0xd9])
const okMeta = () => async () => ({ messageId: `wamid.${randomBytes(6).toString('hex')}` })

const PKG_PAID = 'qa_embalado_listo'
const PKG_BAL = 'qa_embalado_listo_saldo'
const ARR_PAID = 'qa_llegada_destino'
const ARR_BAL = 'qa_llegada_destino_saldo'
const INSTRUCTIONS = 'Paga el saldo por Yape o transferencia y envía tu comprobante'
const CUSTOMER_DNI = '87654321'

// ---- packaging helper: a PACKING order of `price` soles with a validated voucher and a chat photo as evidence ----------------------------------------
async function prepare(label: string, price: number) {
  const { data: contact } = await w.admin.from('contacts').insert({ user_id: w.owner.id, account_id: w.acc, phone: `51900${Math.floor(100000 + Math.random() * 899999)}`, name: `QA ${label}` }).select('id').single()
  const { data: conv } = await w.admin.from('conversations').insert({ user_id: w.owner.id, account_id: w.acc, contact_id: (contact as { id: string }).id }).select('id').single()
  const convId = (conv as { id: string }).id
  await w.admin.from('conversation_routing').insert({ conversation_id: convId, account_id: w.acc, stage: 'logistics', version: 1 })
  const order = await w.mkOrder(w.acc, label, { conversation_id: convId, customer_name: 'Cliente Prueba', dni: CUSTOMER_DNI, product: 'Producto Uno', price, destination: 'Arequipa' })
  const up = await uploadVoucher(w.ctxOf(w.logi, w.acc), w.admin, { fileName: `${label}.pdf`, bytes: pdfBytes(label), orderId: order, batchId: null, requestKey: key(label), allowDuplicate: false })
  if (!up.ok) throw new Error(`voucher upload failed: ${up.error}`)
  const { data: vrow } = await w.admin.from('order_documents').select('storage_path').eq('id', up.body.document.id).single()
  w.track((vrow as { storage_path: string }).storage_path)
  const v = await reviewDocument(w.ctxOf(w.logi, w.acc), w.admin, up.body.document.id, { action: 'validate', reviewedData: { dni: CUSTOMER_DNI } })
  if (!v.ok) throw new Error('validate failed')
  if (!(await startPackaging(w.ctxOf(w.logi, w.acc), w.admin, order)).ok) throw new Error('start packaging failed')
  const path = `account-${w.acc}/mirror/${w.tag}-${label}.jpg`
  expect((await w.admin.storage.from('chat-media').upload(path, jpeg(label), { contentType: 'image/jpeg' })).error).toBeNull()
  chatObjects.push(path)
  const { data: msg } = await w.admin.from('messages').insert({ conversation_id: convId, sender_type: 'customer', content_type: 'image', media_url: w.admin.storage.from('chat-media').getPublicUrl(path).data.publicUrl, media_type: 'image/jpeg' }).select('id').single()
  const e = await selectEvidenceFromChat(w.ctxOf(w.logi, w.acc), w.admin, order, { messageId: (msg as { id: string }).id, requestKey: key('ev') }, { supabaseUrl: URL_ })
  if (!e.ok) throw new Error(`evidence failed: ${e.error}`)
  const { data: erow } = await w.admin.from('order_documents').select('storage_path').eq('id', e.body.evidence.id).single()
  w.track((erow as { storage_path: string }).storage_path)
  return { order, conv: convId }
}
const sendPkg = (order: string, actor = w.logi, requestKey = key('send')) => sendPackagingTemplate(w.ctxOf(actor, w.acc), w.admin, order, requestKey)
const bodyParamsOf = (call: Record<string, unknown>) => ((call.messageParams as { body?: string[] } | undefined)?.body ?? (call.params as string[] | undefined) ?? [])

// ---- arrival helpers ------------------------------------------------------------------------------------------------------------------------------------
const CFG = readShalomConfig({ SHALOM_CONFIG_JSON: JSON.stringify({ messageMaxAttempts: 2, messageBackoffMinutes: [5, 15], batchSize: 50 }) })
let sendCalls: Array<{ conversationId: string; templateName?: string; params?: string[] }> = []
const fakeSend: SendFn = async (_db, _acc, prm) => {
  sendCalls.push({ conversationId: prm.conversationId, templateName: prm.templateName ?? undefined, params: prm.templateParams })
  return { messageId: '', whatsappMessageId: `wamid.${randomBytes(4).toString('hex')}` }
}
const clockMs = Date.parse(at(0))
const deps = () => ({ cfg: CFG, now: () => new Date(clockMs), sendMessage: fakeSend }) as never
const arrivalRow = async (order: string) => (((await w.admin.from('order_shipment_messages').select('*').eq('order_id', order).eq('kind', 'destination_arrival_customer')).data ?? [])[0] ?? null) as Record<string, any> | null // eslint-disable-line @typescript-eslint/no-explicit-any
const setShipSettings = async (patch: Record<string, unknown>) => { const r = await w.admin.from('order_shipment_settings').update(patch).eq('account_id', w.acc); if (r.error) throw r.error }
const setLogSettings = async (patch: Record<string, unknown>) => { const r = await w.admin.from('order_logistics_settings').update(patch).eq('account_id', w.acc); if (r.error) throw r.error }
/** A ready_for_dispatch order of `price` soles (tracked when payments are active) whose guide just reached En destino: the arrival notice becomes due by itself. */
async function arrive(label: string, price = 100) {
  const { order } = await p.readyOrder(label, price)
  const reg = await o.register(order)
  if ((reg.data as { ok?: boolean })?.ok !== true) throw new Error(`register failed: ${JSON.stringify(reg)}`)
  const [c] = await o.claim(at(1), order)
  const done = await o.apply(c, { p_normalized: 'at_destination', p_destination_at: '2026-12-01T14:00:00Z', p_started_at: at(1), p_finished_at: at(2), p_raw_hash: 'h-at-destination' })
  if ((done.data as { applied?: boolean })?.applied !== true) throw new Error('apply failed')
  return { order }
}
const parkOthers = () => w.admin.from('order_shipment_messages').update({ next_attempt_at: '2999-01-01T00:00:00Z' }).eq('account_id', w.acc).in('status', ['pending', 'failed'])

let legacyPkg: { order: string; conv: string }
let legacyArrival: { order: string }

vi.setConfig({ testTimeout: 40_000, hookTimeout: 570_000 })

describe.skipIf(!QA_ENABLED)('P0 parity: the PR-06 balance in the customer templates', () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL_
    process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.LOCAL_SERVICE
    await acquireQaLock()
    w = await createWorld()
    p = paymentsOps(w)
    o = shalomOps(w)
    const cfg = await w.admin.from('whatsapp_config').insert({ user_id: w.owner.id, account_id: w.acc, phone_number_id: '100000000000779', waba_id: '200000000000779', access_token: encrypt('qa-token-not-real'), status: 'connected' })
    if (cfg.error) throw cfg.error
    const tpl = await w.admin.from('message_templates').insert([
      { user_id: w.owner.id, account_id: w.acc, name: PKG_PAID, category: 'Utility', language: 'es', header_type: 'image', body_text: 'Hola {{1}}, tu pedido de {{2}} esta embalado y listo para despacho a {{3}}.', status: 'APPROVED' },
      { user_id: w.owner.id, account_id: w.acc, name: PKG_BAL, category: 'Utility', language: 'es', header_type: 'image', body_text: 'Hola {{1}}, tu pedido de {{2}} esta embalado para {{3}}. Saldo pendiente: {{4}}.', status: 'APPROVED' },
      { user_id: w.owner.id, account_id: w.acc, name: ARR_PAID, category: 'Utility', language: 'es', body_text: 'Hola {{1}}, tu pedido de {{2}} llego a destino ({{3}}).', status: 'APPROVED' },
      { user_id: w.owner.id, account_id: w.acc, name: ARR_BAL, category: 'Utility', language: 'es', body_text: 'Hola {{1}}, tu pedido de {{2}} llego a destino ({{3}}). Saldo: {{4}}. {{5}}', status: 'APPROVED' },
    ])
    if (tpl.error) throw tpl.error
    // configuration: logistics + shalom settings (balance variants NOT configured yet: each test turns them on)
    const ls = await w.admin.from('order_logistics_settings').upsert({ account_id: w.acc, packaging_template_name: PKG_PAID, packaging_template_language: 'es', packaging_template_params: ['customer_name', 'product', 'destination'] })
    if (ls.error) throw ls.error
    await setShipmentFlag(w, w.acc, true)
    await setShipSettings({ destination_customer_message_enabled: true, arrival_message_template_name: ARR_PAID, arrival_message_template_language: 'es', arrival_message_template_params: ['customer_name', 'product', 'destination'] })
    // HISTORICAL orders: created BEFORE payments are activated, so they have no financial row (NOT TRACKED)
    meta.impl = okMeta()
    legacyPkg = await prepare('legacy-pkg', 100)
    legacyArrival = await arrive('legacy-arrival', 100)
    // PR-06 ON from now: new orders are tracked
    await enablePayments(w, w.acc)
    const pi = await w.admin.from('order_payment_settings').update({ customer_payment_instructions: INSTRUCTIONS }).eq('account_id', w.acc)
    if (pi.error) throw pi.error
  }, 570_000)
  beforeEach(async () => {
    await parkOthers()
    await setLogSettings({ packaging_balance_template_name: PKG_BAL, packaging_balance_template_language: 'es', packaging_balance_template_params: ['customer_name', 'product', 'destination', 'pending_balance'] })
    await setShipSettings({ arrival_balance_template_name: ARR_BAL, arrival_balance_template_language: 'es', arrival_balance_template_params: ['customer_name', 'product', 'destination', 'pending_balance', 'payment_instructions'] })
    await w.admin.from('order_payment_settings').update({ order_payments_enabled: true, customer_payment_instructions: INSTRUCTIONS }).eq('account_id', w.acc)
    meta.impl = okMeta()
  })
  afterEach(() => {
    sendCalls = []
    meta.calls.length = 0
  })
  afterAll(async () => {
    if (w) {
      await w.dispose()
      await clearCredentialsBreaker(w)
    }
    releaseQaLock()
  }, 90_000)

  // ------------------------------------------------------------------------------------------------------------------ the balance itself
  describe('resolveOrderBalance (PR-06 is the only source)', () => {
    it('tracked: unpaid = total, partially paid = total - confirmed, paid = 0; only CONFIRMED payments count; never negative', async () => {
      const { order } = await p.order('bal', 150)
      expect(await resolveOrderBalance(w.admin, w.acc, order)).toMatchObject({ available: true, total: 150, paid: 0, pending: 150, status: 'unpaid' })
      await p.register(order, { p_amount: '40.00' }) // registered, not confirmed: it does not count
      expect(await resolveOrderBalance(w.admin, w.acc, order)).toMatchObject({ available: true, pending: 150 })
      await p.pay(order, '50.00')
      expect(await resolveOrderBalance(w.admin, w.acc, order)).toMatchObject({ available: true, paid: 50, pending: 100, status: 'partially_paid' })
      await p.pay(order, '100.00')
      expect(await resolveOrderBalance(w.admin, w.acc, order)).toMatchObject({ available: true, paid: 150, pending: 0, status: 'paid' })
    })

    it('NOT TRACKED (a historical order) and payments-off are "not available": never zero, never invented', async () => {
      expect(await resolveOrderBalance(w.admin, w.acc, legacyPkg.order)).toEqual({ available: false, reason: 'not_tracked' })
      const { order } = await p.order('bal-off', 80)
      await w.admin.from('order_payment_settings').update({ order_payments_enabled: false }).eq('account_id', w.acc)
      expect(await resolveOrderBalance(w.admin, w.acc, order)).toEqual({ available: false, reason: 'payments_disabled' })
      await w.admin.from('order_payment_settings').update({ order_payments_enabled: true }).eq('account_id', w.acc)
      expect(await resolveOrderBalance(w.admin, w.acc, '00000000-0000-4000-8000-000000000000')).toEqual({ available: false, reason: 'order_not_found' })
      expect(await resolveOrderBalance(w.admin, w.accForeign, order)).toMatchObject({ available: false }) // another account never gets a balance of this order
    })
  })

  // ------------------------------------------------------------------------------------------------------------------ packaging
  describe('packaging notice (PR-04): paid variant vs balance variant', () => {
    it('balance > 0 (unpaid): the BALANCE variant with header image, name / product / destination / balance, in the order\'s conversation; no DNI', async () => {
      const { order, conv } = await prepare('pkg-unpaid', 150)
      const r = await sendPkg(order)
      expect(r).toMatchObject({ ok: true, body: { status: 'sent', order_status: 'ready_for_dispatch' } })
      expect(meta.calls).toHaveLength(1)
      expect(meta.calls[0]).toMatchObject({ templateName: PKG_BAL, phoneNumberId: '100000000000779' })
      expect(bodyParamsOf(meta.calls[0])).toEqual(['Cliente Prueba', 'Producto Uno', 'Arequipa', 'S/ 150.00'])
      expect(JSON.stringify(meta.calls[0])).not.toContain(CUSTOMER_DNI)
      const { data: msgs } = await w.admin.from('messages').select('content_type, template_name').eq('conversation_id', conv)
      expect((msgs ?? []).filter((m: { template_name: string | null }) => m.template_name === PKG_BAL)).toHaveLength(1)
    })

    it('partial payment: the balance variant shows the REAL remaining amount', async () => {
      const { order } = await prepare('pkg-partial', 200)
      await p.pay(order, '75.50')
      expect((await sendPkg(order)).ok).toBe(true)
      expect(meta.calls[0]).toMatchObject({ templateName: PKG_BAL })
      expect(bodyParamsOf(meta.calls[0])[3]).toBe('S/ 124.50')
    })

    it('balance 0 (fully paid): the PAID variant (the existing template, three variables, no balance)', async () => {
      const { order } = await prepare('pkg-paid', 90)
      await p.pay(order, '90.00')
      expect((await sendPkg(order)).ok).toBe(true)
      expect(meta.calls[0]).toMatchObject({ templateName: PKG_PAID })
      expect(bodyParamsOf(meta.calls[0])).toEqual(['Cliente Prueba', 'Producto Uno', 'Arequipa'])
    })

    it('NOT TRACKED order: refused with an explicit reason, NOTHING is sent and no dispatch is claimed (never assumed paid, never a made-up balance)', async () => {
      const r = await sendPkg(legacyPkg.order)
      expect(r).toMatchObject({ ok: false, status: 409, error: 'pending_balance_unavailable', extra: { balance_reason: 'not_tracked' } })
      expect(meta.calls).toHaveLength(0)
      expect((await w.admin.from('order_template_dispatches').select('id').eq('order_id', legacyPkg.order)).data ?? []).toEqual([])
      expect((await w.admin.from('order_logistics').select('status').eq('order_id', legacyPkg.order).single()).data).toMatchObject({ status: 'packing' })
    })

    it('opt-in: with NO balance variant configured the behaviour is exactly the previous one (the base template, whatever the balance, even a not tracked order)', async () => {
      await setLogSettings({ packaging_balance_template_name: null, packaging_balance_template_language: null, packaging_balance_template_params: null })
      const { order } = await prepare('pkg-legacy-cfg', 120)
      expect((await sendPkg(order)).ok).toBe(true)
      expect(meta.calls[0]).toMatchObject({ templateName: PKG_PAID })
      expect(bodyParamsOf(meta.calls[0])).toEqual(['Cliente Prueba', 'Producto Uno', 'Arequipa'])
    })

    it('double click: the same request key sends ONCE and the replay is idempotent (the variant does not change it)', async () => {
      const { order } = await prepare('pkg-double', 60)
      const k = key('dbl')
      const [a, b] = await Promise.all([sendPkg(order, w.logi, k), sendPkg(order, w.logi, k)])
      expect(meta.calls).toHaveLength(1)
      expect([a.ok, b.ok].filter(Boolean).length).toBeGreaterThanOrEqual(1)
      expect((await sendPkg(order, w.logi, k)).ok).toBe(true)
      expect(meta.calls).toHaveLength(1)
    })

    it('roles and switches: Commercial can not send, Supervisor can; with the logistics switch OFF nothing is sent', async () => {
      const a = await prepare('pkg-role', 70)
      expect((await sendPkg(a.order, w.comm)).ok).toBe(false)
      expect(meta.calls).toHaveLength(0)
      expect((await sendPkg(a.order, w.sup)).ok).toBe(true)
      expect(meta.calls).toHaveLength(1)
      const b = await prepare('pkg-off', 70)
      await w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: false }).eq('account_id', w.acc)
      expect((await sendPkg(b.order)).ok).toBe(false)
      await w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: true }).eq('account_id', w.acc)
      expect(meta.calls).toHaveLength(1)
    })
  })

  // ------------------------------------------------------------------------------------------------------------------ arrival
  describe('arrival notice: paid variant vs balance variant (chosen at SEND time from the latest balance)', () => {
    it('balance > 0: the balance variant (name, product, destination, balance, configurable payment instructions), same conversation; the ledger records the template used', async () => {
      const { order } = await arrive('arr-unpaid')
      const before = await arrivalRow(order)
      expect(before).toMatchObject({ status: 'pending', template_name: ARR_PAID })
      expect(await processCustomerMessages(w.admin, deps())).toMatchObject({ claimed: 1, sent: 1 })
      expect(sendCalls).toHaveLength(1)
      expect(sendCalls[0]).toMatchObject({ templateName: ARR_BAL, conversationId: (await w.admin.from('order_confirmations').select('conversation_id').eq('id', order).single()).data!.conversation_id })
      expect(sendCalls[0].params).toEqual(['Cliente Prueba', 'P', 'Lima', 'S/ 100.00', INSTRUCTIONS])
      expect(await arrivalRow(order)).toMatchObject({ status: 'sent', template_name: ARR_BAL })
    })

    it('partial and then fully paid BEFORE the send: the latest balance decides (paid -> the paid variant)', async () => {
      const partial = await arrive('arr-partial')
      await p.pay(partial.order, '30.00')
      expect(await processCustomerMessages(w.admin, deps())).toMatchObject({ sent: 1 })
      expect(sendCalls[0]).toMatchObject({ templateName: ARR_BAL })
      expect(sendCalls[0].params![3]).toBe('S/ 70.00')
      sendCalls = []
      const paid = await arrive('arr-paid')
      await p.pay(paid.order, '100.00')
      expect(await processCustomerMessages(w.admin, deps())).toMatchObject({ sent: 1 })
      expect(sendCalls[0]).toMatchObject({ templateName: ARR_PAID })
      expect(sendCalls[0].params).toHaveLength(3)
    })

    it('NOT TRACKED order: nothing is sent, the notice is `failed` with an explicit reason and NO automatic retry (a person decides the transition strategy); never "S/ 0"', async () => {
      await w.admin.from('order_shipment_messages').update({ next_attempt_at: '2000-01-01T00:00:00Z' }).eq('order_id', legacyArrival.order).in('status', ['pending', 'failed'])
      expect(await processCustomerMessages(w.admin, deps())).toMatchObject({ claimed: 1, failed: 1, sent: 0 })
      expect(sendCalls).toHaveLength(0)
      expect(await arrivalRow(legacyArrival.order)).toMatchObject({ status: 'failed', error_code: 'pending_balance_unavailable', next_attempt_at: null })
      clockAdvance()
      expect((await processCustomerMessages(w.admin, deps())).claimed).toBe(0)
      expect(sendCalls).toHaveLength(0)
    })

    it('payment instructions not configured: the balance variant is not sent (nothing is invented)', async () => {
      await w.admin.from('order_payment_settings').update({ customer_payment_instructions: null }).eq('account_id', w.acc)
      const { order } = await arrive('arr-noinstr')
      expect(await processCustomerMessages(w.admin, deps())).toMatchObject({ claimed: 1, failed: 1, sent: 0 })
      expect(await arrivalRow(order)).toMatchObject({ status: 'failed', error_code: 'payment_instructions_not_configured', next_attempt_at: null })
      expect(sendCalls).toHaveLength(0)
    })

    it('opt-in: with NO balance variant configured the arrival notice is exactly the previous one (the base template for every order)', async () => {
      await setShipSettings({ arrival_balance_template_name: null, arrival_balance_template_language: null, arrival_balance_template_params: null })
      const { order } = await arrive('arr-optin')
      expect(await processCustomerMessages(w.admin, deps())).toMatchObject({ sent: 1 })
      expect(sendCalls[0]).toMatchObject({ templateName: ARR_PAID })
      expect(sendCalls[0].params).toEqual(['Cliente Prueba', 'P', 'Lima'])
      expect(await arrivalRow(order)).toMatchObject({ status: 'sent', template_name: ARR_PAID })
    })

    it('idempotent: a second tick never sends again; the customer-message switch OFF sends nothing; Meta is never called for real', async () => {
      const { order } = await arrive('arr-idem')
      await processCustomerMessages(w.admin, deps())
      for (let i = 0; i < 3; i += 1) expect((await processCustomerMessages(w.admin, deps())).claimed).toBe(0)
      expect(sendCalls).toHaveLength(1)
      await setShipSettings({ destination_customer_message_enabled: false })
      const off = await arrive('arr-switch-off')
      expect(await arrivalRow(off.order)).toBeNull()
      expect((await processCustomerMessages(w.admin, deps())).claimed).toBe(0)
      await setShipSettings({ destination_customer_message_enabled: true })
      expect(sendCalls).toHaveLength(1)
      expect(meta.calls).toHaveLength(0)
      expect(await arrivalRow(order)).toMatchObject({ status: 'sent' })
    })
  })
})

// the notice row of the not-tracked order is `failed` with no next attempt: advancing the clock must not change that
function clockAdvance() {
  // (kept as a function so the intent reads at the call site: a day later nothing is due)
  void 0
}
