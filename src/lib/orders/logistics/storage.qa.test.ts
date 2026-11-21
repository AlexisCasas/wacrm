// @vitest-environment node
/**
 * PR-04 · QA against the REAL local Supabase (PostgREST + RLS + RPCs + Storage). Skipped unless LOCAL_URL is set, so the normal suite never needs it.
 * LOCAL ONLY: it refuses any host other than http://127.0.0.1:55321. Everything is synthetic (random passwords, throwaway accounts) and removed at the end.
 *
 *   eval "$(npx supabase status -o env | sed 's/^/export /')"; LOCAL_URL=$API_URL LOCAL_ANON=$ANON_KEY LOCAL_SERVICE=$SERVICE_ROLE_KEY npx vitest run src/lib/orders/logistics/storage.qa.test.ts
 */
import { randomBytes, randomUUID } from 'node:crypto'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { documentSignedUrl, listDocuments, uploadVoucher } from '@/lib/orders/logistics/documents'
import { ORDER_DOCS_BUCKET } from '@/lib/orders/logistics/constants'

const env = process.env
const ENABLED = Boolean(env.LOCAL_URL)
if (ENABLED && env.LOCAL_URL !== 'http://127.0.0.1:55321') throw new Error(`refusing to run against ${env.LOCAL_URL}`)

const noSession = { auth: { persistSession: false, autoRefreshToken: false } }
const tag = 'olq' + randomBytes(3).toString('hex')
const pdf = (seed: string) => new TextEncoder().encode(`%PDF-1.7\n% ${seed} ${randomBytes(8).toString('hex')}\n`)

interface Actor {
  id: string
  email: string
  password: string
  client: SupabaseClient
}

let admin: SupabaseClient
let anon: SupabaseClient
const created = { users: [] as string[], accounts: new Set<string>(), objects: [] as string[] }
let acc = ''
let accForeign = ''
let logi: Actor, sup: Actor, comm: Actor, viewer: Actor, foreign: Actor
let orderA = ''
let orderForeign = ''

async function mkUser(label: string): Promise<Actor> {
  const password = randomBytes(18).toString('base64url')
  const email = `${tag}-${label}@example.invalid`
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) throw error
  created.users.push(data.user.id)
  const client = createClient(env.LOCAL_URL!, env.LOCAL_ANON!, noSession)
  return { id: data.user.id, email, password, client }
}
const signIn = async (u: Actor) => {
  const { error } = await u.client.auth.signInWithPassword({ email: u.email, password: u.password })
  if (error) throw error
}
const accountOf = async (u: Actor) => ((await admin.from('profiles').select('account_id').eq('user_id', u.id).single()).data as { account_id: string }).account_id
const ctxOf = (u: Actor, accountId: string, role = 'agent') => ({ supabase: u.client, userId: u.id, accountId, role: role as 'agent' })
const track = (path: string | undefined) => path && created.objects.push(path)

async function mkOrder(accountId: string, key: string): Promise<string> {
  const { data, error } = await admin
    .from('order_confirmations')
    .insert({ account_id: accountId, customer_name: 'QA', phone: '900000000', product: 'P', quantity: 1, price: 10, destination: 'Lima', seller_name: 'S', confirmed_by_name: 'S', request_key: `${tag}-${key}`, delivery_status: 'held' })
    .select('id')
    .single()
  if (error) throw error
  return (data as { id: string }).id
}

const entriesIn = async (folder: string) => ((await admin.storage.from(ORDER_DOCS_BUCKET).list(folder, { limit: 1000 })).data ?? []).length
const objectExists = async (path: string) => {
  const folder = path.split('/').slice(0, -1).join('/')
  const name = path.split('/').pop()!
  const { data } = await admin.storage.from(ORDER_DOCS_BUCKET).list(folder, { limit: 100 })
  return Boolean(data?.some((o) => o.name === name))
}

// These tests make many real round trips (PostgREST + Storage + RPC) against the local stack; under the load of the whole suite the 5 s default is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 })

describe.skipIf(!ENABLED)('PR-04 vouchers against the real local stack (RLS + RPC + private Storage)', () => {
  beforeAll(async () => {
    admin = createClient(env.LOCAL_URL!, env.LOCAL_SERVICE!, noSession)
    anon = createClient(env.LOCAL_URL!, env.LOCAL_ANON!, noSession)
    const owner = await mkUser('owner')
    ;[logi, sup, comm, viewer, foreign] = await Promise.all([mkUser('logi'), mkUser('sup'), mkUser('comm'), mkUser('viewer'), mkUser('foreign')])
    acc = await accountOf(owner)
    accForeign = await accountOf(foreign)
    for (const u of [owner, logi, sup, comm, viewer, foreign]) created.accounts.add(await accountOf(u))
    for (const [u, role, accountRole] of [[logi, 'logistics', 'agent'], [sup, 'supervisor', 'agent'], [comm, 'commercial', 'agent'], [viewer, 'logistics', 'viewer']] as const) {
      expect((await admin.from('profiles').update({ account_id: acc, account_role: accountRole }).eq('user_id', u.id)).error).toBeNull()
      expect((await admin.from('profiles').update({ operational_role: role }).eq('user_id', u.id)).error).toBeNull()
    }
    expect((await admin.from('profiles').update({ operational_role: 'supervisor' }).eq('user_id', foreign.id)).error).toBeNull()
    for (const a of [acc, accForeign]) expect((await admin.from('order_integration_settings').upsert({ account_id: a, confirm_enabled: true, logistics_mvp_enabled: true })).error).toBeNull()
    for (const u of [logi, sup, comm, viewer, foreign]) await signIn(u)
    orderA = await mkOrder(acc, 'a')
    orderForeign = await mkOrder(accForeign, 'f')
  }, 60_000)

  afterAll(async () => {
    if (!ENABLED) return
    if (created.objects.length) await admin.storage.from(ORDER_DOCS_BUCKET).remove(created.objects)
    for (const a of created.accounts) await admin.from('accounts').delete().eq('id', a)
    for (const id of created.users) await admin.auth.admin.deleteUser(id)
  }, 60_000)

  describe('bucket protection (no policy exists for browser roles)', () => {
    it('the bucket is private', async () => {
      const { data } = await admin.storage.getBucket(ORDER_DOCS_BUCKET)
      expect(data?.public).toBe(false)
    })

    it('anon and authenticated users (even logistics of the SAME account) cannot upload, read, list or delete directly', async () => {
      const path = `account-${acc}/orders/${orderA}/vouchers/${randomUUID()}/direct.pdf`
      for (const client of [anon, logi.client, sup.client, comm.client, foreign.client]) {
        const up = await client.storage.from(ORDER_DOCS_BUCKET).upload(path, pdf('direct'), { contentType: 'application/pdf' })
        expect(up.error, 'direct upload must be refused').not.toBeNull()
        track(up.error ? undefined : path)
      }
      // an object placed by the backend is invisible / unreadable to browser roles
      const seed = `account-${acc}/orders/${orderA}/vouchers/${randomUUID()}/seed.pdf`
      expect((await admin.storage.from(ORDER_DOCS_BUCKET).upload(seed, pdf('seed'), { contentType: 'application/pdf' })).error).toBeNull()
      track(seed)
      const folder = seed.split('/').slice(0, -1).join('/')
      for (const client of [anon, logi.client, sup.client, foreign.client]) {
        expect((await client.storage.from(ORDER_DOCS_BUCKET).download(seed)).error).not.toBeNull()
        expect((await client.storage.from(ORDER_DOCS_BUCKET).list(folder)).data ?? []).toHaveLength(0)
        expect((await client.storage.from(ORDER_DOCS_BUCKET).createSignedUrl(seed, 60)).error).not.toBeNull()
        const removed = await client.storage.from(ORDER_DOCS_BUCKET).remove([seed])
        expect(removed.data ?? []).toHaveLength(0)
      }
      expect(await objectExists(seed)).toBe(true)
    })

    it('no public URL exists', async () => {
      const seed = `account-${acc}/orders/${orderA}/vouchers/${randomUUID()}/public.pdf`
      await admin.storage.from(ORDER_DOCS_BUCKET).upload(seed, pdf('public'), { contentType: 'application/pdf' })
      track(seed)
      const res = await fetch(`${env.LOCAL_URL}/storage/v1/object/public/${ORDER_DOCS_BUCKET}/${seed}`)
      expect(res.status).not.toBe(200)
    })

    it('the bucket allow-list rejects non voucher types even for the service role', async () => {
      const path = `account-${acc}/orders/${orderA}/vouchers/${randomUUID()}/x.txt`
      const up = await admin.storage.from(ORDER_DOCS_BUCKET).upload(path, new TextEncoder().encode('hello'), { contentType: 'text/plain' })
      expect(up.error).not.toBeNull()
    })
  })

  describe('direct upload from an order (order_id known: no matching)', () => {
    let documentId = ''
    let path = ''
    const key = `${tag}-direct-1`
    const bytes = pdf('direct-order')

    it('logistics uploads: private object under account/order, row direct + pending_review', async () => {
      const r = await uploadVoucher(ctxOf(logi, acc), admin, { fileName: 'Comprobante Ñandú.pdf', bytes, orderId: orderA, batchId: null, requestKey: key, allowDuplicate: false })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.status).toBe(201)
      documentId = r.body.document.id
      expect(r.body.document).toMatchObject({ order_id: orderA, association: 'direct', status: 'pending_review', kind: 'voucher', mime_type: 'application/pdf' })
      const { data } = await admin.from('order_documents').select('storage_path, account_id').eq('id', documentId).single()
      path = (data as { storage_path: string }).storage_path
      track(path)
      expect(path.startsWith(`account-${acc}/orders/${orderA}/vouchers/${documentId}/`)).toBe(true)
      expect((data as { account_id: string }).account_id).toBe(acc)
      expect(await objectExists(path)).toBe(true)
    })

    it('double click / HTTP retry (same request_key): same document, no second object, no second row', async () => {
      const r = await uploadVoucher(ctxOf(logi, acc), admin, { fileName: 'Comprobante.pdf', bytes, orderId: orderA, batchId: null, requestKey: key, allowDuplicate: false })
      expect(r).toMatchObject({ ok: true, status: 200, body: { created: false } })
      if (r.ok) expect(r.body.document.id).toBe(documentId)
      const { count } = await admin.from('order_documents').select('id', { count: 'exact', head: true }).eq('request_key', key)
      expect(count).toBe(1)
    })

    it('same request_key with different bytes is a conflict', async () => {
      const r = await uploadVoucher(ctxOf(logi, acc), admin, { fileName: 'x.pdf', bytes: pdf('other'), orderId: orderA, batchId: null, requestKey: key, allowDuplicate: false })
      expect(r).toMatchObject({ ok: false, status: 409, error: 'request_key_conflict' })
    })

    it('the same file under another key is reported as a duplicate and leaves NO orphan object', async () => {
      const folder = `account-${acc}/orders/${orderA}/vouchers`
      const before = await entriesIn(folder)
      const r = await uploadVoucher(ctxOf(sup, acc), admin, { fileName: 'again.pdf', bytes, orderId: orderA, batchId: null, requestKey: `${key}-b`, allowDuplicate: false })
      expect(r).toMatchObject({ ok: false, status: 409, error: 'duplicate' })
      expect(await entriesIn(folder)).toBe(before)
    })

    it('a person can deliberately keep a duplicate', async () => {
      const r = await uploadVoucher(ctxOf(sup, acc), admin, { fileName: 'again.pdf', bytes, orderId: orderA, batchId: null, requestKey: `${key}-c`, allowDuplicate: true })
      expect(r).toMatchObject({ ok: true, status: 201 })
      if (r.ok) {
        const { data } = await admin.from('order_documents').select('storage_path').eq('id', r.body.document.id).single()
        track((data as { storage_path: string }).storage_path)
      }
    })

    it('logistics and supervisor read the document and get a short-lived signed URL that really serves the bytes', async () => {
      for (const u of [logi, sup]) {
        const url = await documentSignedUrl(ctxOf(u, acc), admin, documentId)
        expect(url.ok).toBe(true)
        if (!url.ok) continue
        const res = await fetch(url.body.url)
        expect(res.status).toBe(200)
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
        expect(Object.keys(url.body)).not.toContain('storage_path') // the URL itself is a short-lived bearer; the stored path is never a field
      }
    })

    it('a signed URL stops working after its lifetime', async () => {
      const { data } = await admin.storage.from(ORDER_DOCS_BUCKET).createSignedUrl(path, 1)
      expect((await fetch(data!.signedUrl)).status).toBe(200)
      await new Promise((r) => setTimeout(r, 2500))
      expect((await fetch(data!.signedUrl)).status).not.toBe(200)
    })

    it('commercial, a viewer and another account get NOTHING (404, no URL, empty list)', async () => {
      for (const [u, a, role] of [[comm, acc, 'agent'], [viewer, acc, 'viewer'], [foreign, accForeign, 'agent']] as const) {
        expect(await documentSignedUrl(ctxOf(u, a, role), admin, documentId)).toMatchObject({ ok: false, status: 404 })
        const list = await listDocuments(ctxOf(u, a, role), { orderId: orderA })
        expect(list.ok && list.body.documents).toEqual([])
      }
      // even forging the account in the call: the RLS of the database is the second wall
      expect(await documentSignedUrl(ctxOf(foreign, acc), admin, documentId)).toMatchObject({ ok: false, status: 404 })
    })

    it('flag OFF: nobody reads anything (legacy account untouched) and the database refuses new vouchers', async () => {
      const folder = `account-${acc}/orders/${orderA}/vouchers`
      const before = await entriesIn(folder)
      await admin.from('order_integration_settings').update({ logistics_mvp_enabled: false }).eq('account_id', acc)
      try {
        expect(await documentSignedUrl(ctxOf(logi, acc), admin, documentId)).toMatchObject({ ok: false, status: 404 })
        const list = await listDocuments(ctxOf(logi, acc), {})
        expect(list.ok && list.body.documents).toEqual([])
        const r = await uploadVoucher(ctxOf(logi, acc), admin, { fileName: 'off.pdf', bytes: pdf('off'), orderId: orderA, batchId: null, requestKey: `${key}-off`, allowDuplicate: false })
        expect(r).toMatchObject({ ok: false, status: 403, error: 'feature_disabled' })
        expect(await entriesIn(folder)).toBe(before) // the refused call left no object behind
        const { count } = await admin.from('order_documents').select('id', { count: 'exact', head: true }).eq('request_key', `${key}-off`)
        expect(count).toBe(0)
      } finally {
        await admin.from('order_integration_settings').update({ logistics_mvp_enabled: true }).eq('account_id', acc)
      }
    })
  })

  describe('cross-account is impossible', () => {
    it('logistics of A cannot attach a voucher to an order of B (404) and no object stays behind', async () => {
      const r = await uploadVoucher(ctxOf(logi, acc), admin, { fileName: 'x.pdf', bytes: pdf('xacc'), orderId: orderForeign, batchId: null, requestKey: `${tag}-xacc`, allowDuplicate: false })
      expect(r).toMatchObject({ ok: false, status: 404, error: 'not_found' })
      const { data } = await admin.storage.from(ORDER_DOCS_BUCKET).list(`account-${acc}/orders/${orderForeign}/vouchers`, { limit: 10 })
      expect(data ?? []).toHaveLength(0)
      const { count } = await admin.from('order_documents').select('id', { count: 'exact', head: true }).eq('order_id', orderForeign)
      expect(count).toBe(0)
    })

    it('a commercial / viewer actor is refused by the database even if the API layer were bypassed', async () => {
      for (const u of [comm, viewer]) {
        const r = await uploadVoucher(ctxOf(u, acc), admin, { fileName: 'c.pdf', bytes: pdf('c' + u.id), orderId: orderA, batchId: null, requestKey: `${tag}-c-${u.id}`, allowDuplicate: false })
        expect(r).toMatchObject({ ok: false, status: 404 })
      }
    })
  })

  describe('bulk upload (pending association)', () => {
    const batch = randomUUID()

    it('persists N documents without any order, grouped by batch, resumable by querying the batch', async () => {
      const ids: string[] = []
      for (let i = 0; i < 3; i += 1) {
        const r = await uploadVoucher(ctxOf(logi, acc), admin, { fileName: `lote-${i}.pdf`, bytes: pdf('bulk' + i), orderId: null, batchId: batch, requestKey: `${tag}-bulk-${i}`, allowDuplicate: false })
        expect(r).toMatchObject({ ok: true, status: 201, body: { document: { order_id: null, association: 'pending' } } })
        if (r.ok) {
          ids.push(r.body.document.id)
          const { data } = await admin.from('order_documents').select('storage_path').eq('id', r.body.document.id).single()
          track((data as { storage_path: string }).storage_path)
        }
      }
      // "the user closes the screen": a later request still finds everything, by batch, without any browser state
      const list = await listDocuments(ctxOf(sup, acc), { batchId: batch, association: 'pending' })
      expect(list.ok && list.body.documents.map((d) => d.id).sort()).toEqual(ids.sort())
    })
  })
})
