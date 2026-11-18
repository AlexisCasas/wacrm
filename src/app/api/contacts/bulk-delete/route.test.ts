import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/contacts/bulk-delete — auth, validation, tenancy and the DATABASE-FIRST contract:
// the transaction (which also queues the Storage objects) runs first; Storage is touched only after it committed.
const ACCOUNT_A = '11111111-1111-4111-8111-111111111111'
const BASE = 'https://supabase.example.com'
let callerRole = 'admin'

type QueueRow = { id: string; operation_id: string; account_id: string; bucket: string; object_path: string; media_url: string; status: string; failed_attempts: number; last_error: string | null }
const db = vi.hoisted(() => ({
  calls: [] as string[],                                   // ordered log: rpc name / storage.remove
  rpcArgs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  /** what the (fake) transaction does when it commits */
  txn: { error: null as { message: string; details?: string } | null, result: { deleted: 2, conversations_deleted: 2, messages_deleted: 7, runs_deleted: 1, pending_automations_deleted: 0, notifications_deleted: 1, media_identified: 0, media_preserved_shared: 0, media_queued: 0 } as Record<string, unknown>, queueOnCommit: [] as string[] },
  queue: [] as unknown[],
  contactsDeleted: 0,
  store: new Map<string, number>(),                        // "bucket/path" -> bytes (fake Storage)
  failRemove: false,
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

vi.mock('@/lib/contacts/admin-client', () => {
  const rows = () => db.queue as QueueRow[]
  function queueBuilder() {
    let op: 'select' | 'update' = 'select'; let head = false; let payload: Record<string, unknown> = {}; let limitN = Infinity
    const filters: Array<(r: QueueRow) => boolean> = []
    const b: Record<string, unknown> = {
      select: (_c?: string, o?: { head?: boolean }) => { head = Boolean(o?.head); return b },
      update: (p: Record<string, unknown>) => { op = 'update'; payload = p; return b },
      eq: (k: keyof QueueRow, v: unknown) => (filters.push((r) => r[k] === v), b),
      neq: (k: keyof QueueRow, v: unknown) => (filters.push((r) => r[k] !== v), b),
      in: (k: keyof QueueRow, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), b),
      order: () => b,
      limit: (n: number) => ((limitN = n), b),
      then: (res: (v: unknown) => unknown) => {
        const matched = rows().filter((r) => filters.every((f) => f(r)))
        if (op === 'update') { matched.forEach((r) => Object.assign(r, payload)); return Promise.resolve({ error: null }).then(res) }
        if (head) return Promise.resolve({ count: matched.length, error: null }).then(res)
        return Promise.resolve({ data: matched.slice(0, limitN), error: null }).then(res)
      },
    }
    return b
  }
  return {
    supabaseAdmin: () => ({
      rpc: (fn: string, args: Record<string, unknown>) => {
        db.calls.push(fn); db.rpcArgs.push({ fn, args })
        if (db.txn.error) return Promise.resolve({ data: null, error: db.txn.error })          // rolled back: no contact deleted, no queue row
        const operation_id = 'op-' + db.rpcArgs.length
        for (const path of db.txn.queueOnCommit) {
          rows().push({ id: 'q' + (rows().length + 1), operation_id, account_id: args.p_account_id as string, bucket: 'chat-media', object_path: path, media_url: `${BASE}/storage/v1/object/public/chat-media/${path}`, status: 'pending', failed_attempts: 0, last_error: null })
        }
        db.contactsDeleted = (db.txn.result.deleted as number) ?? 0
        return Promise.resolve({ data: { ...db.txn.result, operation_id, media_queued: db.txn.queueOnCommit.length }, error: null })
      },
      from: (t: string) => { db.tablesTouched.push(t); if (t !== 'contact_media_cleanup_items') throw new Error('unexpected table ' + t); return queueBuilder() },
      storage: {
        from: (bucket: string) => ({
          remove: async (paths: string[]) => {
            db.calls.push(`storage.remove:${bucket}`)
            if (db.failRemove) return { data: null, error: { message: 'storage down' } }
            return { data: paths.filter((p) => db.store.delete(`${bucket}/${p}`)).map((name) => ({ name })), error: null }
          },
        }),
      },
    }),
  }
})

import { POST, MAX_BULK_DELETE } from './route'

const U1 = '22222222-2222-4222-8222-222222222222'
const U2 = '33333333-3333-4333-8333-333333333333'
// Multi-contact deletions need the typed confirmation (FIX 04); the helper adds it so older cases stay about their own subject.
const call = (body: unknown) => {
  const b = body as { contact_ids?: unknown[]; confirm?: string }
  const withConfirm = Array.isArray(b?.contact_ids) && b.contact_ids.length > 1 && !('confirm' in b) ? { ...b, confirm: 'ELIMINAR' } : body
  return POST(new Request('http://x', { method: 'POST', body: JSON.stringify(withConfirm) }))
}
const own = (file: string) => `account-${ACCOUNT_A}/${file}`
const put = (path: string, size = 1000) => db.store.set(`chat-media/${path}`, size)
const bytes = () => [...db.store.values()].reduce((a, b) => a + b, 0)

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = BASE
  callerRole = 'admin'
  db.calls = []; db.rpcArgs = []; db.tablesTouched = []; db.store = new Map(); db.failRemove = false; db.queue = []; db.contactsDeleted = 0
  db.txn = { error: null, result: { deleted: 2, conversations_deleted: 2, messages_deleted: 7, runs_deleted: 1, pending_automations_deleted: 0, notifications_deleted: 1, media_identified: 0, media_preserved_shared: 0, media_queued: 0 }, queueOnCommit: [] }
})

describe('POST /api/contacts/bulk-delete — contract (unchanged)', () => {
  it('admin deletes exactly the given ids using the SESSION account (never one from the body)', async () => {
    const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ contact_ids: [U1, U2], confirm: 'ELIMINAR', account_id: 'evil', filters: { tag: 'x' } }) }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, deleted: 2, conversations_deleted: 2, messages_deleted: 7, cleanup_complete: true, storage_deleted: 0, storage_pending: 0 })
    expect(db.rpcArgs).toEqual([{ fn: 'bulk_delete_contacts_internal', args: { p_account_id: ACCOUNT_A, p_contact_ids: [U1, U2], p_public_base: BASE, p_actor_user_id: 'user-1', p_ack_protected: false } }])
  })

  it('agent can delete ONE contact; viewer is forbidden and nothing is called', async () => {
    callerRole = 'agent'
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
    expect((await POST(new Request('http://x', { method: 'POST', body: '{nope' }))).status).toBe(400)
    expect(db.calls).toHaveLength(0)
  })

  it('duplicates are collapsed before the RPC', async () => {
    await call({ contact_ids: [U1, U1.toUpperCase(), U2] })
    expect(db.rpcArgs[0].args.p_contact_ids).toEqual([U1, U2])
  })
})

describe('DB-first: the database transaction decides, Storage follows the commit', () => {
  it('the transaction runs FIRST; Storage is touched only afterwards', async () => {
    put(own('a.jpg')); db.txn.queueOnCommit = [own('a.jpg')]
    await call({ contact_ids: [U1] })
    expect(db.calls).toEqual(['bulk_delete_contacts_internal', 'storage.remove:chat-media'])
  })

  it('Case A — the database transaction fails: contacts deleted 0, Storage touched 0, no cleanup manifest committed', async () => {
    put(own('a.jpg')); db.txn.queueOnCommit = [own('a.jpg')]
    db.txn.error = { message: 'DELETE_COUNT_MISMATCH' }
    const res = await call({ contact_ids: [U1] })
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ deleted: 0 })
    expect(db.contactsDeleted).toBe(0)
    expect(db.calls).toEqual(['bulk_delete_contacts_internal'])        // no storage.remove at all
    expect(db.queue).toHaveLength(0)
    expect(db.store.size).toBe(1)
  })

  it('Case F — cross-account: one id of another account => 404, deleted 0, Storage touched 0, no cleanup items', async () => {
    put(own('a.jpg'))
    db.txn.error = { message: 'CONTACTS_NOT_IN_ACCOUNT' }
    const res = await call({ contact_ids: [U1, U2] })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ deleted: 0 })
    expect(db.calls).toEqual(['bulk_delete_contacts_internal'])
    expect(db.queue).toHaveLength(0)
    expect(db.store.size).toBe(1)
  })

  it('success: image, audio, video and document are removed after the commit, bytes are freed, nothing is left queued or orphaned', async () => {
    const files = [['inbound/1-image.jpg', 500], ['1-voice.ogg', 300], ['inbound/clip.mp4', 4000], ['1-CAT.pdf', 2000]] as const
    for (const [f, size] of files) put(own(f), size)
    put(own('unselected.jpg'), 900)               // a file of someone who was not selected: never queued, never touched
    db.txn.queueOnCommit = files.map(([f]) => own(f))
    const before = bytes()
    const body = await (await call({ contact_ids: [U1, U2] })).json()
    expect(body).toMatchObject({ cleanup_complete: true, storage_deleted: 4, storage_pending: 0 })
    expect(before - bytes()).toBe(6800)
    expect([...db.store.keys()]).toEqual([`chat-media/${own('unselected.jpg')}`])
    expect(db.queue.every((r) => (r as QueueRow).status === 'completed')).toBe(true)
  })

  it('Case B — Storage fails AFTER the commit: the deletion stands, the cleanup is pending and reported incomplete', async () => {
    put(own('a.jpg')); put(own('b.jpg')); db.txn.queueOnCommit = [own('a.jpg'), own('b.jpg')]
    db.failRemove = true
    const res = await call({ contact_ids: [U1] })
    expect(res.status).toBe(200)                                         // NOT a failed deletion
    const body = await res.json()
    expect(body).toMatchObject({ success: true, deleted: 2, cleanup_complete: false, storage_deleted: 0, storage_pending: 2 })
    expect(db.contactsDeleted).toBe(2)
    expect((db.queue as QueueRow[]).map((r) => [r.status, r.last_error])).toEqual([['failed', 'storage down'], ['failed', 'storage down']])
    expect(db.store.size).toBe(2)                                        // the files wait for the retry
  })

  it('the response keeps the previous counters and reports the media summary', async () => {
    db.txn.result = { ...db.txn.result, media_identified: 6, media_preserved_shared: 2, media_queued: 0 }
    const body = await (await call({ contact_ids: [U1] })).json()
    expect(body.media).toMatchObject({ identified: 6, preserved_shared: 2, queued: 0 })
    expect(body).toMatchObject({ runs_deleted: 1, notifications_deleted: 1 })
  })

  it('only the queue table and Storage are touched after the commit (no other table)', async () => {
    put(own('a.jpg')); db.txn.queueOnCommit = [own('a.jpg')]
    await call({ contact_ids: [U1] })
    expect(new Set(db.tablesTouched)).toEqual(new Set(['contact_media_cleanup_items']))
  })

  it('without NEXT_PUBLIC_SUPABASE_URL the database queues nothing and nothing can be removed (fail closed)', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    put(own('a.jpg'))
    await call({ contact_ids: [U1] })
    expect(db.rpcArgs[0].args.p_public_base).toBeNull()
    expect(db.calls).toEqual(['bulk_delete_contacts_internal'])
    expect(db.store.size).toBe(1)
  })
})

describe('FIX 04 — who may delete, typed confirmation, protected contacts, limits (server side)', () => {
  it('an agent can delete only one contact: several are 403 BULK_REQUIRES_ADMIN and nothing reaches the database', async () => {
    callerRole = 'agent'
    const res = await call({ contact_ids: [U1, U2], confirm: 'ELIMINAR' })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'BULK_REQUIRES_ADMIN' })
    expect(db.calls).toHaveLength(0)
  })

  it.each([['missing', undefined], ['wrong word', 'eliminar'], ['empty', ''], ['spaces', ' ELIMINAR ']])('several contacts without the exact typed confirmation (%s) are rejected before the database', async (_l, confirm) => {
    const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ contact_ids: [U1, U2], ...(confirm === undefined ? {} : { confirm }) }) }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'CONFIRMATION_REQUIRED' })
    expect(db.calls).toHaveLength(0)
  })

  it('a single deletion needs no typed word and sends the verified actor to the database', async () => {
    callerRole = 'agent'
    expect((await call({ contact_ids: [U1] })).status).toBe(200)
    expect(db.rpcArgs[0].args).toMatchObject({ p_actor_user_id: 'user-1', p_ack_protected: false })
  })

  it('the acknowledgement is only honoured as the boolean true', async () => {
    await call({ contact_ids: [U1], acknowledge_protected: true })
    await call({ contact_ids: [U1], acknowledge_protected: 'true' })
    await call({ contact_ids: [U1], acknowledge_protected: 1 })
    expect(db.rpcArgs.map((r) => r.args.p_ack_protected)).toEqual([true, false, false])
  })

  it.each([
    ['PROTECTED_CONTACTS', 409, { contacts_with_orders: 1, recent_conversations: 0, blocked: 1 }],
    ['RATE_LIMIT_ACCOUNT', 429, { limit: 1000, used: 990, requested: 50 }],
    ['RATE_LIMIT_USER', 429, { limit: 10, used: 10, requested: 1 }],
    ['ORDERS_REQUIRE_ADMIN', 403, undefined],
    ['ACTOR_NOT_AUTHORIZED', 403, undefined],
    ['BULK_REQUIRES_ADMIN', 403, undefined],
    ['BATCH_TOO_LARGE', 400, undefined],
  ])('the database error %s maps to HTTP %i with a stable code and counts only', async (code, status, detail) => {
    db.txn.error = { message: code, ...(detail ? { details: JSON.stringify(detail) } : {}) }
    const res = await call({ contact_ids: [U1] })
    expect(res.status).toBe(status)
    const body = await res.json()
    expect(body).toMatchObject({ code, deleted: 0 })
    if (detail) expect(body.detail).toEqual(detail)
    expect(db.calls).toEqual(['bulk_delete_contacts_internal'])      // Storage untouched
    expect(db.queue).toHaveLength(0)
  })

  it('the retired 3-argument signature failing closed (ACTOR_REQUIRED) is a generic 500, never a deletion', async () => {
    db.txn.error = { message: 'ACTOR_REQUIRED' }
    const res = await call({ contact_ids: [U1] })
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ deleted: 0 })
    expect(db.contactsDeleted).toBe(0)
  })

  it('the route never sends the old 3-argument call: p_actor_user_id is always present', async () => {
    await call({ contact_ids: [U1, U2] })
    await call({ contact_ids: [U1] })
    expect(db.rpcArgs.every((r) => typeof r.args.p_actor_user_id === 'string' && 'p_ack_protected' in r.args)).toBe(true)
  })
})
