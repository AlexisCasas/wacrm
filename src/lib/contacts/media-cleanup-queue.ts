import { CHAT_MEDIA_BUCKET, classifyMediaUrl } from './chat-media-cleanup'

/**
 * Durable chat-media cleanup (table contact_media_cleanup_items, migration 20261107).
 *
 * The delete transaction has ALREADY committed when this runs: the contacts, chats and messages are gone and the list of Storage objects to
 * remove was written in that same transaction. Here each queued object is removed from Storage and marked completed; a failure only leaves
 * the item pending/failed (with the error) so it can be retried later. Nothing here can undo a deletion, and an object that is already gone
 * counts as done (idempotent). The queue knows object paths only: it cannot affect a contact that is recreated afterwards, and an old item
 * can only ever delete the exact path it froze.
 */
export type CleanupItem = { id: string; account_id: string; bucket: string; object_path: string; media_url: string; status: 'pending' | 'failed' | 'completed'; failed_attempts: number }

export interface CleanupQueueStore {
  /** Open (pending / failed) items of ONE account, oldest first, optionally of one delete operation. */
  listOpen(accountId: string, operationId: string | undefined, limit: number): Promise<CleanupItem[]>
  markCompleted(accountId: string, ids: string[]): Promise<void>
  markFailed(accountId: string, item: CleanupItem, error: string): Promise<void>
  countOpen(accountId: string, operationId: string | undefined): Promise<number>
}

type StorageLike = { from: (bucket: string) => { remove: (paths: string[]) => Promise<{ data: unknown[] | null; error: { message: string } | null }> } }

export type CleanupOutcome = {
  attempted: number
  storage_deleted: number
  already_missing: number
  rejected: number
  failed: number
  pending_remaining: number
  cleanup_complete: boolean
}

export async function processPendingContactMediaCleanup(
  store: CleanupQueueStore,
  storage: StorageLike,
  opts: { accountId: string; operationId?: string; publicBase: string | undefined; limit?: number; chunkSize?: number },
): Promise<CleanupOutcome> {
  const { accountId, operationId } = opts
  const out: CleanupOutcome = { attempted: 0, storage_deleted: 0, already_missing: 0, rejected: 0, failed: 0, pending_remaining: 0, cleanup_complete: false }
  const items = await store.listOpen(accountId, operationId, opts.limit ?? 500)
  out.attempted = items.length

  // 1) only items that pass an independent re-validation are ever sent to Storage
  const valid: CleanupItem[] = []
  for (const item of items) {
    const verdict = classifyMediaUrl(item.media_url, { accountId, publicBase: opts.publicBase })
    const agrees = item.account_id === accountId && item.bucket === CHAT_MEDIA_BUCKET && verdict.kind === 'delete' && verdict.bucket === item.bucket && verdict.path === item.object_path
    if (!agrees) {
      out.rejected++
      await store.markFailed(accountId, item, opts.publicBase ? 'rejected_by_validator' : 'public_base_missing')
      continue
    }
    valid.push(item)
  }

  // 2) remove in chunks; success (even "already gone") completes the item, an error leaves it for a retry
  const chunkSize = opts.chunkSize ?? 100
  for (let i = 0; i < valid.length; i += chunkSize) {
    const chunk = valid.slice(i, i + chunkSize)
    try {
      const { data, error } = await storage.from(CHAT_MEDIA_BUCKET).remove(chunk.map((c) => c.object_path))
      if (error) throw new Error(error.message)
      const removed = Array.isArray(data) ? data.length : 0
      out.storage_deleted += removed
      out.already_missing += chunk.length - removed
      await store.markCompleted(accountId, chunk.map((c) => c.id))
    } catch (e) {
      const message = e instanceof Error ? e.message : 'storage error'
      for (const item of chunk) { out.failed++; await store.markFailed(accountId, item, message) }
    }
  }

  out.pending_remaining = await store.countOpen(accountId, operationId)
  out.cleanup_complete = out.pending_remaining === 0
  return out
}

// --- Supabase-backed store (service role). Every query is scoped by account_id.
type Db = { from: (table: string) => any } // eslint-disable-line @typescript-eslint/no-explicit-any
const TABLE = 'contact_media_cleanup_items'

export function supabaseCleanupQueueStore(db: Db): CleanupQueueStore {
  return {
    async listOpen(accountId, operationId, limit) {
      let q = db.from(TABLE).select('id, account_id, bucket, object_path, media_url, status, failed_attempts').eq('account_id', accountId).in('status', ['pending', 'failed'])
      if (operationId) q = q.eq('operation_id', operationId)
      const { data, error } = await q.order('created_at', { ascending: true }).limit(limit)
      if (error) throw new Error(`cleanup queue read failed: ${error.message}`)
      return (data ?? []) as CleanupItem[]
    },
    async markCompleted(accountId, ids) {
      const now = new Date().toISOString()
      const { error } = await db.from(TABLE).update({ status: 'completed', completed_at: now, last_attempt_at: now, last_error: null }).eq('account_id', accountId).in('id', ids)
      if (error) throw new Error(`cleanup queue update failed: ${error.message}`)
    },
    async markFailed(accountId, item, message) {
      const { error } = await db.from(TABLE).update({ status: 'failed', last_error: message.slice(0, 500), last_attempt_at: new Date().toISOString(), failed_attempts: item.failed_attempts + 1 }).eq('account_id', accountId).eq('id', item.id)
      if (error) console.error('[contacts] cleanup queue could not record a failure:', error.message)
    },
    async countOpen(accountId, operationId) {
      let q = db.from(TABLE).select('id', { count: 'exact', head: true }).eq('account_id', accountId).neq('status', 'completed')
      if (operationId) q = q.eq('operation_id', operationId)
      const { count, error } = await q
      if (error) throw new Error(`cleanup queue count failed: ${error.message}`)
      return count ?? 0
    },
  }
}
