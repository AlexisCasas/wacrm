// @vitest-environment node
/**
 * PR-04 · packaging evidence UPLOADED from the operator's device (the chat may have no usable file) against the REAL local stack. Only the HTTP call to
 * Meta is replaced (no real WhatsApp): `sendTemplateMessage` is mocked. Skipped unless LOCAL_URL is set. LOCAL ONLY (see test-support/qa-env).
 *
 *   eval "$(npx supabase status -o env | sed 's/^/export /')"; LOCAL_URL=$API_URL LOCAL_ANON=$ANON_KEY LOCAL_SERVICE=$SERVICE_ROLE_KEY npx vitest run src/lib/orders/logistics/evidence-upload.qa.test.ts
 */
import { randomBytes } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const meta = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }))
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/meta-api')>()
  return {
    ...actual,
    sendTemplateMessage: async (args: Record<string, unknown>) => {
      meta.calls.push(args)
      return { messageId: `wamid.${randomBytes(6).toString('hex')}` }
    },
  }
})

import { MAX_DOCUMENT_BYTES } from '@/lib/orders/logistics/constants'
import { uploadVoucher } from '@/lib/orders/logistics/documents'
import { selectEvidenceFromChat, uploadEvidence } from '@/lib/orders/logistics/evidence'
import { sendPackagingTemplate } from '@/lib/orders/logistics/packaging'
import { getOrderPanel } from '@/lib/orders/logistics/panel'
import { reviewDocument } from '@/lib/orders/logistics/review'
import { createWorld, pdfBytes, QA_ENABLED, type QaActor, type QaWorld } from '@/lib/orders/logistics/test-support/qa-env'
import { encrypt } from '@/lib/whatsapp/encryption'

let w: QaWorld
let n = 0
const key = (p: string) => `${w.tag}-${p}-${(n += 1)}`
const URL_ = process.env.LOCAL_URL
const chatObjects: string[] = []

const jpeg = (seed: string) => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(`${seed}-${randomBytes(6).toString('hex')}`), 0xff, 0xd9])
const png = (seed: string) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(`${seed}-${randomBytes(6).toString('hex')}`)])

const upload = (orderId: string, bytes: Uint8Array, opts: { name?: string; requestKey?: string; actor?: QaActor; acc?: string } = {}) =>
  uploadEvidence(w.ctxOf(opts.actor ?? w.logi, opts.acc ?? w.acc), w.admin, orderId, { fileName: opts.name ?? 'embalaje.jpg', bytes, requestKey: opts.requestKey ?? key('up') })
const folder = async (orderId: string) => ((await w.admin.storage.from('order-docs').list(`account-${w.acc}/orders/${orderId}/evidence`, { limit: 100 })).data ?? []).length
const evidenceRows = async (orderId: string) => ((await w.admin.from('order_documents').select('id, status, source, source_message_id, uploaded_by, mime_type, size_bytes, storage_path, original_filename').eq('order_id', orderId).eq('kind', 'evidence').order('created_at')).data ?? []) as Array<{ id: string; status: string; source: string; source_message_id: string | null; uploaded_by: string; mime_type: string; size_bytes: number; storage_path: string; original_filename: string }>
const pointer = async (orderId: string) => ((await w.admin.from('order_logistics').select('evidence_document_id, status').eq('order_id', orderId).single()).data as { evidence_document_id: string | null; status: string })
const events = async (orderId: string) => {
  const p = await getOrderPanel(w.ctxOf(w.logi, w.acc), orderId)
  return p.ok ? p.body.events : []
}

async function mkConversation(accountId: string, ownerId: string, label: string): Promise<string> {
  const { data: contact, error: ce } = await w.admin.from('contacts').insert({ user_id: ownerId, account_id: accountId, phone: `51900${Math.floor(100000 + Math.random() * 899999)}`, name: `QA ${label}` }).select('id').single()
  if (ce) throw ce
  const { data: conv, error } = await w.admin.from('conversations').insert({ user_id: ownerId, account_id: accountId, contact_id: (contact as { id: string }).id }).select('id').single()
  if (error) throw error
  const id = (conv as { id: string }).id
  await w.admin.from('conversation_routing').insert({ conversation_id: id, account_id: accountId, stage: 'logistics', version: 1 })
  return id
}

/** An order whose voucher is validated; `packing` also starts packaging. The chat has NO media at all unless the test adds some. */
async function prepare(label: string, packing = true): Promise<{ order: string; conv: string }> {
  const conv = await mkConversation(w.acc, w.owner.id, label)
  const order = await w.mkOrder(w.acc, `up-${label}-${(n += 1)}`, { conversation_id: conv })
  const up = await uploadVoucher(w.ctxOf(w.logi, w.acc), w.admin, { fileName: 'v.pdf', bytes: pdfBytes(label), orderId: order, batchId: null, requestKey: key('v'), allowDuplicate: false })
  if (!up.ok) throw new Error('voucher upload')
  const { data } = await w.admin.from('order_documents').select('storage_path').eq('id', up.body.document.id).single()
  w.track((data as { storage_path: string }).storage_path)
  const v = await reviewDocument(w.ctxOf(w.logi, w.acc), w.admin, up.body.document.id, { action: 'validate', reviewedData: { dni: '12345678' } })
  if (!v.ok) throw new Error('voucher validate')
  if (packing) expect((await w.admin.rpc('start_order_packaging', { p_account: w.acc, p_actor: w.logi.id, p_order: order })).data).toMatchObject({ ok: true, status: 'packing' })
  return { order, conv }
}

async function chatImage(conversationId: string, name: string) {
  const bytes = jpeg(name)
  const path = `account-${w.acc}/mirror/${w.tag}-${name}.jpg`
  const up = await w.admin.storage.from('chat-media').upload(path, bytes, { contentType: 'image/jpeg', upsert: false })
  if (up.error) throw up.error
  chatObjects.push(path)
  const { data: pub } = w.admin.storage.from('chat-media').getPublicUrl(path)
  const { data, error } = await w.admin.from('messages').insert({ conversation_id: conversationId, sender_type: 'customer', content_type: 'image', media_url: pub.publicUrl, media_type: 'image/jpeg' }).select('id').single()
  if (error) throw error
  return (data as { id: string }).id
}

// These tests make many real round trips (PostgREST + Storage + RPC) against the local stack; under the load of the whole suite the 5 s default is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 })

describe.skipIf(!QA_ENABLED)('PR-04 evidence uploaded from the device (private, audited, no chat file needed)', () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL_
    process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.LOCAL_SERVICE
    w = await createWorld()
  }, 120_000)

  afterAll(async () => {
    if (!w) return
    if (chatObjects.length) await w.admin.storage.from('chat-media').remove(chatObjects)
    await w.dispose()
  }, 90_000)

  it('logistics uploads evidence although the chat has no files: private object, active row, order pointer, audited with who / when / file / origin', async () => {
    const p = await prepare('ok')
    const bytes = jpeg('pack')
    const r = await upload(p.order, bytes, { name: 'Foto Embalaje ñandú.JPG' })
    expect(r).toMatchObject({ ok: true, status: 201, body: { created: true, evidence: { kind: 'evidence', status: 'active', mime_type: 'image/jpeg' } } })
    const rows = await evidenceRows(p.order)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'active', source: 'upload', source_message_id: null, uploaded_by: w.logi.id, mime_type: 'image/jpeg', size_bytes: bytes.byteLength })
    expect(rows[0].storage_path.startsWith(`account-${w.acc}/orders/${p.order}/evidence/`)).toBe(true)
    expect(rows[0].original_filename).toMatch(/^[A-Za-z0-9._-]+\.jpg$/)
    w.track(rows[0].storage_path)
    // private bucket: the object exists only there, and it is the exact file
    const dl = await w.admin.storage.from('order-docs').download(rows[0].storage_path)
    expect(Buffer.from(await dl.data!.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true)
    expect((await fetch(`${URL_}/storage/v1/object/public/order-docs/${rows[0].storage_path}`)).ok).toBe(false)
    expect((await pointer(p.order)).evidence_document_id).toBe(rows[0].id)
    // the trail says who, when, which order / file, the result and the ORIGIN
    const ev = (await events(p.order)).find((e) => e.event_type === 'evidence_uploaded')
    expect(ev).toMatchObject({ event_type: 'evidence_uploaded', outcome: 'ok', actor_name: expect.any(String) })
    expect(ev?.created_at).toBeTruthy()
    const { data: raw } = await w.admin.from('order_logistics_events').select('actor_user_id, order_id, document_id, detail').eq('order_id', p.order).eq('event_type', 'evidence_uploaded').single()
    expect(raw).toMatchObject({ actor_user_id: w.logi.id, order_id: p.order, document_id: rows[0].id, detail: { source: 'upload', mime: 'image/jpeg' } })
  })

  it('supervisor can upload too; a PDF is accepted', async () => {
    const p = await prepare('sup')
    expect(await upload(p.order, pdfBytes('evidence-sup'), { name: 'embalaje.pdf', actor: w.sup })).toMatchObject({ ok: true, status: 201, body: { evidence: { mime_type: 'application/pdf' } } })
    expect((await evidenceRows(p.order))[0]).toMatchObject({ uploaded_by: w.sup.id, source: 'upload', mime_type: 'application/pdf' })
  })

  it('commercial, viewer, no-area and another account CANNOT upload (database-enforced): nothing is stored', async () => {
    const p = await prepare('deny')
    const bytes = jpeg('deny')
    const before = await folder(p.order)
    for (const actor of [w.comm, w.viewer]) {
      const r = await upload(p.order, bytes, { actor })
      expect(r.ok).toBe(false)
      expect([403, 404]).toContain((r as { status: number }).status)
    }
    // a member with NO operational area
    await w.admin.from('profiles').update({ operational_role: null }).eq('user_id', w.logi2.id)
    const noArea = await upload(p.order, bytes, { actor: w.logi2 })
    expect(noArea.ok).toBe(false)
    expect([403, 404]).toContain((noArea as { status: number }).status)
    await w.admin.from('profiles').update({ operational_role: 'logistics' }).eq('user_id', w.logi2.id)
    // another account's user (its own account context) addressing this order
    expect(await upload(p.order, bytes, { actor: w.foreign, acc: w.accForeign })).toMatchObject({ ok: false, status: 404 })
    expect(await folder(p.order)).toBe(before)
    expect(await evidenceRows(p.order)).toEqual([])
    expect((await pointer(p.order)).evidence_document_id).toBeNull()
  })

  it('cross-account is impossible: an order of another account is not found and nothing is written to either account', async () => {
    const p = await prepare('x')
    const foreignOrder = await w.mkOrder(w.accForeign, `up-foreign-${(n += 1)}`)
    expect(await upload(foreignOrder, jpeg('f'))).toMatchObject({ ok: false, status: 404 })
    expect((await w.admin.from('order_documents').select('id').eq('order_id', foreignOrder)).data).toEqual([])
    expect(await evidenceRows(p.order)).toEqual([])
  })

  it('validates before storing: empty, too large, real type (not the name), extension; nothing is left behind', async () => {
    const p = await prepare('val')
    const before = await folder(p.order)
    expect(await upload(p.order, new Uint8Array(0))).toMatchObject({ ok: false, status: 400, error: 'empty_file' })
    expect(await upload(p.order, new Uint8Array(MAX_DOCUMENT_BYTES + 1).fill(1))).toMatchObject({ ok: false, status: 413, error: 'file_too_large' })
    expect(await upload(p.order, new TextEncoder().encode('MZ not an image'), { name: 'foto.jpg' })).toMatchObject({ ok: false, status: 415, error: 'unsupported_evidence_type' })
    expect(await upload(p.order, jpeg('exe'), { name: 'foto.exe' })).toMatchObject({ ok: false, status: 415, error: 'unsupported_extension' })
    expect(await upload(p.order, jpeg('svg'), { name: 'dibujo.svg' })).toMatchObject({ ok: false, status: 415, error: 'unsupported_extension' })
    expect(await upload(p.order, jpeg('k'), { requestKey: 'not a valid key!' })).toMatchObject({ ok: false, status: 400, error: 'invalid_request_key' })
    expect(await upload('not-a-uuid', jpeg('o'))).toMatchObject({ ok: false, status: 400, error: 'invalid_order_id' })
    expect(await folder(p.order)).toBe(before)
    expect(await evidenceRows(p.order)).toEqual([])
    // the declared name never decides the type: PNG bytes named .jpg are stored as the PNG they are; a name without extension is fine
    const asPng = await upload(p.order, png('p'), { name: 'camara.jpg' })
    expect(asPng).toMatchObject({ ok: true, body: { evidence: { mime_type: 'image/png' } } })
    expect((await evidenceRows(p.order))[0].original_filename).toMatch(/\.png$/)
    expect(await upload(p.order, jpeg('noext'), { name: 'IMG_0001' })).toMatchObject({ ok: true })
    for (const row of await evidenceRows(p.order)) w.track(row.storage_path)
  })

  it('only while packing: before packaging started it is refused (409) and leaves no object', async () => {
    const p = await prepare('np', false)
    expect(await upload(p.order, jpeg('np'))).toMatchObject({ ok: false, status: 409, error: 'not_packing' })
    expect(await folder(p.order)).toBe(0)
  })

  it('idempotent: same key = same evidence; same file again changes nothing (no duplicate object); a different file supersedes and keeps history', async () => {
    const p = await prepare('idem')
    const bytes = jpeg('idem')
    const k = key('idem')
    const first = await upload(p.order, bytes, { requestKey: k })
    expect(first).toMatchObject({ ok: true, status: 201 })
    expect(await upload(p.order, bytes, { requestKey: k })).toMatchObject({ ok: true, status: 200, body: { created: false } })
    expect(await upload(p.order, bytes, { requestKey: key('same-file-new-key') })).toMatchObject({ ok: true, status: 200, body: { created: false } })
    expect(await upload(p.order, jpeg('other'), { requestKey: k })).toMatchObject({ ok: false, status: 409, error: 'request_key_conflict' })
    expect(await evidenceRows(p.order)).toHaveLength(1)
    expect(await folder(p.order)).toBe(1)
    // a genuinely different file replaces it
    expect(await upload(p.order, jpeg('second'))).toMatchObject({ ok: true, status: 201 })
    const rows = await evidenceRows(p.order)
    expect(rows.map((r) => r.status)).toEqual(['superseded', 'active'])
    expect((await pointer(p.order)).evidence_document_id).toBe(rows[1].id)
    for (const r of rows) w.track(r.storage_path)
  })

  it('the chat keeps working as an alternative: choosing a chat image and uploading supersede each other, with the origin of each recorded', async () => {
    const p = await prepare('mix')
    const msg = await chatImage(p.conv, 'mix')
    expect(await selectEvidenceFromChat(w.ctxOf(w.logi, w.acc), w.admin, p.order, { messageId: msg, requestKey: key('chat') }, { supabaseUrl: URL_ })).toMatchObject({ ok: true, status: 201 })
    expect(await upload(p.order, jpeg('device'))).toMatchObject({ ok: true, status: 201 })
    expect(await selectEvidenceFromChat(w.ctxOf(w.logi, w.acc), w.admin, p.order, { messageId: msg, requestKey: key('chat2') }, { supabaseUrl: URL_ })).toMatchObject({ ok: true, status: 201 })
    const rows = await evidenceRows(p.order)
    expect(rows.map((r) => `${r.source}:${r.status}`)).toEqual(['chat_message:superseded', 'upload:superseded', 'chat_message:active'])
    expect((await events(p.order)).map((e) => e.event_type).filter((t) => t.startsWith('evidence')).reverse()).toEqual(['evidence_selected', 'evidence_uploaded', 'evidence_selected'])
    for (const r of rows) w.track(r.storage_path)
  })

  it('an uploaded evidence enables the operational template and the order reaches ready_for_dispatch (chat without files)', async () => {
    const cfg = await w.admin.from('whatsapp_config').insert({ user_id: w.owner.id, account_id: w.acc, phone_number_id: '100000000000009', waba_id: '200000000000009', access_token: encrypt('qa-token-not-real'), status: 'connected' })
    if (cfg.error) throw cfg.error
    const name = `${w.tag}_empaque`
    expect((await w.admin.from('message_templates').insert({ user_id: w.owner.id, account_id: w.acc, name, category: 'Utility', language: 'es', header_type: 'image', body_text: 'Hola {{1}}, tu pedido {{2}} esta en embalaje', status: 'APPROVED' })).error).toBeNull()
    expect((await w.admin.from('order_logistics_settings').insert({ account_id: w.acc, packaging_template_name: name, packaging_template_language: 'es', packaging_template_params: ['customer_name', 'product'] })).error).toBeNull()

    const p = await prepare('send')
    // no evidence yet: the send is refused
    expect(await sendPackagingTemplate(w.ctxOf(w.logi, w.acc), w.admin, p.order, key('s0'))).toMatchObject({ ok: false, status: 409, error: 'evidence_required' })
    const up = await upload(p.order, jpeg('send'))
    expect(up.ok).toBe(true)
    const sent = await sendPackagingTemplate(w.ctxOf(w.logi, w.acc), w.admin, p.order, key('s1'))
    expect(sent).toMatchObject({ ok: true, body: { status: 'sent', order_status: 'ready_for_dispatch' } })
    expect(meta.calls).toHaveLength(1)
    const [d] = ((await w.admin.from('order_template_dispatches').select('status, evidence_document_id').eq('order_id', p.order)).data ?? []) as Array<{ status: string; evidence_document_id: string }>
    expect(d).toMatchObject({ status: 'sent', evidence_document_id: (await evidenceRows(p.order))[0].id })
    expect((await pointer(p.order)).status).toBe('ready_for_dispatch')
    // once ready, the evidence is frozen
    expect(await upload(p.order, jpeg('late'))).toMatchObject({ ok: false, status: 409, error: 'already_ready' })
    for (const r of await evidenceRows(p.order)) w.track(r.storage_path)
  })

  it('flag OFF: the database refuses the upload (nothing stored); with the flag back ON it works', async () => {
    const p = await prepare('flag')
    await w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: false }).eq('account_id', w.acc)
    try {
      const r = await upload(p.order, jpeg('flag'))
      expect(r.ok).toBe(false)
      expect([403, 404]).toContain((r as { status: number }).status)
      expect(await folder(p.order)).toBe(0)
      expect(await evidenceRows(p.order)).toEqual([])
    } finally {
      await w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: true }).eq('account_id', w.acc)
    }
    expect(await upload(p.order, jpeg('flag2'))).toMatchObject({ ok: true })
    for (const r of await evidenceRows(p.order)) w.track(r.storage_path)
  })

  it('browser clients cannot call the new RPC or write evidence rows directly', async () => {
    const p = await prepare('rpc')
    const args = { p_account: w.acc, p_actor: w.logi.id, p_order: p.order, p_doc_id: crypto.randomUUID(), p_request_key: key('rpc'), p_storage_path: `account-${w.acc}/x`, p_filename: 'x.jpg', p_mime: 'image/jpeg', p_size: 1, p_hash: '0'.repeat(64) }
    for (const actor of [w.logi, w.sup, w.comm, w.viewer, w.foreign]) expect((await actor.client.rpc('register_order_evidence_upload', args)).error).not.toBeNull()
    expect((await w.logi.client.from('order_documents').insert({ id: crypto.randomUUID(), account_id: w.acc, order_id: p.order, kind: 'evidence', status: 'active', association: 'direct', request_key: key('d'), storage_path: `account-${w.acc}/x`, original_filename: 'x.jpg', mime_type: 'image/jpeg', size_bytes: 1, content_hash: '0'.repeat(64), source: 'upload', uploaded_by: w.logi.id })).error).not.toBeNull()
    expect(await evidenceRows(p.order)).toEqual([])
  })
})
