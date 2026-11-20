// @vitest-environment node
/**
 * P0 parity · the VOUCHER NOTICE (`voucher_envio_shalom`: UTILITY, header DOCUMENT) against the REAL local stack: a MANUAL send by Logistica / Supervisor of the validated PR-04 voucher (PDF) with
 * the guide, in the order's own conversation, with its OWN ledger: one notice per guide, double click / concurrency, failed (only a person retries), uncertain (never re-sent, a person resolves),
 * obsolete guide, roles, switches, cross-account and RLS. WhatsApp is never reached: an injected fake send (fast) or the real send core with only `sendTemplateMessage` mocked.
 * Skipped unless LOCAL_URL is set. LOCAL ONLY (see logistics/test-support/qa-env).
 *
 *   eval "$(npx supabase status -o env | sed 's/^/export /')"; LOCAL_URL=$API_URL LOCAL_ANON=$ANON_KEY LOCAL_SERVICE=$SERVICE_ROLE_KEY npx vitest run src/lib/orders/shalom/voucher-message.qa.test.ts
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

import { createWorld, pdfBytes, QA_ENABLED, type QaActor, type QaWorld } from '@/lib/orders/logistics/test-support/qa-env'
import { readShalomConfig } from '@/lib/orders/shalom/config'
import { processCustomerMessages } from '@/lib/orders/shalom/customer-message'
import { runShalomTick } from '@/lib/orders/shalom/poller'
import { createFakeProvider } from '@/lib/orders/shalom/providers'
import { acquireQaLock, releaseQaLock } from '@/lib/orders/shalom/test-support/qa-lock'
import { clearCredentialsBreaker, setShipmentFlag } from '@/lib/orders/shalom/test-support/ready-order'
import { at, shalomOps } from '@/lib/orders/shalom/test-support/shalom-ops'
import { paymentsOps } from '@/lib/orders/payments/test-support/payments-ops'
import { resolveShipmentVoucher, retryShipmentVoucher, sendShipmentVoucher } from '@/lib/orders/shalom/voucher-message'
import { encrypt } from '@/lib/whatsapp/encryption'
import { SendMessageError, type SendMessageParams } from '@/lib/whatsapp/send-message'

let w: QaWorld
let o: ReturnType<typeof shalomOps>
let p: ReturnType<typeof paymentsOps>
const TEMPLATE = 'qa_voucher_envio_shalom'
const CFG = readShalomConfig({ SHALOM_CONFIG_JSON: JSON.stringify({ batchSize: 50 }) })

let sendCalls: SendMessageParams[] = []
let sendImpl: () => Promise<{ messageId: string; whatsappMessageId: string }> = async () => ({ messageId: '', whatsappMessageId: `wamid.${randomBytes(4).toString('hex')}` })
const fakeSend = async (_db: unknown, _acc: string, params: SendMessageParams) => {
  sendCalls.push(params)
  return sendImpl()
}
const sendOk = () => { sendImpl = async () => ({ messageId: '', whatsappMessageId: `wamid.${randomBytes(4).toString('hex')}` }) }
const metaRejected = () => { sendImpl = async () => { throw new SendMessageError('meta_error', 'Template rejected by Meta', 502) } }
const metaLost = () => { sendImpl = async () => { throw new SendMessageError('meta_error', 'fetch failed', 502) } }
const deps = { sendMessage: fakeSend as never }

const rowsOf = async (order: string) => ((await w.admin.from('order_shipment_voucher_messages').select('*').eq('order_id', order).order('identifier_version')).data ?? []) as Array<Record<string, any>> // eslint-disable-line @typescript-eslint/no-explicit-any
const send = (order: string, actor: QaActor = w.logi, acc = w.acc, d: typeof deps | undefined = deps) => sendShipmentVoucher(w.ctxOf(actor, acc), w.admin, order, d)
const setSettings = async (patch: Record<string, unknown>) => { const r = await w.admin.from('order_shipment_settings').update(patch).eq('account_id', w.acc); if (r.error) throw r.error }

/** A ready_for_dispatch order with its chat in the logistics stage, a REAL validated voucher PDF in storage and a registered guide. */
async function ready(label: string) {
  const { order, conv } = await p.readyOrder(label, 100)
  await w.admin.from('conversation_routing').insert({ conversation_id: conv, account_id: w.acc, stage: 'logistics', version: 1 })
  const { data: l } = await w.admin.from('order_logistics').select('voucher_document_id').eq('order_id', order).single()
  const { data: d } = await w.admin.from('order_documents').select('storage_path').eq('id', (l as { voucher_document_id: string }).voucher_document_id).single()
  const path = (d as { storage_path: string }).storage_path
  expect((await w.admin.storage.from('order-docs').upload(path, pdfBytes(label), { contentType: 'application/pdf' })).error).toBeNull()
  w.track(path)
  const reg = await o.register(order)
  if ((reg.data as { ok?: boolean })?.ok !== true) throw new Error(`register failed: ${JSON.stringify(reg)}`)
  const ship = await o.shipment(order)
  return { order, conv, numero: ship.tracking_number as string, codigo: ship.tracking_code as string }
}

vi.setConfig({ testTimeout: 40_000, hookTimeout: 570_000 })

describe.skipIf(!QA_ENABLED)('voucher notice (voucher_envio_shalom): manual, one per guide, own ledger', () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.LOCAL_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.LOCAL_SERVICE
    await acquireQaLock()
    w = await createWorld()
    o = shalomOps(w)
    p = paymentsOps(w)
    await setShipmentFlag(w, w.acc, true)
    await setShipmentFlag(w, w.accForeign, true)
    const cfg = await w.admin.from('whatsapp_config').insert({ user_id: w.owner.id, account_id: w.acc, phone_number_id: '100000000000780', waba_id: '200000000000780', access_token: encrypt('qa-token-not-real'), status: 'connected' })
    if (cfg.error) throw cfg.error
    const tpl = await w.admin.from('message_templates').insert([
      { user_id: w.owner.id, account_id: w.acc, name: TEMPLATE, category: 'Utility', language: 'es', header_type: 'document', body_text: 'Hola {{1}}, te compartimos el voucher de tu envio Shalom. Orden: {{2}} Codigo: {{3}} Destino: {{4}}.', status: 'APPROVED' },
      { user_id: w.owner.id, account_id: w.acc, name: 'qa_voucher_image_header', category: 'Utility', language: 'es', header_type: 'image', body_text: 'Hola {{1}}, voucher {{2}} {{3}} {{4}}.', status: 'APPROVED' },
    ])
    if (tpl.error) throw tpl.error
  }, 570_000)
  beforeEach(async () => {
    await setSettings({ destination_customer_message_enabled: true, voucher_message_template_name: TEMPLATE, voucher_message_template_language: 'es', voucher_message_template_params: ['customer_name', 'shalom_number', 'shalom_code', 'destination'] })
    await w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: true }).eq('account_id', w.acc)
    await setShipmentFlag(w, w.acc, true)
    sendOk()
  })
  afterEach(() => {
    sendCalls = []
    meta.calls.length = 0
    meta.impl = null
  })
  afterAll(async () => {
    if (w) {
      await w.dispose()
      await clearCredentialsBreaker(w)
    }
    releaseQaLock()
  }, 90_000)

  // ------------------------------------------------------------------------------------------------------------------ the send
  describe('sending', () => {
    it('Logistics sends it once: the DOCUMENT template with the voucher as header, name / guide / code / destination, in the order\'s conversation; recorded in its own ledger; no DNI, no balance', async () => {
      const { order, conv, numero, codigo } = await ready('ok')
      const r = await send(order)
      expect(r).toMatchObject({ ok: true, status: 200, body: { status: 'sent', attempt: 1 } })
      expect(sendCalls).toHaveLength(1)
      expect(sendCalls[0]).toMatchObject({ conversationId: conv, messageType: 'template', templateName: TEMPLATE, origin: 'manual_reply' })
      expect(sendCalls[0].templateParams).toEqual(['Cliente Prueba', numero, codigo, 'Lima'])
      const mp = sendCalls[0].templateMessageParams as { body: string[]; headerMediaUrl: string }
      expect(mp.headerMediaUrl).toMatch(/^https?:\/\//)
      expect(JSON.stringify(sendCalls[0])).not.toContain('12345678') // the order DNI never goes into the template
      const rows = await rowsOf(order)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ status: 'sent', identifier_version: 1, attempt: 1, claim_token: null, error_code: null, template_name: TEMPLATE, conversation_id: conv, created_by: w.logi.id })
      expect(rows[0].wamid).toBeTruthy()
      expect(await o.count(order, 'shipment_voucher_sent')).toBe(1)
    })

    it('real send core: the notice lands in the SAME conversation as a template message with the DOCUMENT header link; no chat is created; Meta is only mocked', async () => {
      const { order, conv } = await ready('core')
      meta.impl = async () => ({ messageId: `wamid.${randomBytes(6).toString('hex')}` })
      const before = (await w.admin.from('conversations').select('id', { count: 'exact', head: true }).eq('account_id', w.acc)).count
      const r = await sendShipmentVoucher(w.ctxOf(w.logi, w.acc), w.admin, order)
      expect(r).toMatchObject({ ok: true, body: { status: 'sent' } })
      expect(meta.calls).toHaveLength(1)
      expect(meta.calls[0]).toMatchObject({ phoneNumberId: '100000000000780', templateName: TEMPLATE })
      expect((meta.calls[0].template as { header_type: string }).header_type).toBe('document')
      expect((meta.calls[0].messageParams as { headerMediaUrl: string }).headerMediaUrl).toMatch(/^https?:\/\//)
      const { data: msgs } = await w.admin.from('messages').select('id, content_type, template_name, message_id').eq('conversation_id', conv)
      expect(msgs).toHaveLength(1)
      expect(msgs![0]).toMatchObject({ content_type: 'template', template_name: TEMPLATE })
      expect((await w.admin.from('conversations').select('id', { count: 'exact', head: true }).eq('account_id', w.acc)).count).toBe(before)
      expect((await rowsOf(order))[0]).toMatchObject({ status: 'sent', message_row_id: msgs![0].id, wamid: msgs![0].message_id })
    })

    it('Supervisor can send too; works for a NOT TRACKED order (the voucher notice needs no balance)', async () => {
      const { order } = await ready('sup')
      expect(await send(order, w.sup)).toMatchObject({ ok: true })
      expect((await rowsOf(order))[0]).toMatchObject({ status: 'sent', created_by: w.sup.id })
    })

    it('one notice per guide: a second click / a second operator is refused and sends NOTHING; two clicks at the same moment send ONCE', async () => {
      const { order } = await ready('double')
      expect(await send(order)).toMatchObject({ ok: true })
      expect(await send(order)).toMatchObject({ ok: false, status: 409, error: 'already_sent' })
      expect(await send(order, w.sup)).toMatchObject({ ok: false, status: 409, error: 'already_sent' })
      expect(sendCalls).toHaveLength(1)

      const c = await ready('concurrent')
      sendImpl = async () => { await new Promise((r) => setTimeout(r, 150)); return { messageId: '', whatsappMessageId: `wamid.${randomBytes(4).toString('hex')}` } }
      const results = await Promise.all([send(c.order), send(c.order, w.sup), send(c.order)])
      expect(results.filter((r) => r.ok)).toHaveLength(1)
      expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.status === 409)).toBe(true)
      expect(sendCalls).toHaveLength(2) // one for 'double', one for 'concurrent'
      expect(await rowsOf(c.order)).toHaveLength(1)
    })

    it('a corrected guide is a NEW notice (version 2); the one of the old guide stays as history and is not sent again', async () => {
      const { order } = await ready('guide')
      expect(await send(order)).toMatchObject({ ok: true })
      await w.admin.rpc('correct_order_shipment_identifier', { p_account: w.acc, p_actor: w.sup.id, p_order: order, p_number: '88888801', p_code: 'ZZ01', p_now: at(20) })
      expect(await send(order)).toMatchObject({ ok: true })
      const rows = await rowsOf(order)
      expect(rows.map((r) => [r.identifier_version, r.status])).toEqual([[1, 'sent'], [2, 'sent']])
      expect(sendCalls).toHaveLength(2)
      expect(sendCalls[1].templateParams).toEqual(['Cliente Prueba', '88888801', 'ZZ01', 'Lima'])
    })
  })

  // ------------------------------------------------------------------------------------------------------------------ failures
  describe('failed / uncertain', () => {
    it('FAILED (Meta rejects): nothing sent, visible, NOT retried automatically (no tick touches it); a click on send says to use retry; only a person retries, once, no duplicate', async () => {
      const { order } = await ready('failed')
      metaRejected()
      expect(await send(order)).toMatchObject({ ok: false, status: 502, error: 'send_failed' })
      let [m] = await rowsOf(order)
      expect(m).toMatchObject({ status: 'failed', attempt: 1, error_code: 'meta_rejected' })
      expect(await o.shipment(order)).toMatchObject({ tracking_state: 'active' }) // tracking untouched
      // the automatic machinery never sends it
      const provider = createFakeProvider(() => 'origin')
      await runShalomTick(w.admin, { provider, cfg: CFG, now: () => new Date(Date.parse(at(0)) + 86_400_000), skipQueries: false, sendMessage: fakeSend as never })
      expect(await processCustomerMessages(w.admin, { cfg: CFG, now: () => new Date(Date.parse(at(0)) + 86_400_000), sendMessage: fakeSend as never })).toMatchObject({ claimed: 0 })
      expect(sendCalls).toHaveLength(1) // only the failed manual attempt
      sendOk()
      expect(await send(order)).toMatchObject({ ok: false, status: 409, error: 'failed_use_retry' })
      expect(await retryShipmentVoucher(w.ctxOf(w.logi, w.acc), w.admin, order, m.id, deps)).toMatchObject({ ok: true, body: { status: 'sent', attempt: 2 } })
      ;[m] = await rowsOf(order)
      expect(m).toMatchObject({ status: 'sent', attempt: 2, error_code: null })
      expect(sendCalls).toHaveLength(2)
      expect(await retryShipmentVoucher(w.ctxOf(w.logi, w.acc), w.admin, order, m.id, deps)).toMatchObject({ ok: false, status: 409, error: 'already_sent' })
      expect(await rowsOf(order)).toHaveLength(1)
    })

    it('UNCERTAIN (the outcome is unknown): never re-sent; send and retry are refused; Commercial / viewer / other accounts can not resolve; a person resolves it', async () => {
      const { order } = await ready('uncertain')
      metaLost()
      expect(await send(order)).toMatchObject({ ok: false, status: 409, error: 'send_uncertain' })
      const [m] = await rowsOf(order)
      expect(m).toMatchObject({ status: 'uncertain', error_code: 'meta_unreachable' })
      sendOk()
      expect(await send(order)).toMatchObject({ ok: false, status: 409, error: 'needs_resolution' })
      expect(await retryShipmentVoucher(w.ctxOf(w.logi, w.acc), w.admin, order, m.id, deps)).toMatchObject({ ok: false, status: 409, error: 'needs_resolution' })
      expect(sendCalls).toHaveLength(1)
      for (const actor of [w.comm, w.viewer]) expect(await resolveShipmentVoucher(w.ctxOf(actor, w.acc), w.admin, order, m.id, 'confirmed_sent')).toMatchObject({ ok: false })
      expect(await resolveShipmentVoucher(w.ctxOf(w.foreign, w.accForeign), w.admin, order, m.id, 'confirmed_sent')).toMatchObject({ ok: false, status: 404 })
      expect(await resolveShipmentVoucher(w.ctxOf(w.logi, w.acc), w.admin, order, m.id, 'maybe')).toMatchObject({ ok: false, status: 400 })
      expect(await resolveShipmentVoucher(w.ctxOf(w.logi, w.acc), w.admin, order, m.id, 'confirmed_not_sent')).toMatchObject({ ok: true, body: { status: 'failed' } })
      expect(await resolveShipmentVoucher(w.ctxOf(w.logi, w.acc), w.admin, order, m.id, 'confirmed_sent')).toMatchObject({ ok: false, status: 409, error: 'not_uncertain' })
      expect(await retryShipmentVoucher(w.ctxOf(w.sup, w.acc), w.admin, order, m.id, deps)).toMatchObject({ ok: true }) // a person retries after "it was not delivered"
      expect(sendCalls).toHaveLength(2)
    })

    it('"it was delivered" closes it as sent: no resend', async () => {
      const { order } = await ready('uncertain-sent')
      metaLost()
      await send(order)
      const [m] = await rowsOf(order)
      expect(await resolveShipmentVoucher(w.ctxOf(w.sup, w.acc), w.admin, order, m.id, 'confirmed_sent')).toMatchObject({ ok: true, body: { status: 'sent' } })
      sendOk()
      expect(await send(order)).toMatchObject({ ok: false, error: 'already_sent' })
      expect(sendCalls).toHaveLength(1)
    })

    it('failures BEFORE Meta are `failed`, nothing is sent, and a person can retry after fixing them (template not approved, voucher file missing, wrong header type)', async () => {
      const a = await ready('not-approved')
      await w.admin.from('message_templates').update({ status: 'PENDING' }).eq('account_id', w.acc).eq('name', TEMPLATE)
      expect(await send(a.order)).toMatchObject({ ok: false, error: 'template_not_approved' })
      await w.admin.from('message_templates').update({ status: 'APPROVED' }).eq('account_id', w.acc).eq('name', TEMPLATE)
      const [m] = await rowsOf(a.order)
      expect(m).toMatchObject({ status: 'failed', error_code: 'template_not_approved' })
      expect(sendCalls).toHaveLength(0)
      expect(await retryShipmentVoucher(w.ctxOf(w.logi, w.acc), w.admin, a.order, m.id, deps)).toMatchObject({ ok: true, body: { status: 'sent' } })

      const b = await ready('file-missing')
      const { data: dd } = await w.admin.from('order_logistics').select('voucher_document_id').eq('order_id', b.order).single()
      const { data: dp } = await w.admin.from('order_documents').select('storage_path').eq('id', (dd as { voucher_document_id: string }).voucher_document_id).single()
      await w.admin.storage.from('order-docs').remove([(dp as { storage_path: string }).storage_path])
      expect(await send(b.order)).toMatchObject({ ok: false, error: 'storage_failed' })

      const c = await ready('header-mismatch')
      await setSettings({ voucher_message_template_name: 'qa_voucher_image_header' })
      expect(await send(c.order)).toMatchObject({ ok: false, error: 'template_header_mismatch' })
      expect(sendCalls).toHaveLength(1)
    })
  })

  // ------------------------------------------------------------------------------------------------------------------ prerequisites, switches, roles
  describe('prerequisites, switches, roles', () => {
    it('refused without a guide, without a validated voucher, without a template, with the switch OFF; nothing is claimed or sent', async () => {
      const noGuide = (await p.readyOrder('no-guide', 100)).order
      expect(await send(noGuide)).toMatchObject({ ok: false, status: 409, error: 'no_shipment' })

      const a = await ready('prereq')
      await setSettings({ destination_customer_message_enabled: false })
      expect(await send(a.order)).toMatchObject({ ok: false, status: 409, error: 'customer_message_disabled' })
      await setSettings({ destination_customer_message_enabled: true, voucher_message_template_name: null, voucher_message_template_language: null, voucher_message_template_params: null })
      expect(await send(a.order)).toMatchObject({ ok: false, status: 409, error: 'template_not_configured' })
      await setSettings({ voucher_message_template_name: TEMPLATE, voucher_message_template_language: 'es', voucher_message_template_params: ['customer_name', 'shalom_number', 'shalom_code', 'destination'] })
      await w.admin.from('order_logistics').update({ voucher_document_id: null }).eq('order_id', a.order).then(() => undefined)
      expect(sendCalls).toHaveLength(0)
      expect(await rowsOf(a.order)).toEqual([])
      expect(await rowsOf(noGuide)).toEqual([])
    })

    it('Commercial, viewer and other accounts can neither send nor read it; the Shalom switch OFF and the logistics switch OFF refuse it', async () => {
      const { order } = await ready('roles')
      for (const actor of [w.comm, w.viewer]) expect(await send(order, actor)).toMatchObject({ ok: false })
      expect(await send(order, w.foreign, w.accForeign)).toMatchObject({ ok: false })
      await setShipmentFlag(w, w.acc, false)
      expect(await send(order)).toMatchObject({ ok: false, status: 403, error: 'feature_disabled' })
      await setShipmentFlag(w, w.acc, true)
      await w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: false }).eq('account_id', w.acc)
      expect(await send(order)).toMatchObject({ ok: false })
      await w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: true }).eq('account_id', w.acc)
      expect(sendCalls).toHaveLength(0)
      expect(await rowsOf(order)).toEqual([])
      expect(await send(order)).toMatchObject({ ok: true }) // and the right actor still can
    })

    it('RLS: operators read their ledger row; Commercial, viewer and other accounts read nothing; nobody writes it from the browser; the RPCs are service-role only', async () => {
      const { order } = await ready('rls')
      await send(order)
      const [msg] = await rowsOf(order)
      const read = async (a: QaActor) => ((await a.client.from('order_shipment_voucher_messages').select('id, status').eq('order_id', order)).data ?? []) as Array<{ id: string }>
      expect(await read(w.logi)).toHaveLength(1)
      expect(await read(w.sup)).toHaveLength(1)
      for (const a of [w.comm, w.viewer, w.foreign]) expect(await read(a)).toEqual([])
      for (const a of [w.logi, w.sup]) {
        expect((await a.client.from('order_shipment_voucher_messages').update({ status: 'failed' }).eq('id', msg.id).select('id')).data ?? []).toHaveLength(0)
        expect((await a.client.from('order_shipment_voucher_messages').delete().eq('id', msg.id).select('id')).data ?? []).toHaveLength(0)
        expect((await a.client.from('order_shipment_voucher_messages').insert({ account_id: w.acc, order_id: order, identifier_version: 9 })).error).not.toBeNull()
        expect((await a.client.rpc('begin_shipment_voucher_message', { p_account: w.acc, p_actor: a.id, p_order: order })).error).not.toBeNull()
        expect((await a.client.rpc('retry_shipment_voucher_message', { p_account: w.acc, p_actor: a.id, p_message: msg.id })).error).not.toBeNull()
      }
      expect((await rowsOf(order))[0].status).toBe('sent')
    })

    it('the ledger is protected: identity immutable, sent is final, illegal transitions refused, direct delete refused', async () => {
      const { order } = await ready('guard')
      await send(order)
      const [msg] = await rowsOf(order)
      expect((await w.admin.from('order_shipment_voucher_messages').update({ identifier_version: 9 }).eq('id', msg.id)).error?.code).toBe('42501')
      expect((await w.admin.from('order_shipment_voucher_messages').update({ error_code: 'x' }).eq('id', msg.id)).error?.code).toBe('42501') // sent is final
      expect((await w.admin.from('order_shipment_voucher_messages').delete().eq('id', msg.id)).error?.code).toBe('42501')
    })

    it('it is manual: neither the Shalom tick nor the customer-message sender ever creates or sends a voucher notice', async () => {
      const { order } = await ready('manual-only')
      const provider = createFakeProvider(() => 'destination')
      const at24h = () => new Date(Date.parse(at(0)) + 86_400_000)
      await runShalomTick(w.admin, { provider, cfg: CFG, now: at24h, skipQueries: false, sendMessage: fakeSend as never })
      await processCustomerMessages(w.admin, { cfg: CFG, now: at24h, sendMessage: fakeSend as never })
      expect(await rowsOf(order)).toEqual([])
      expect(sendCalls.filter((c) => c.templateName === TEMPLATE)).toEqual([])
    })
  })
})
