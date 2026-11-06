import { beforeEach, describe, expect, it } from 'vitest'
import { processPendingContactMediaCleanup, supabaseCleanupQueueStore, type CleanupItem, type CleanupQueueStore } from './media-cleanup-queue'

// The durable cleanup queue: retry, idempotence, and that an OLD item can only ever delete the exact path it froze.
const A = 'a1000000-0000-4000-8000-000000000001'
const B = 'b1000000-0000-4000-8000-000000000001'
const BASE = 'https://supabase.example.com'
const url = (account: string, file: string, bucket = 'chat-media') => `${BASE}/storage/v1/object/public/${bucket}/account-${account}/${file}`
const path = (account: string, file: string) => `account-${account}/${file}`

type Row = CleanupItem & { operation_id: string; last_error: string | null }
let rows: Row[]
let store: Map<string, number> // "bucket/path" -> bytes (fake Storage)
let storageMode: 'ok' | 'down'
let removeCalls: string[][]
let seq = 0

const item = (account: string, file: string, over: Partial<Row> = {}): Row => ({
  id: `i-${++seq}`, account_id: account, bucket: 'chat-media', object_path: path(account, file), media_url: url(account, file),
  status: 'pending', failed_attempts: 0, operation_id: 'op-1', last_error: null, ...over,
})
const put = (account: string, file: string, bytes = 100, bucket = 'chat-media') => store.set(`${bucket}/${path(account, file)}`, bytes)

const queue: CleanupQueueStore = {
  async listOpen(accountId, operationId, limit) {
    return rows.filter((r) => r.account_id === accountId && r.status !== 'completed' && (!operationId || r.operation_id === operationId)).slice(0, limit)
  },
  async markCompleted(accountId, ids) { for (const r of rows) if (r.account_id === accountId && ids.includes(r.id)) { r.status = 'completed'; r.last_error = null } },
  async markFailed(accountId, it, error) { const r = rows.find((x) => x.account_id === accountId && x.id === it.id)!; r.status = 'failed'; r.last_error = error; r.failed_attempts++ },
  async countOpen(accountId, operationId) { return rows.filter((r) => r.account_id === accountId && r.status !== 'completed' && (!operationId || r.operation_id === operationId)).length },
}
const storage = {
  from: (bucket: string) => ({
    remove: async (paths: string[]) => {
      removeCalls.push(paths)
      if (storageMode === 'down') return { data: null, error: { message: 'storage down' } }
      const removed = paths.filter((p) => store.delete(`${bucket}/${p}`)).map((name) => ({ name }))
      return { data: removed, error: null }
    },
  }),
}
const run = (over: { accountId?: string; operationId?: string; publicBase?: string | undefined } = {}) =>
  processPendingContactMediaCleanup(queue, storage, { accountId: A, publicBase: BASE, ...over })

beforeEach(() => { rows = []; store = new Map(); storageMode = 'ok'; removeCalls = [] })

describe('processPendingContactMediaCleanup', () => {
  it('removes the queued objects, marks them completed and reports pending = 0', async () => {
    put(A, 'a.jpg', 500); put(A, 'inbound/b.ogg', 300)
    rows.push(item(A, 'a.jpg'), item(A, 'inbound/b.ogg'))
    const out = await run()
    expect(out).toMatchObject({ attempted: 2, storage_deleted: 2, already_missing: 0, failed: 0, pending_remaining: 0, cleanup_complete: true })
    expect(store.size).toBe(0)
    expect(rows.every((r) => r.status === 'completed')).toBe(true)
  })

  it('Case B — Storage fails AFTER the database delete: items stay pending/failed with the error, cleanup is reported incomplete', async () => {
    put(A, 'a.jpg'); rows.push(item(A, 'a.jpg'))
    storageMode = 'down'
    const out = await run()
    expect(out).toMatchObject({ storage_deleted: 0, failed: 1, pending_remaining: 1, cleanup_complete: false })
    expect(rows[0]).toMatchObject({ status: 'failed', last_error: 'storage down', failed_attempts: 1 })
    expect(store.size).toBe(1) // the file is still there, waiting for a retry
  })

  it('Case C — retry: a failed item is processed again and completes', async () => {
    put(A, 'a.jpg', 700); rows.push(item(A, 'a.jpg'))
    storageMode = 'down'; await run()
    expect(rows[0].status).toBe('failed')
    storageMode = 'ok'
    const retry = await run() // no operation id: the general retry of everything still open for the account
    expect(retry).toMatchObject({ attempted: 1, storage_deleted: 1, pending_remaining: 0, cleanup_complete: true })
    expect(rows[0]).toMatchObject({ status: 'completed', last_error: null })
    expect(store.size).toBe(0)
  })

  it('Case D — an object that is already gone counts as done (idempotent) and a second run does nothing', async () => {
    rows.push(item(A, 'gone.jpg')) // never put in the store
    const first = await run()
    expect(first).toMatchObject({ storage_deleted: 0, already_missing: 1, pending_remaining: 0, cleanup_complete: true })
    expect(rows[0].status).toBe('completed')
    removeCalls = []
    const second = await run()
    expect(second).toMatchObject({ attempted: 0, cleanup_complete: true })
    expect(removeCalls).toHaveLength(0)
  })

  it('Case E — the contact came back: the OLD cleanup deletes only its frozen path, never the new contact\'s media', async () => {
    put(A, 'inbound/old-audio.ogg'); rows.push(item(A, 'inbound/old-audio.ogg'))
    // later the same phone writes again -> a new contact and new files appear in the same namespace
    put(A, 'inbound/new-audio.ogg'); put(A, 'new-image.jpg'); put(A, 'inbound/old-audio-copy.ogg')
    await run()
    expect(store.has(`chat-media/${path(A, 'inbound/old-audio.ogg')}`)).toBe(false)
    expect(store.has(`chat-media/${path(A, 'inbound/new-audio.ogg')}`)).toBe(true)
    expect(store.has(`chat-media/${path(A, 'new-image.jpg')}`)).toBe(true)
    expect(store.has(`chat-media/${path(A, 'inbound/old-audio-copy.ogg')}`)).toBe(true)
    expect(removeCalls).toEqual([[path(A, 'inbound/old-audio.ogg')]])
  })

  it('Case F — an item of another account is never touched by this account\'s run', async () => {
    put(B, 'inbound/b.jpg'); rows.push(item(B, 'inbound/b.jpg'))
    const out = await run()
    expect(out).toMatchObject({ attempted: 0, cleanup_complete: true })
    expect(store.size).toBe(1); expect(removeCalls).toHaveLength(0)
    expect(rows[0].status).toBe('pending')
  })

  it('an operation id restricts the run to that delete; other open items wait for the general retry', async () => {
    put(A, 'x.jpg'); put(A, 'y.jpg')
    rows.push(item(A, 'x.jpg', { operation_id: 'op-1' }), item(A, 'y.jpg', { operation_id: 'op-2' }))
    await run({ operationId: 'op-1' })
    expect(rows.map((r) => r.status)).toEqual(['completed', 'pending'])
    expect(store.has(`chat-media/${path(A, 'y.jpg')}`)).toBe(true)
  })

  it('fail closed: an item the independent validator does not accept is never sent to Storage', async () => {
    put(A, 'ok.jpg'); put(A, 'victim.jpg'); put('flow', 'catalog.png', 1, 'flow-media')
    rows.push(
      item(A, 'ok.jpg'),
      item(A, 'tampered.jpg', { object_path: path(A, 'victim.jpg') }),                                 // path does not match the stored url
      item(A, 'cat.png', { media_url: url(A, 'cat.png', 'flow-media'), object_path: path(A, 'cat.png') }), // wrong bucket in the url
      item(A, 'e.jpg', { media_url: 'https://example.org/storage/v1/object/public/chat-media/account-' + A + '/e.jpg' }), // external host
      item(A, 'bad.jpg', { object_path: `account-${B}/bad.jpg`, media_url: url(B, 'bad.jpg') }),       // another namespace
    )
    const out = await run()
    expect(out).toMatchObject({ rejected: 4, storage_deleted: 1, pending_remaining: 4, cleanup_complete: false })
    expect(store.has(`chat-media/${path(A, 'victim.jpg')}`)).toBe(true)
    expect(removeCalls).toEqual([[path(A, 'ok.jpg')]])
    expect(rows.filter((r) => r.last_error === 'rejected_by_validator')).toHaveLength(4)
  })

  it('without the own public origin nothing can be validated: everything stays queued', async () => {
    put(A, 'a.jpg'); rows.push(item(A, 'a.jpg'))
    const out = await run({ publicBase: undefined })
    expect(out).toMatchObject({ storage_deleted: 0, rejected: 1, cleanup_complete: false })
    expect(rows[0].last_error).toBe('public_base_missing')
    expect(removeCalls).toHaveLength(0)
  })

  it('works in chunks and reports a failing chunk without losing the others', async () => {
    for (let i = 0; i < 5; i++) { put(A, `f${i}.jpg`); rows.push(item(A, `f${i}.jpg`)) }
    let n = 0
    const flaky = { from: () => ({ remove: async (paths: string[]) => (++n === 2 ? { data: null, error: { message: 'chunk 2 failed' } } : { data: paths.map((name) => ({ name })), error: null }) }) }
    const out = await processPendingContactMediaCleanup(queue, flaky, { accountId: A, publicBase: BASE, chunkSize: 2 })
    expect(out).toMatchObject({ storage_deleted: 3, failed: 2, pending_remaining: 2, cleanup_complete: false })
    expect(rows.map((r) => r.status)).toEqual(['completed', 'completed', 'failed', 'failed', 'completed'])
  })
})

describe('supabaseCleanupQueueStore — every query is scoped by account', () => {
  it('reads, completes and counts only inside the given account', async () => {
    const log: Array<{ op: string; args: unknown[] }> = []
    const chain = (result: unknown) => {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'update', 'eq', 'neq', 'in', 'order', 'limit']) b[m] = (...args: unknown[]) => { log.push({ op: m, args }); return b }
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res)
      return b
    }
    const s = supabaseCleanupQueueStore({ from: () => chain({ data: [], count: 3, error: null }) })
    await s.listOpen(A, 'op-9', 50); await s.markCompleted(A, ['i1']); await s.countOpen(A, 'op-9')
    const eqs = log.filter((l) => l.op === 'eq').map((l) => l.args.join('='))
    expect(eqs.filter((e) => e === `account_id=${A}`)).toHaveLength(3)
    expect(log.some((l) => l.op === 'eq' && l.args[0] === 'operation_id' && l.args[1] === 'op-9')).toBe(true)
  })
})
