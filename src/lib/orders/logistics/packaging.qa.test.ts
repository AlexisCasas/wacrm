// @vitest-environment node
/**
 * PR-04 · PACKAGING end to end against the REAL local stack and the REAL WhatsApp send core (sendMessageToConversation: same conversation, same
 * persisted messages). Only the HTTP call to Meta is replaced (no real WhatsApp, no real number, no real template): `sendTemplateMessage` is mocked.
 * Covers: evidence -> operational template -> confirmed send -> "listo para despacho", plus double click, retry, Meta rejection, uncertain sends and
 * their manual resolution, interrupted processes, security and flag OFF. Skipped unless LOCAL_URL is set. LOCAL ONLY (see test-support/qa-env).
 *
 *   eval "$(npx supabase status -o env | sed 's/^/export /')"; LOCAL_URL=$API_URL LOCAL_ANON=$ANON_KEY LOCAL_SERVICE=$SERVICE_ROLE_KEY npx vitest run src/lib/orders/logistics/packaging.qa.test.ts
 */
import { randomBytes } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

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

import { encrypt } from '@/lib/whatsapp/encryption'
import { uploadVoucher } from '@/lib/orders/logistics/documents'
import { selectEvidenceFromChat } from '@/lib/orders/logistics/evidence'
import { resolveDispatch, sendPackagingTemplate, startPackaging } from '@/lib/orders/logistics/packaging'
import { getOrderPanel } from '@/lib/orders/logistics/panel'
import { reviewDocument } from '@/lib/orders/logistics/review'
import { createWorld, pdfBytes, QA_ENABLED, type QaActor, type QaWorld } from '@/lib/orders/logistics/test-support/qa-env'

let w: QaWorld
let n = 0
const key = (p: string) => `${w.tag}-${p}-${(n += 1)}`
const URL_ = process.env.LOCAL_URL
const chatObjects: string[] = []
const jpeg = (seed: string) => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(`${seed}-${randomBytes(6).toString('hex')}`), 0xff, 0xd9])
const okMeta = (wamid = `wamid.${randomBytes(6).toString('hex')}`) => async () => ({ messageId: wamid })
let templateName = ''

interface Prepared {
  order: string
  conv: string
  evidenceBytes: Uint8Array
}

async function prepare(label: string, opts: { stage?: 'logistics' | 'commercial'; evidence?: boolean; packing?: boolean; multiproduct?: boolean } = {}): Promise<Prepared> {
  const { stage = 'logistics', evidence = true, packing = true, multiproduct = false } = opts
  const { data: contact } = await w.admin.from('contacts').insert({ user_id: w.owner.id, account_id: w.acc, phone: `51900${Math.floor(100000 + Math.random() * 899999)}`, name: `QA ${label}` }).select('id').single()
  const { data: conv } = await w.admin.from('conversations').insert({ user_id: w.owner.id, account_id: w.acc, contact_id: (contact as { id: string }).id }).select('id').single()
  const convId = (conv as { id: string }).id
  await w.admin.from('conversation_routing').insert({ conversation_id: convId, account_id: w.acc, stage: 'logistics', version: 1 })

  let order: string
  if (multiproduct) {
    const { data, error } = await w.admin.rpc('create_order_confirmation', {
      p_account: w.acc,
      p_contact: (contact as { id: string }).id,
      p_conversation: convId,
      p_actor: w.comm.id,
      p_actor_name: 'Comercial QA',
      p_request_key: key('multi'),
      p_seller: w.comm.id,
      p_fields: { customer_name: 'Cliente Multi', phone: '51900000001', product: '1 x Alfa\n2 x Beta', quantity: '3', price: '20.00', destination: 'Lima', items: [{ product_name: 'Alfa', quantity: '1', unit_price: '10.00' }, { product_name: 'Beta', quantity: '2', unit_price: '5.00' }] },
    })
    if (error) throw error
    order = (data as Array<{ order_id: string }>)[0].order_id
  } else {
    order = await w.mkOrder(w.acc, label, { conversation_id: convId, customer_name: 'Cliente Prueba', dni: null, product: 'Producto Uno' })
  }

  const up = await uploadVoucher(w.ctxOf(w.logi, w.acc), w.admin, { fileName: `${label}.pdf`, bytes: pdfBytes(label), orderId: order, batchId: null, requestKey: key(label), allowDuplicate: false })
  if (!up.ok) throw new Error(`voucher upload failed: ${up.error}`)
  const { data: vrow } = await w.admin.from('order_documents').select('storage_path').eq('id', up.body.document.id).single()
  w.track((vrow as { storage_path: string }).storage_path)
  const v = await reviewDocument(w.ctxOf(w.logi, w.acc), w.admin, up.body.document.id, { action: 'validate', reviewedData: { dni: '12345678' } })
  if (!v.ok) throw new Error('validate failed')
  if (packing) {
    const s = await startPackaging(w.ctxOf(w.logi, w.acc), w.admin, order)
    if (!s.ok) throw new Error('start packaging failed')
  }

  const evidenceBytes = jpeg(label)
  if (evidence) {
    const path = `account-${w.acc}/mirror/${w.tag}-${label}.jpg`
    expect((await w.admin.storage.from('chat-media').upload(path, evidenceBytes, { contentType: 'image/jpeg' })).error).toBeNull()
    chatObjects.push(path)
    const { data: msg } = await w.admin.from('messages').insert({ conversation_id: convId, sender_type: 'customer', content_type: 'image', media_url: w.admin.storage.from('chat-media').getPublicUrl(path).data.publicUrl, media_type: 'image/jpeg' }).select('id').single()
    const e = await selectEvidenceFromChat(w.ctxOf(w.logi, w.acc), w.admin, order, { messageId: (msg as { id: string }).id, requestKey: key('ev') }, { supabaseUrl: URL_ })
    if (!e.ok) throw new Error(`evidence failed: ${e.error}`)
    const { data: erow } = await w.admin.from('order_documents').select('storage_path').eq('id', e.body.evidence.id).single()
    w.track((erow as { storage_path: string }).storage_path)
  }
  // the chat later goes back to the commercial stage (no row = commercial): the logistics operator may not work it any more
  if (stage === 'commercial') await w.admin.from('conversation_routing').delete().eq('conversation_id', convId)
  return { order, conv: convId, evidenceBytes }
}

const send = (order: string, requestKey: string, actor: QaActor = w.logi, acc = w.acc) => sendPackagingTemplate(w.ctxOf(actor, acc), w.admin, order, requestKey)
const panel = (order: string) => getOrderPanel(w.ctxOf(w.logi, w.acc), order)
const status = async (order: string) => {
  const p = await panel(order)
  return p.ok ? p.body.logistics.status : 'error'
}
const dispatches = async (order: string) => ((await w.admin.from('order_template_dispatches').select('request_key, status, attempt, wamid, error_code, resolution').eq('order_id', order).order('created_at')).data ?? []) as Array<{ request_key: string; status: string; attempt: number; wamid: string | null; error_code: string | null; resolution: string | null }>
const eventTypes = async (order: string) => {
  const p = await panel(order)
  return p.ok ? p.body.events.map((e) => e.event_type).reverse() : []
}
const setFlag = (value: boolean) => w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: value }).eq('account_id', w.acc)

describe.skipIf(!QA_ENABLED)('PR-04 packaging: evidence -> operational template -> listo para despacho (real send core, Meta mocked)', () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL_
    process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.LOCAL_SERVICE
    w = await createWorld()
    templateName = `${w.tag}_empaque`
    const cfg = await w.admin.from('whatsapp_config').insert({ user_id: w.owner.id, account_id: w.acc, phone_number_id: '100000000000001', waba_id: '200000000000001', access_token: encrypt('qa-token-not-real'), status: 'connected' })
    if (cfg.error) throw cfg.error
    const tpl = await w.admin.from('message_templates').insert({
      user_id: w.owner.id,
      account_id: w.acc,
      name: templateName,
      category: 'Utility',
      language: 'es',
      header_type: 'image',
      body_text: 'Hola {{1}}, tu pedido {{2}} esta en embalaje',
      status: 'APPROVED',
    })
    if (tpl.error) throw tpl.error
    meta.impl = okMeta()
  }, 120_000)

  afterAll(async () => {
    if (!w) return
    if (chatObjects.length) await w.admin.storage.from('chat-media').remove(chatObjects)
    await w.dispose()
  }, 90_000)

  it('without a configured template nothing is claimed and nothing is sent', async () => {
    const p = await prepare('cfg')
    expect(await send(p.order, key('s'))).toMatchObject({ ok: false, status: 409, error: 'template_not_configured' })
    expect(await dispatches(p.order)).toEqual([])
    expect(meta.calls).toHaveLength(0)
    // configure it (the settings are data of the account: nothing about the template is hardcoded in the code)
    const s = await w.admin.from('order_logistics_settings').insert({ account_id: w.acc, packaging_template_name: templateName, packaging_template_language: 'es', packaging_template_params: ['customer_name', 'product'] })
    expect(s.error).toBeNull()
  })

  it('the order must be in packing with evidence selected', async () => {
    const noPacking = await prepare('np', { packing: false, evidence: false })
    expect(await send(noPacking.order, key('s'))).toMatchObject({ ok: false, status: 409, error: 'not_packing' })
    const noEvidence = await prepare('ne', { evidence: false })
    expect(await send(noEvidence.order, key('s'))).toMatchObject({ ok: false, status: 409, error: 'evidence_required' })
    expect(await dispatches(noEvidence.order)).toEqual([])
    expect(meta.calls).toHaveLength(0)
  })

  describe('success', () => {
    let k = ''
    let p: Prepared
    let wamid = ''
    it('sends the template through the existing core: header = private signed evidence, body = order data, message persisted in the SAME conversation, order ready_for_dispatch', async () => {
      k = key('ok')
      p = await prepare('ok')
      wamid = `wamid.OK${randomBytes(4).toString('hex')}`
      meta.impl = okMeta(wamid)
      meta.calls.length = 0
      const r = await send(p.order, k)
      expect(r).toMatchObject({ ok: true, status: 200, body: { status: 'sent', order_status: 'ready_for_dispatch', attempt: 1 } })

      expect(meta.calls).toHaveLength(1)
      const call = meta.calls[0] as { templateName: string; language: string; to: string; messageParams: { body: string[]; headerMediaUrl?: string } }
      expect(call.templateName).toBe(templateName)
      expect(call.language).toBe('es')
      expect(call.messageParams.body).toEqual(['Cliente Prueba', 'Producto Uno'])
      expect(call.messageParams.headerMediaUrl).toContain('/storage/v1/object/sign/order-docs/')
      const header = await fetch(call.messageParams.headerMediaUrl!) // what Meta would fetch: the PRIVATE evidence through a signed URL
      expect(header.status).toBe(200)
      expect(new Uint8Array(await header.arrayBuffer())).toEqual(p.evidenceBytes)

      // the message lives in the order's conversation (no new chat, no new number) and is attributed to the person
      const { data: msgs } = await w.admin.from('messages').select('conversation_id, sender_type, sender_id, content_type, template_name, message_id, content_text').eq('conversation_id', p.conv).eq('content_type', 'template')
      expect(msgs).toHaveLength(1)
      expect(msgs![0]).toMatchObject({ conversation_id: p.conv, sender_type: 'agent', sender_id: w.logi.id, template_name: templateName, message_id: wamid })
      expect(msgs![0].content_text).toContain('Cliente Prueba')

      const [d] = await dispatches(p.order)
      expect(d).toMatchObject({ request_key: k, status: 'sent', attempt: 1, wamid })
      const pan = await panel(p.order)
      expect(pan.ok && pan.body.logistics).toMatchObject({ status: 'ready_for_dispatch' })
      expect(pan.ok && pan.body.dispatches).toMatchObject([{ status: 'sent', attempt: 1 }])
      expect((await eventTypes(p.order)).slice(-3)).toEqual(['template_send_started', 'template_sent', 'packaging_completed'])
      // routing (PR-03) and the conversation id are untouched
      expect((await w.admin.from('conversation_routing').select('stage').eq('conversation_id', p.conv).single()).data).toEqual({ stage: 'logistics' })
    })

    it('double click AFTER success: the same key answers `sent` and WhatsApp is not called again', async () => {
      const before = meta.calls.length
      expect(await send(p.order, k)).toMatchObject({ ok: true, body: { status: 'sent', replay: true } })
      expect(await send(p.order, k, w.sup)).toMatchObject({ ok: true, body: { replay: true } })
      expect(meta.calls).toHaveLength(before)
      expect(await dispatches(p.order)).toHaveLength(1)
    })

    it('a different key after completion is refused (the order is final for PR-04); nothing more can change', async () => {
      expect(await send(p.order, key('late'))).toMatchObject({ ok: false, status: 409, error: 'already_ready' })
      expect(await startPackaging(w.ctxOf(w.logi, w.acc), w.admin, p.order)).toMatchObject({ ok: false, status: 409, error: 'already_ready' })
    })
  })

  describe('concurrency', () => {
    it('two clicks / two operators at the same moment: ONE WhatsApp call, ONE persisted message', async () => {
      const p = await prepare('par')
      meta.calls.length = 0
      meta.impl = async () => {
        await new Promise((r) => setTimeout(r, 300))
        return { messageId: `wamid.PAR${randomBytes(4).toString('hex')}` }
      }
      const k = key('par')
      const results = await Promise.all([send(p.order, k, w.logi), send(p.order, k, w.logi2), send(p.order, key('par-b'), w.sup)])
      expect(meta.calls).toHaveLength(1)
      expect(results.filter((r) => r.ok && !('replay' in r.body && r.body.replay))).toHaveLength(1)
      for (const r of results.filter((x) => !x.ok)) expect(r).toMatchObject({ status: 409 })
      const { count } = await w.admin.from('messages').select('id', { count: 'exact', head: true }).eq('conversation_id', p.conv).eq('content_type', 'template')
      expect(count).toBe(1)
      expect(await status(p.order)).toBe('ready_for_dispatch')
      meta.impl = okMeta()
    })
  })

  describe('failures', () => {
    it('Meta rejects (nothing sent): `failed`, the order stays in packing, the SAME key retries as attempt 2 and completes', async () => {
      const p = await prepare('rej')
      meta.calls.length = 0
      meta.impl = async () => {
        throw new Error('(#132000) Number of parameters does not match the expected number of params')
      }
      const k = key('rej')
      expect(await send(p.order, k)).toMatchObject({ ok: false, status: 502, error: 'send_failed', extra: { status: 'failed', error_code: 'meta_rejected', order_status: 'packing' } })
      expect(await status(p.order)).toBe('packing')
      expect((await dispatches(p.order))[0]).toMatchObject({ status: 'failed', attempt: 1, error_code: 'meta_rejected' })
      const messages = await w.admin.from('messages').select('id', { count: 'exact', head: true }).eq('conversation_id', p.conv).eq('content_type', 'template')
      expect(messages.count).toBe(0) // nothing persisted for a failed send

      meta.impl = okMeta()
      expect(await send(p.order, k)).toMatchObject({ ok: true, body: { status: 'sent', order_status: 'ready_for_dispatch', attempt: 2 } })
      expect(await dispatches(p.order)).toHaveLength(1) // one operation, two attempts
      expect(await eventTypes(p.order).then((e) => e.filter((t) => t.startsWith('template_')))).toEqual(['template_send_started', 'template_failed', 'template_send_started', 'template_sent'])
    })

    it('network failure (Meta may have accepted it): `uncertain`, NEVER re-sent automatically, a person resolves it', async () => {
      const p = await prepare('unc')
      meta.calls.length = 0
      meta.impl = async () => {
        throw new Error('fetch failed')
      }
      const k = key('unc')
      expect(await send(p.order, k)).toMatchObject({ ok: false, status: 409, error: 'send_uncertain', extra: { status: 'uncertain', error_code: 'meta_unreachable' } })
      expect(meta.calls).toHaveLength(1)
      expect(await status(p.order)).toBe('packing')

      meta.impl = okMeta()
      expect(await send(p.order, k)).toMatchObject({ ok: false, status: 409, error: 'uncertain' }) // same key: NOT re-sent
      expect(await send(p.order, key('unc-b'), w.sup)).toMatchObject({ ok: false, status: 409, error: 'dispatch_open' }) // another key: NOT re-sent
      expect(meta.calls).toHaveLength(1)
      const [d] = await dispatches(p.order)
      expect(d.status).toBe('uncertain')

      // commercial / viewer / another account cannot resolve it
      for (const [actor, acc] of [[w.comm, w.acc], [w.viewer, w.acc], [w.foreign, w.accForeign]] as const) {
        const { data } = await w.admin.from('order_template_dispatches').select('id').eq('order_id', p.order).single()
        expect(await resolveDispatch(w.ctxOf(actor, acc), w.admin, p.order, { dispatchId: (data as { id: string }).id, resolution: 'confirmed_sent' })).toMatchObject({ ok: false, status: 404 })
      }
      const { data: row } = await w.admin.from('order_template_dispatches').select('id').eq('order_id', p.order).single()
      const id = (row as { id: string }).id
      // the person looked at the chat: it was NOT delivered -> back to packing, a new (legitimate) send is possible
      expect(await resolveDispatch(w.ctxOf(w.sup, w.acc), w.admin, p.order, { dispatchId: id, resolution: 'confirmed_not_sent' })).toMatchObject({ ok: true, body: { status: 'failed', order_status: 'packing' } })
      expect(await status(p.order)).toBe('packing')
      expect(await send(p.order, key('unc-c'))).toMatchObject({ ok: true, body: { status: 'sent', order_status: 'ready_for_dispatch' } })
      expect((await dispatches(p.order)).map((x) => `${x.status}${x.resolution ? '/' + x.resolution : ''}`)).toEqual(['failed/confirmed_not_sent', 'sent'])
    })

    it('uncertain but the person confirms it WAS delivered: the order completes, audited with who resolved it', async () => {
      const p = await prepare('unc2')
      meta.impl = async () => {
        throw new Error('The operation was aborted due to timeout')
      }
      expect(await send(p.order, key('unc2'))).toMatchObject({ ok: false, error: 'send_uncertain' })
      const { data } = await w.admin.from('order_template_dispatches').select('id').eq('order_id', p.order).single()
      const r = await resolveDispatch(w.ctxOf(w.logi2, w.acc), w.admin, p.order, { dispatchId: (data as { id: string }).id, resolution: 'confirmed_sent' })
      expect(r).toMatchObject({ ok: true, body: { status: 'sent', order_status: 'ready_for_dispatch', changed: true } })
      expect(await resolveDispatch(w.ctxOf(w.logi2, w.acc), w.admin, p.order, { dispatchId: (data as { id: string }).id, resolution: 'confirmed_sent' })).toMatchObject({ ok: true, body: { changed: false } })
      expect(await status(p.order)).toBe('ready_for_dispatch')
      const pan = await panel(p.order)
      const resolved = pan.ok ? pan.body.events.find((e) => e.event_type === 'template_resolved') : undefined
      expect(resolved).toMatchObject({ actor_name: expect.not.stringMatching(/^unknown$/), detail: { resolution: 'confirmed_sent' } })
      meta.impl = okMeta()
    })

    it('interrupted processes: a stale claim expires; a stale `sending` becomes uncertain and is never re-sent', async () => {
      const p = await prepare('stale')
      meta.calls.length = 0
      // a process that claimed the dispatch and died before calling Meta
      const claim = await w.admin.rpc('begin_template_dispatch', { p_account: w.acc, p_actor: w.logi.id, p_order: p.order, p_request_key: key('dead'), p_template_name: templateName, p_template_language: 'es' })
      expect(claim.data).toMatchObject({ ok: true })
      expect(await send(p.order, key('new1'))).toMatchObject({ ok: false, status: 409, error: 'dispatch_open' })
      await w.admin.from('order_template_dispatches').update({ claimed_at: new Date(Date.now() - 10 * 60_000).toISOString() }).eq('order_id', p.order)
      expect(await send(p.order, key('new1'))).toMatchObject({ ok: true, body: { status: 'sent' } })
      expect(meta.calls).toHaveLength(1)
      expect((await dispatches(p.order)).map((d) => `${d.status}:${d.error_code ?? '-'}`)).toEqual(['failed:claim_expired', 'sent:-'])

      const q = await prepare('stale2')
      meta.calls.length = 0
      const d = (await w.admin.rpc('begin_template_dispatch', { p_account: w.acc, p_actor: w.logi.id, p_order: q.order, p_request_key: key('half'), p_template_name: templateName, p_template_language: 'es' })).data as { dispatch_id: string }
      await w.admin.rpc('mark_template_dispatch_sending', { p_account: w.acc, p_actor: w.logi.id, p_dispatch: d.dispatch_id })
      await w.admin.from('order_template_dispatches').update({ sending_at: new Date(Date.now() - 10 * 60_000).toISOString() }).eq('id', d.dispatch_id)
      expect(await send(q.order, key('new2'))).toMatchObject({ ok: false, status: 409, error: 'dispatch_open' })
      expect(meta.calls).toHaveLength(0) // never re-sent
      expect((await dispatches(q.order))[0]).toMatchObject({ status: 'uncertain', error_code: 'send_interrupted' })
    })
  })

  describe('before Meta', () => {
    it('evidence of the wrong type for the template header -> `failed` evidence_type_mismatch, nothing sent, nothing persisted', async () => {
      const p = await prepare('pdfev', { evidence: false })
      // a PDF as the order evidence, template header is `image`
      const path = `account-${w.acc}/mirror/${w.tag}-doc.pdf`
      await w.admin.storage.from('chat-media').upload(path, pdfBytes('docev'), { contentType: 'application/pdf' })
      chatObjects.push(path)
      const { data: msg } = await w.admin.from('messages').insert({ conversation_id: p.conv, sender_type: 'customer', content_type: 'document', media_url: w.admin.storage.from('chat-media').getPublicUrl(path).data.publicUrl, media_type: 'application/pdf' }).select('id').single()
      const e = await selectEvidenceFromChat(w.ctxOf(w.logi, w.acc), w.admin, p.order, { messageId: (msg as { id: string }).id, requestKey: key('evpdf') }, { supabaseUrl: URL_ })
      expect(e.ok).toBe(true)
      if (e.ok) {
        const { data: erow } = await w.admin.from('order_documents').select('storage_path').eq('id', e.body.evidence.id).single()
        w.track((erow as { storage_path: string }).storage_path)
      }
      meta.calls.length = 0
      expect(await send(p.order, key('mm'))).toMatchObject({ ok: false, status: 409, error: 'evidence_type_mismatch', extra: { status: 'failed', order_status: 'packing' } })
      expect(meta.calls).toHaveLength(0)
      expect(await status(p.order)).toBe('packing')
    })

    it('a chat that is not in the operator\'s stage (routing = commercial) -> 403, nothing sent', async () => {
      const p = await prepare('stage', { stage: 'commercial' })
      meta.calls.length = 0
      expect(await send(p.order, key('st'))).toMatchObject({ ok: false, status: 403, error: 'conversation_forbidden' })
      expect(meta.calls).toHaveLength(0)
      expect(await status(p.order)).toBe('packing')
    })
  })

  describe('multiproduct and empty DNI', () => {
    it('one order, one voucher, one evidence, ONE template (not per item); the product variable is the summary and an empty DNI never leaves a parameter empty', async () => {
      await w.admin.from('order_logistics_settings').update({ packaging_template_params: ['customer_name', 'product'] }).eq('account_id', w.acc)
      const p = await prepare('multi', { multiproduct: true })
      meta.impl = okMeta()
      meta.calls.length = 0
      expect(await send(p.order, key('m'))).toMatchObject({ ok: true, body: { status: 'sent' } })
      expect((meta.calls[0] as { messageParams: { body: string[] } }).messageParams.body).toEqual(['Cliente Multi', '1 × Alfa + 2 × Beta'])
      expect(meta.calls).toHaveLength(1)
      expect(await dispatches(p.order)).toHaveLength(1)
    })
  })

  describe('security and flag', () => {
    it('commercial, a viewer and another account cannot send (404, nothing claimed, nothing sent)', async () => {
      const p = await prepare('sec')
      meta.calls.length = 0
      // the other account is fully configured too: the only thing that can refuse it is that the order is not its own
      expect((await w.admin.from('order_logistics_settings').insert({ account_id: w.accForeign, packaging_template_name: templateName, packaging_template_language: 'es', packaging_template_params: ['customer_name', 'product'] })).error).toBeNull()
      expect((await w.admin.from('message_templates').insert({ user_id: w.foreign.id, account_id: w.accForeign, name: templateName, category: 'Utility', language: 'es', header_type: 'image', body_text: 'Hola {{1}}, tu pedido {{2}} esta en embalaje', status: 'APPROVED' })).error).toBeNull()
      for (const [actor, acc] of [[w.comm, w.acc], [w.viewer, w.acc], [w.foreign, w.accForeign]] as const) {
        expect(await send(p.order, key('sec'), actor, acc)).toMatchObject({ ok: false, status: 404 })
      }
      expect(meta.calls).toHaveLength(0)
      expect(await dispatches(p.order)).toEqual([])
      expect(await status(p.order)).toBe('packing')
    })

    it('flag OFF: the database refuses (403 feature_disabled), nothing is claimed or sent', async () => {
      const p = await prepare('off')
      meta.calls.length = 0
      await setFlag(false)
      try {
        expect(await send(p.order, key('off'))).toMatchObject({ ok: false, status: 403, error: 'feature_disabled' })
      } finally {
        await setFlag(true)
      }
      expect(meta.calls).toHaveLength(0)
      expect(await dispatches(p.order)).toEqual([])
    })

    it('the template can only come from the account configuration: a template that is not approved is never used', async () => {
      const p = await prepare('na')
      await w.admin.from('message_templates').update({ status: 'PAUSED' }).eq('account_id', w.acc).eq('name', templateName)
      meta.calls.length = 0
      try {
        expect(await send(p.order, key('na'))).toMatchObject({ ok: false, status: 409, error: 'template_not_approved' })
      } finally {
        await w.admin.from('message_templates').update({ status: 'APPROVED' }).eq('account_id', w.acc).eq('name', templateName)
      }
      expect(meta.calls).toHaveLength(0)
      expect(await dispatches(p.order)).toEqual([])
    })
  })
})
