// @vitest-environment node
/**
 * PR-04 · EVIDENCE from the order's own conversation against the REAL local stack: a media message that already lives in the chat is kept as a
 * PRIVATE snapshot of the order (private bucket, account/order scoped), without touching the Inbox, the message or the chat-media file.
 * Skipped unless LOCAL_URL is set. LOCAL ONLY (see test-support/qa-env).
 *
 *   eval "$(npx supabase status -o env | sed 's/^/export /')"; LOCAL_URL=$API_URL LOCAL_ANON=$ANON_KEY LOCAL_SERVICE=$SERVICE_ROLE_KEY npx vitest run src/lib/orders/logistics/evidence.qa.test.ts
 */
import { randomBytes, randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { uploadVoucher, documentSignedUrl } from '@/lib/orders/logistics/documents'
import { listChatMedia, selectEvidenceFromChat } from '@/lib/orders/logistics/evidence'
import { getOrderPanel } from '@/lib/orders/logistics/panel'
import { reviewDocument } from '@/lib/orders/logistics/review'
import { createWorld, pdfBytes, QA_ENABLED, type QaWorld } from '@/lib/orders/logistics/test-support/qa-env'

let w: QaWorld
let n = 0
const key = (p: string) => `${w.tag}-${p}-${(n += 1)}`
const URL_ = process.env.LOCAL_URL

/** A tiny but valid-by-signature JPEG with unique content. */
const jpeg = (seed: string) => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(`${seed}-${randomBytes(6).toString('hex')}`), 0xff, 0xd9])

const world: { conv: string; convOther: string; order: string; orderNotPacking: string; media: Record<string, { id: string; path: string; bytes: Uint8Array }>; proxyMsg: string; textMsg: string; otherConvMsg: string; foreignAccountPathMsg: string } = {
  conv: '',
  convOther: '',
  order: '',
  orderNotPacking: '',
  media: {},
  proxyMsg: '',
  textMsg: '',
  otherConvMsg: '',
  foreignAccountPathMsg: '',
}

async function mkConversation(accountId: string, ownerId: string, label: string): Promise<string> {
  const { data: contact, error: ce } = await w.admin.from('contacts').insert({ user_id: ownerId, account_id: accountId, phone: '5195' + Math.floor(Math.random() * 1e8), name: `QA ${label}` }).select('id').single()
  if (ce) throw ce
  const { data: conv, error } = await w.admin.from('conversations').insert({ user_id: ownerId, account_id: accountId, contact_id: (contact as { id: string }).id }).select('id').single()
  if (error) throw error
  return (conv as { id: string }).id
}

/** A media message whose file really is in chat-media (like the inbound mirror / an outbound upload). */
async function chatMedia(conversationId: string, accountId: string, name: string, bytes: Uint8Array, contentType = 'image/jpeg') {
  const path = `account-${accountId}/mirror/${w.tag}-${name}.jpg`
  const up = await w.admin.storage.from('chat-media').upload(path, bytes, { contentType, upsert: false })
  if (up.error) throw up.error
  const created = path
  chatObjects.push(created)
  const { data: pub } = w.admin.storage.from('chat-media').getPublicUrl(path)
  const { data, error } = await w.admin.from('messages').insert({ conversation_id: conversationId, sender_type: 'customer', content_type: 'image', media_url: pub.publicUrl, media_type: contentType }).select('id').single()
  if (error) throw error
  return { id: (data as { id: string }).id, path, bytes }
}
const chatObjects: string[] = []

const select = (messageId: string, requestKey = key('ev'), actor = w.logi, orderId = world.order) =>
  selectEvidenceFromChat(w.ctxOf(actor, w.acc), w.admin, orderId, { messageId, requestKey }, { supabaseUrl: URL_ })
const evidenceFolder = (orderId: string) => `account-${w.acc}/orders/${orderId}/evidence`
const entries = async (folder: string) => ((await w.admin.storage.from('order-docs').list(folder, { limit: 100 })).data ?? []).length
const panel = (orderId: string, actor = w.logi) => getOrderPanel(w.ctxOf(actor, w.acc), orderId)

async function validateVoucher(orderId: string, seed: string) {
  const up = await uploadVoucher(w.ctxOf(w.logi, w.acc), w.admin, { fileName: `${seed}.pdf`, bytes: pdfBytes(seed), orderId, batchId: null, requestKey: key(seed), allowDuplicate: false })
  if (!up.ok) throw new Error('voucher upload')
  const { data } = await w.admin.from('order_documents').select('storage_path').eq('id', up.body.document.id).single()
  w.track((data as { storage_path: string }).storage_path)
  const v = await reviewDocument(w.ctxOf(w.logi, w.acc), w.admin, up.body.document.id, { action: 'validate', reviewedData: { dni: '12345678' } })
  if (!v.ok) throw new Error('voucher validate')
}

describe.skipIf(!QA_ENABLED)('PR-04 evidence from the order conversation (private snapshot)', () => {
  beforeAll(async () => {
    w = await createWorld()
    world.conv = await mkConversation(w.acc, w.owner.id, 'order chat')
    world.convOther = await mkConversation(w.acc, w.owner.id, 'another chat')
    // PR-03 state: a confirmed order moved the chat to logistics (logistics + supervisor can read it; commercial cannot)
    const route = await w.admin.from('conversation_routing').insert({ conversation_id: world.conv, account_id: w.acc, stage: 'logistics', version: 1 })
    if (route.error) throw route.error
    world.order = await w.mkOrder(w.acc, 'ev', { conversation_id: world.conv })
    world.orderNotPacking = await w.mkOrder(w.acc, 'ev-np', { conversation_id: world.conv })

    world.media.a = await chatMedia(world.conv, w.acc, 'a', jpeg('a'))
    world.media.b = await chatMedia(world.conv, w.acc, 'b', jpeg('b'))
    world.media.c = await chatMedia(world.conv, w.acc, 'c', jpeg('c'))
    world.otherConvMsg = (await chatMedia(world.convOther, w.acc, 'other', jpeg('other'))).id
    // an inbound media that only exists behind the expiring Meta proxy (mirror OFF / not mirrored)
    world.proxyMsg = ((await w.admin.from('messages').insert({ conversation_id: world.conv, sender_type: 'customer', content_type: 'image', media_url: '/api/whatsapp/media/123456' }).select('id').single()).data as { id: string }).id
    world.textMsg = ((await w.admin.from('messages').insert({ conversation_id: world.conv, sender_type: 'customer', content_type: 'text', content_text: 'hola' }).select('id').single()).data as { id: string }).id
    // a message of THIS conversation whose media_url points into ANOTHER account's folder
    const foreignPath = `account-${w.accForeign}/mirror/${w.tag}-x.jpg`
    await w.admin.storage.from('chat-media').upload(foreignPath, jpeg('x'), { contentType: 'image/jpeg' })
    chatObjects.push(foreignPath)
    world.foreignAccountPathMsg = ((await w.admin.from('messages').insert({ conversation_id: world.conv, sender_type: 'customer', content_type: 'image', media_url: w.admin.storage.from('chat-media').getPublicUrl(foreignPath).data.publicUrl }).select('id').single()).data as { id: string }).id

    await validateVoucher(world.order, 'ev-v')
    expect((await w.admin.rpc('start_order_packaging', { p_account: w.acc, p_actor: w.logi.id, p_order: world.order })).data).toMatchObject({ ok: true, status: 'packing' })
    await validateVoucher(world.orderNotPacking, 'ev-v-np') // validated but packaging NOT started
  }, 120_000)

  afterAll(async () => {
    if (!w) return
    if (chatObjects.length) await w.admin.storage.from('chat-media').remove(chatObjects)
    await w.dispose()
  }, 90_000)

  it('lists the media of the ORDER\'S conversation only, flags what can be kept, previews only that', async () => {
    const r = await listChatMedia(w.ctxOf(w.logi, w.acc), world.order, URL_)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const ids = r.body.media.map((m) => m.message_id)
    expect(ids).toEqual(expect.arrayContaining([world.media.a.id, world.media.b.id, world.media.c.id, world.proxyMsg]))
    expect(ids).not.toContain(world.otherConvMsg) // another conversation
    expect(ids).not.toContain(world.textMsg) // not media
    expect(r.body.media.find((m) => m.message_id === world.proxyMsg)).toMatchObject({ available: false, preview_url: null })
    expect(r.body.media.find((m) => m.message_id === world.foreignAccountPathMsg)).toMatchObject({ available: false, preview_url: null })
    expect(r.body.media.find((m) => m.message_id === world.media.a.id)).toMatchObject({ available: true })
  })

  it('commercial, a viewer and another account cannot list or select (the chat stage and the logistics gate both apply)', async () => {
    for (const [actor, acc] of [[w.comm, w.acc], [w.viewer, w.acc]] as const) {
      expect(await listChatMedia(w.ctxOf(actor, acc), world.order, URL_)).toMatchObject({ ok: false, status: 404 })
      expect((await select(world.media.a.id, key('x'), actor)).ok).toBe(false)
    }
    expect(await listChatMedia(w.ctxOf(w.foreign, w.accForeign), world.order, URL_)).toMatchObject({ ok: false, status: 404 })
    const foreign = await selectEvidenceFromChat(w.ctxOf(w.foreign, w.accForeign), w.admin, world.order, { messageId: world.media.a.id, requestKey: key('f') }, { supabaseUrl: URL_ })
    expect(foreign).toMatchObject({ ok: false, status: 404 })
    expect(await entries(evidenceFolder(world.order))).toBe(0)
  })

  it('evidence needs a PACKING order (a validated voucher alone is not enough)', async () => {
    const r = await select(world.media.a.id, key('np'), w.logi, world.orderNotPacking)
    expect(r).toMatchObject({ ok: false, status: 409, error: 'not_packing' })
    expect(await entries(evidenceFolder(world.orderNotPacking))).toBe(0) // the snapshot made before the refusal was removed
  })

  it('refuses what cannot be evidence: another conversation, text, proxy-only media, a file of another account\'s folder', async () => {
    expect(await select(world.otherConvMsg)).toMatchObject({ ok: false, status: 404, error: 'message_not_found' })
    expect(await select(world.textMsg)).toMatchObject({ ok: false, status: 422, error: 'message_has_no_media' })
    expect(await select(world.proxyMsg)).toMatchObject({ ok: false, status: 422, error: 'media_not_stored' })
    expect(await select(world.foreignAccountPathMsg)).toMatchObject({ ok: false, status: 422, error: 'media_not_stored' })
    expect(await select(randomUUID())).toMatchObject({ ok: false, status: 404 })
    expect(await entries(evidenceFolder(world.order))).toBe(0)
  })

  let firstEvidence = ''
  let firstPath = ''
  it('selects evidence from the chat: a PRIVATE snapshot, identical bytes, tied to the order and the message; the chat is untouched', async () => {
    const before = (await w.admin.from('messages').select('*').eq('id', world.media.a.id).single()).data
    const k = key('ev-a')
    const r = await select(world.media.a.id, k)
    expect(r).toMatchObject({ ok: true, status: 201, body: { created: true, evidence: { kind: 'evidence', status: 'active', association: 'direct', order_id: world.order, mime_type: 'image/jpeg' } } })
    if (!r.ok) return
    firstEvidence = r.body.evidence.id
    const { data } = await w.admin.from('order_documents').select('storage_path, source, source_message_id, account_id').eq('id', firstEvidence).single()
    const row = data as { storage_path: string; source: string; source_message_id: string; account_id: string }
    firstPath = row.storage_path
    w.track(firstPath)
    expect(row).toMatchObject({ source: 'chat_message', source_message_id: world.media.a.id, account_id: w.acc })
    expect(firstPath.startsWith(`account-${w.acc}/orders/${world.order}/evidence/${firstEvidence}/`)).toBe(true)

    const snap = await w.admin.storage.from('order-docs').download(firstPath)
    expect(new Uint8Array(await snap.data!.arrayBuffer())).toEqual(world.media.a.bytes)
    // the original message and its public file are exactly as they were
    expect((await w.admin.from('messages').select('*').eq('id', world.media.a.id).single()).data).toEqual(before)
    const original = await w.admin.storage.from('chat-media').download(world.media.a.path)
    expect(new Uint8Array(await original.data!.arrayBuffer())).toEqual(world.media.a.bytes)
    // the snapshot is not public
    expect((await fetch(`${URL_}/storage/v1/object/public/order-docs/${firstPath}`)).status).not.toBe(200)

    const p = await panel(world.order)
    expect(p.ok && p.body.evidence).toMatchObject({ id: firstEvidence })
    expect(p.ok && p.body.logistics.status).toBe('packing')
  })

  it('double click / retry (same key) and the same message again (new key) never duplicate the snapshot', async () => {
    const folder = evidenceFolder(world.order)
    const before = await entries(folder)
    const sameKey = key('ev-dup')
    expect(await select(world.media.a.id, sameKey)).toMatchObject({ ok: true, body: { created: false, evidence: { id: firstEvidence } } })
    expect(await select(world.media.a.id, sameKey)).toMatchObject({ ok: true, status: 200, body: { created: false } })
    expect(await entries(folder)).toBe(before)
    const parallel = await Promise.all([select(world.media.a.id, key('p1'), w.logi), select(world.media.a.id, key('p2'), w.logi2)])
    expect(parallel.every((r) => r.ok && !r.body.created)).toBe(true)
    expect(await entries(folder)).toBe(before)
  })

  it('a different message supersedes the evidence (history kept) and the order points at the new one', async () => {
    const r = await select(world.media.b.id, key('ev-b'))
    expect(r).toMatchObject({ ok: true, status: 201, body: { created: true } })
    if (!r.ok) return
    const { data } = await w.admin.from('order_documents').select('id, status, storage_path').eq('order_id', world.order).eq('kind', 'evidence')
    const rows = data as Array<{ id: string; status: string; storage_path: string }>
    for (const row of rows) w.track(row.storage_path)
    expect(rows.map((x) => x.status).sort()).toEqual(['active', 'superseded'])
    expect(rows.find((x) => x.status === 'active')?.id).toBe(r.body.evidence.id)
    const p = await panel(world.order)
    expect(p.ok && p.body.evidence?.id).toBe(r.body.evidence.id)
    // a legitimate concurrent pair of different messages still leaves exactly ONE active evidence
    await Promise.all([select(world.media.c.id, key('c1'), w.logi), select(world.media.a.id, key('a2'), w.logi2)])
    const { count } = await w.admin.from('order_documents').select('id', { count: 'exact', head: true }).eq('order_id', world.order).eq('kind', 'evidence').eq('status', 'active')
    expect(count).toBe(1)
    const all = await w.admin.from('order_documents').select('storage_path').eq('order_id', world.order).eq('kind', 'evidence')
    for (const row of (all.data ?? []) as Array<{ storage_path: string }>) w.track(row.storage_path)
  })

  it('the snapshot SURVIVES the removal of the chat copy (contact cleanup / expiry) and stays viewable through a signed URL', async () => {
    const active = (await w.admin.from('order_documents').select('id, storage_path, content_hash').eq('order_id', world.order).eq('kind', 'evidence').eq('status', 'active').single()).data as { id: string; storage_path: string }
    const sourceId = (await w.admin.from('order_documents').select('source_message_id').eq('id', active.id).single()).data as { source_message_id: string }
    const media = Object.values(world.media).find((m) => m.id === sourceId.source_message_id)!
    await w.admin.storage.from('chat-media').remove([media.path])
    await w.admin.from('messages').delete().eq('id', media.id)
    const url = await documentSignedUrl(w.ctxOf(w.sup, w.acc), w.admin, active.id)
    expect(url.ok).toBe(true)
    if (!url.ok) return
    const res = await fetch(url.body.url)
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(media.bytes)
    const row = (await w.admin.from('order_documents').select('status, source_message_id').eq('id', active.id).single()).data
    expect(row).toEqual({ status: 'active', source_message_id: null }) // the evidence stays; only the link to the deleted message is gone
  })

  it('audit: the evidence selections are traced with message ids only; flag OFF refuses and leaves no snapshot behind', async () => {
    const p = await panel(world.order)
    if (!p.ok) throw new Error('panel')
    const events = p.body.events.filter((e) => e.event_type === 'evidence_selected')
    expect(events.length).toBeGreaterThanOrEqual(3)
    expect(events.every((e) => e.actor_name !== 'unknown' && 'message_id' in e.detail && !JSON.stringify(e.detail).includes('http'))).toBe(true)

    const remaining = Object.values(world.media).find((m) => m.id !== world.media.a.id && m.id !== world.media.b.id)!
    void remaining
    const folder = evidenceFolder(world.order)
    const before = await entries(folder)
    const extra = await chatMedia(world.conv, w.acc, 'late', jpeg('late'))
    await w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: false }).eq('account_id', w.acc)
    try {
      expect(await select(extra.id)).toMatchObject({ ok: false, status: 403, error: 'feature_disabled' })
    } finally {
      await w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: true }).eq('account_id', w.acc)
    }
    expect(await entries(folder)).toBe(before)
  })
})
