import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/contacts/admin-client'
import { processPendingContactMediaCleanup, supabaseCleanupQueueStore, type CleanupOutcome } from '@/lib/contacts/media-cleanup-queue'

export const MAX_BULK_DELETE = 100
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * POST /api/contacts/bulk-delete  { contact_ids: string[] }
 *
 * Permanently deletes EXACTLY the given contacts with everything that belongs only to them: chats, messages, tags, custom values, notes,
 * identities, runs, pending waits, notifications (database) AND the chat media files (Storage). Nothing is blocked afterwards: the same
 * phone / BSUID simply creates a new contact on its next inbound. The account comes from the session; one foreign id rejects the batch.
 *
 * DATABASE FIRST, Storage after the COMMIT (Storage and Postgres are not one transaction, so the order protects what users can see):
 *   1. bulk_delete_contacts_internal — ONE transaction: proves every id belongs to the session account, locks the chats, resolves the media of
 *      exactly those chats, QUEUES the deletable objects (contact_media_cleanup_items), deletes the contacts. Any failure rolls back everything,
 *      the queue rows included: deleted = 0, nothing queued, Storage untouched.
 *   2. After the commit, each queued object is removed from Storage and marked completed. A failure never undoes the deletion: the object stays
 *      pending/failed in the queue (`cleanup_complete: false`, `storage_pending > 0`) and processPendingContactMediaCleanup can retry it.
 * Auth: requireRole('agent') — same as the contacts DELETE policy.
 */
export async function POST(request: Request) {
  try {
    const { accountId } = await requireRole('agent')

    const body = (await request.json().catch(() => null)) as { contact_ids?: unknown } | null
    const raw = body?.contact_ids
    if (!Array.isArray(raw) || raw.length === 0) {
      return NextResponse.json({ error: 'contact_ids must be a non-empty array' }, { status: 400 })
    }
    if (raw.length > MAX_BULK_DELETE) {
      return NextResponse.json({ error: `at most ${MAX_BULK_DELETE} contacts per request` }, { status: 400 })
    }
    if (!raw.every((id) => typeof id === 'string' && UUID.test(id))) {
      return NextResponse.json({ error: 'contact_ids must be UUIDs' }, { status: 400 })
    }
    const ids = [...new Set((raw as string[]).map((id) => id.toLowerCase()))]

    const db = supabaseAdmin()
    const publicBase = process.env.NEXT_PUBLIC_SUPABASE_URL

    // 1) the database transaction (also queues the Storage objects). Storage has NOT been touched when this fails.
    const { data, error } = await db.rpc('bulk_delete_contacts_internal', { p_account_id: accountId, p_contact_ids: ids, p_public_base: publicBase ?? null })
    if (error) {
      if (error.message?.includes('CONTACTS_NOT_IN_ACCOUNT')) {
        return NextResponse.json({ error: 'One or more contacts were not found', deleted: 0 }, { status: 404 })
      }
      console.error('[contacts] bulk_delete_contacts_internal failed:', error.message)
      return NextResponse.json({ error: 'Failed to delete contacts', deleted: 0 }, { status: 500 })
    }
    const result = (data ?? {}) as {
      deleted?: number; conversations_deleted?: number; messages_deleted?: number
      runs_deleted?: number; pending_automations_deleted?: number; notifications_deleted?: number
      operation_id?: string; media_identified?: number; media_preserved_shared?: number; media_queued?: number
    }

    // 2) the contacts are gone for good; now free the files. Never turns a committed deletion into an error.
    let cleanup: CleanupOutcome
    try {
      cleanup = await processPendingContactMediaCleanup(supabaseCleanupQueueStore(db), db.storage, { accountId, operationId: result.operation_id, publicBase })
    } catch (e) {
      console.error('[contacts] chat media cleanup could not run (items stay queued):', e instanceof Error ? e.message : e)
      cleanup = { attempted: 0, storage_deleted: 0, already_missing: 0, rejected: 0, failed: 0, pending_remaining: result.media_queued ?? 0, cleanup_complete: (result.media_queued ?? 0) === 0 }
    }

    return NextResponse.json({
      success: true,
      deleted: result.deleted ?? 0,
      conversations_deleted: result.conversations_deleted ?? 0,
      messages_deleted: result.messages_deleted ?? 0,
      runs_deleted: result.runs_deleted ?? 0,
      pending_automations_deleted: result.pending_automations_deleted ?? 0,
      notifications_deleted: result.notifications_deleted ?? 0,
      cleanup_complete: cleanup.cleanup_complete,
      storage_deleted: cleanup.storage_deleted,
      storage_pending: cleanup.pending_remaining,
      media: {
        identified: result.media_identified ?? 0,
        queued: result.media_queued ?? 0,
        preserved_shared: result.media_preserved_shared ?? 0,
        already_missing: cleanup.already_missing,
        rejected: cleanup.rejected,
        failed: cleanup.failed,
      },
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
