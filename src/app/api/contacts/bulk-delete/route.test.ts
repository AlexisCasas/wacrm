import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/contacts/bulk-delete — auth, validation, tenant scoping, all-or-nothing database contract, and the chat-media cleanup
// (what is deleted from Storage, what is preserved, and the order: Storage first, abort before the database if Storage fails).
const ACCOUNT_A = '11111111-1111-4111-8111-111111111111'
const ACCOUNT_B = '99999999-9999-4999-8999-999999999999'
const BASE = 'https://supabase.example.com'
const PUBLIC = `${BASE}/storage/v1/object/public`
let callerRole = 'agent'

const db = vi.hoisted(() => ({
  calls: [] as string[],                                   // ordered log of RPC + storage calls
  rpcArgs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  candidates: { data: [] as unknown[], error: null as { message: string } | null },
  bulk: { data: { deleted: 2, conversations_deleted: 2, messages_deleted: 7, runs_deleted: 1, pending_automations_deleted: 0, notifications_deleted: 1, media: [] as unknown[] } as unknown, error: null as { message: string } | null },
  store: new Map<string, number>(),                        // "bucket/path" -> size in bytes (fake Storage)
  failRemove: null as null | ((bucket: string, paths: string[]) => string | null),
  tablesTouched: [] as string[],
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = () => Promise.resolve(
        table === 'profiles' ? { data: { account_id: ACCOUNT_A, account_role: callerRole }, error: null }
          : table === 'accounts' ? { data: { id: ACCOUNT_A, name: 'A' }, error: null }
            : { data: null, error: null })
      return b
    },
  })),
}))
vi.mock('@/lib/contacts/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      db.calls.push(fn); db.rpcArgs.push({ fn, args })
      return Promise.resolve(fn === 'contact_chat_media_candidates' ? db.candidates : db.bulk)
    },
    from: (t: string) => { db.tablesTouched.push(t); throw new Error('the route must only call RPCs and Storage') },
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          db.calls.push(`storage.remove:${bucket}`)
          const err = db.failRemove?.(bucket, paths)
          if (err) return { data: null, error: { message: err } }
          const removed: Array<{ name: string }> = []
          for (const p of paths) if (db.store.delete(`${bucket}/${p}`)) removed.push({ name: p })
          return { data: removed, error: null }
        },
      }),
    },
  }),
}))

import { POST, MAX_BULK_DELETE } from './route'

const U1 = '22222222-2222-4222-8222-222222222222'
const U2 = '33333333-3333-4333-8333-333333333333'
const call = (body: unknown) => POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }))
const own = (file: string) => `chat-media/account-${ACCOUNT_A}/${file}`
const ownUrl = (file: string) => `${PUBLIC}/${own(file)}`
const put = (key: string, size = 1000) => db.store.set(key, size)
const bytes = () => [...db.store.values()].reduce((a, b) => a + b, 0)

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = BASE
  callerRole = 'agent'
  db.calls = []; db.rpcArgs = []; db.tablesTouched = []; db.store = new Map(); db.failRemove = null
  db.candidates = { data: [], error: null }
  db.bulk = { data: { deleted: 2, conversations_deleted: 2, messages_deleted: 7, runs_deleted: 1, pending_automations_deleted: 0, notifications_deleted: 1, media: [] }, error: null }
})

describe('POST /api/contacts/bulk-delete — contract (unchanged)', () => {
  it('agent deletes exactly the given ids using the SESSION account (never one from the body)', async () => {
    const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ contact_ids: [U1, U2], account_id: 'evil', filters: { tag: 'x' } }) }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ success: true, deleted: 2, conversations_deleted: 2, messages_deleted: 7 })
    const bulk = db.rpcArgs.find((c) => c.fn === 'bulk_delete_contacts_internal')!
    expect(bulk.args).toEqual({ p_account_id: ACCOUNT_A, p_contact_ids: [U1, U2] })
    expect(db.rpcArgs.every((c) => c.args.p_account_id === ACCOUNT_A && (c.args.p_contact_ids as string[]).join() === [U1, U2].join())).toBe(true)
    expect(db.tablesTouched).toEqual([])
  })

  it('admin can; viewer is forbidden and nothing is called', async () => {
    callerRole = 'admin'
    expect((await call({ contact_ids: [U1] })).status).toBe(200)
    callerRole = 'viewer'
    db.calls = []
    expect((await call({ contact_ids: [U1] })).status).toBe(403)
    expect(db.calls).toHaveLength(0)
  })

  it.each([
    ['empty array', { contact_ids: [] }],
    ['missing', {}],
    ['not an array', { contact_ids: U1 }],
    ['a non-uuid', { contact_ids: [U1, 'not-a-uuid'] }],
    ['a non-string', { contact_ids: [U1, 5] }],
    ['too many', { contact_ids: Array.from({ length: MAX_BULK_DELETE + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) }],
  ])('invalid batch (%s) deletes nothing — no RPC, no Storage', async (_label, body) => {
    expect((await call(body)).status).toBe(400)
    expect(db.calls).toHaveLength(0)
  })

  it('invalid JSON deletes nothing', async () => {
    const res = await POST(new Request('http://x', { method: 'POST', body: '{nope' }))
    expect(res.status).toBe(400)
    expect(db.calls).toHaveLength(0)
  })

  it('duplicates are collapsed before the RPCs', async () => {
    await call({ contact_ids: [U1, U1.toUpperCase(), U2] })
    expect(db.rpcArgs.map((c) => c.args.p_contact_ids)).toEqual([[U1, U2], [U1, U2]])
  })

  it('cross-account: an id of another account rejects the whole batch (404, deleted = 0) BEFORE any file is touched', async () => {
    put(own('a.jpg'))
    db.candidates = { data: null as never, error: { message: 'CONTACTS_NOT_IN_ACCOUNT' } }
    const res = await call({ contact_ids: [U1, U2] })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ deleted: 0 })
    expect(db.calls).toEqual(['contact_chat_media_candidates'])
    expect(db.store.size).toBe(1)
  })

  it('the transaction also refuses a foreign id (race): 404, deleted = 0', async () => {
    db.bulk = { data: null, error: { message: 'CONTACTS_NOT_IN_ACCOUNT' } }
    const res = await call({ contact_ids: [U1] })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ deleted: 0 })
  })

  it('a failure inside the transaction is a 500 with deleted = 0 (the RPC rolled everything back)', async () => {
    db.bulk = { data: null, error: { message: 'DELETE_COUNT_MISMATCH' } }
    const res = await call({ contact_ids: [U1] })
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ deleted: 0 })
  })
})

describe('POST /api/contacts/bulk-delete — chat media cleanup', () => {
  it('deletes the image, audio, video and document of the selected chats and frees their bytes', async () => {
    for (const [f, size] of [['inbound/1-image.jpg', 500], ['1-voice.ogg', 300], ['inbound/clip.mp4', 4000], ['1-CAT.pdf', 2000]] as const) put(own(f), size)
    db.candidates = { data: ['inbound/1-image.jpg', '1-voice.ogg', 'inbound/clip.mp4', '1-CAT.pdf'].map((f) => ({ media_url: ownUrl(f), shared: false })), error: null }
    const before = bytes()
    const res = await call({ contact_ids: [U1, U2] })
    const body = await res.json()
    expect(body.media).toMatchObject({ identified: 4, deleted: 4, preserved_shared: 0, skipped: 0, failed: 0, cleanup_complete: true })
    expect(before - bytes()).toBe(6800)
    expect(db.store.size).toBe(0) // no orphan media left after a normal success
  })

  it('Storage goes FIRST and the database transaction runs only after it succeeded', async () => {
    put(own('a.jpg'))
    db.candidates = { data: [{ media_url: ownUrl('a.jpg'), shared: false }], error: null }
    await call({ contact_ids: [U1] })
    expect(db.calls).toEqual(['contact_chat_media_candidates', 'storage.remove:chat-media', 'bulk_delete_contacts_internal'])
  })

  it('media of an UNSELECTED contact or of another account is never in the list and stays; foreign paths are refused even if listed', async () => {
    put(own('mine.jpg')); put(own('unselected-contact.jpg')); put(`chat-media/account-${ACCOUNT_B}/other.jpg`)
    db.candidates = { data: [{ media_url: ownUrl('mine.jpg'), shared: false }, { media_url: `${PUBLIC}/chat-media/account-${ACCOUNT_B}/other.jpg`, shared: false }], error: null }
    const body = await (await call({ contact_ids: [U1] })).json()
    expect(db.store.has(own('mine.jpg'))).toBe(false)
    expect(db.store.has(own('unselected-contact.jpg'))).toBe(true)
    expect(db.store.has(`chat-media/account-${ACCOUNT_B}/other.jpg`)).toBe(true)
    expect(body.media).toMatchObject({ deleted: 1, skipped: 1 })
  })

  it('media shared with a surviving chat or a catalog is preserved', async () => {
    put(own('shared.jpg')); put(own('exclusive.jpg'))
    db.candidates = { data: [{ media_url: ownUrl('shared.jpg'), shared: true }, { media_url: ownUrl('exclusive.jpg'), shared: false }], error: null }
    const body = await (await call({ contact_ids: [U1] })).json()
    expect(db.store.has(own('shared.jpg'))).toBe(true)
    expect(db.store.has(own('exclusive.jpg'))).toBe(false)
    expect(body.media).toMatchObject({ deleted: 1, preserved_shared: 1 })
  })

  it('flow catalog buckets, external urls, WhatsApp proxy urls and unsafe paths are skipped, never removed', async () => {
    put(`flow-media/account-${ACCOUNT_A}/catalog.png`); put(`voice-notes/account-${ACCOUNT_A}/v.ogg`); put(own('x.jpg'))
    db.candidates = { data: [
      { media_url: `${PUBLIC}/flow-media/account-${ACCOUNT_A}/catalog.png`, shared: false },
      { media_url: `${PUBLIC}/voice-notes/account-${ACCOUNT_A}/v.ogg`, shared: false },
      { media_url: 'https://example.org/storage/v1/object/public/chat-media/account-' + ACCOUNT_A + '/x.jpg', shared: false },
      { media_url: '/api/whatsapp/media/123', shared: false },
      { media_url: ownUrl('../account-' + ACCOUNT_B + '/x.jpg'), shared: false },
      { media_url: ownUrl('a%2Fb.jpg'), shared: false },
    ], error: null }
    const body = await (await call({ contact_ids: [U1] })).json()
    expect(db.store.size).toBe(3)
    expect(body.media).toMatchObject({ identified: 6, deleted: 0, skipped: 6 })
    expect(db.calls).not.toContain('storage.remove:flow-media')
  })

  it('a Storage error stops BEFORE the database: nothing is deleted and the failure is reported (502)', async () => {
    put(own('a.jpg')); put(own('b.jpg'))
    db.candidates = { data: [{ media_url: ownUrl('a.jpg'), shared: false }, { media_url: ownUrl('b.jpg'), shared: false }], error: null }
    db.failRemove = () => 'storage down'
    const res = await call({ contact_ids: [U1] })
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body).toMatchObject({ deleted: 0, media: { failed: 2, cleanup_complete: false } })
    expect(db.calls).not.toContain('bulk_delete_contacts_internal')
    expect(db.store.size).toBe(2)
  })

  it('files removed but the database transaction fails: the inconsistency is stated, not hidden', async () => {
    put(own('a.jpg'))
    db.candidates = { data: [{ media_url: ownUrl('a.jpg'), shared: false }], error: null }
    db.bulk = { data: null, error: { message: 'DELETE_COUNT_MISMATCH' } }
    const res = await call({ contact_ids: [U1] })
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ deleted: 0, inconsistent: true, media: { deleted: 1 } })
  })

  it('media that arrived after the frozen list is removed in a second pass (and objects already handled are not touched twice)', async () => {
    put(own('first.jpg')); put(own('late.jpg')); put(own('kept-shared.jpg'))
    db.candidates = { data: [{ media_url: ownUrl('first.jpg'), shared: false }], error: null }
    db.bulk = { data: { deleted: 1, conversations_deleted: 1, messages_deleted: 3, media: [
      { media_url: ownUrl('first.jpg'), shared: false },
      { media_url: ownUrl('late.jpg'), shared: false },
      { media_url: ownUrl('kept-shared.jpg'), shared: true },
    ] }, error: null }
    const body = await (await call({ contact_ids: [U1] })).json()
    expect(db.store.has(own('late.jpg'))).toBe(false)
    expect(db.store.has(own('kept-shared.jpg'))).toBe(true)
    expect(body.media).toMatchObject({ deleted: 2, late_deleted: 1, preserved_shared: 1, cleanup_complete: true })
    expect(db.calls.filter((c) => c === 'storage.remove:chat-media')).toHaveLength(2)
  })

  it('a second-pass failure after the commit is reported as an incomplete cleanup (contacts ARE deleted)', async () => {
    put(own('late.jpg'))
    db.candidates = { data: [], error: null }
    db.bulk = { data: { deleted: 1, media: [{ media_url: ownUrl('late.jpg'), shared: false }] }, error: null }
    db.failRemove = () => 'storage hiccup'
    const res = await call({ contact_ids: [U1] })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, deleted: 1, media: { cleanup_complete: false, failed: 1 } })
  })

  it('without NEXT_PUBLIC_SUPABASE_URL nothing is provably managed: no file is removed (fail closed)', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    put(own('a.jpg'))
    db.candidates = { data: [{ media_url: ownUrl('a.jpg'), shared: false }], error: null }
    const body = await (await call({ contact_ids: [U1] })).json()
    expect(db.store.size).toBe(1)
    expect(body.media).toMatchObject({ deleted: 0, skipped: 1 })
  })
})
