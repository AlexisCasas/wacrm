import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { supabaseAdmin } from '@/lib/contacts/admin-client'
import { processPendingContactMediaCleanup, supabaseCleanupQueueStore, type CleanupOutcome } from '@/lib/contacts/media-cleanup-queue'

export const MAX_BULK_DELETE = 100
/** Typed confirmation required (and verified here, not only in the UI) when more than one contact is deleted. */
export const BULK_DELETE_CONFIRMATION = 'ELIMINAR'
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
 * FIX 04 controls: the actor comes from the verified session and is checked again INSIDE the database function (role, limits per
 * operation / per company / per agent, protected contacts, audit row in the same transaction). Here: 1 contact -> agent or higher;
 * 2+ contacts -> admin or owner with the typed confirmation. Contacts with orders, recent chats or an active block need
 * `acknowledge_protected: true`; agents can never delete contacts with orders.
 */
/** Maps the database function's error codes to stable HTTP responses (details are counts only, never personal data). */
function deleteErrorResponse(error: { message?: string; details?: string | null }) {
  const message = error.message ?? ''
  const detail = (() => { try { return error.details ? JSON.parse(error.details) : undefined } catch { return undefined } })()
  const table: Array<[string, number, string]> = [
    ['CONTACTS_NOT_IN_ACCOUNT', 404, 'One or more contacts were not found'],
    ['ACTOR_NOT_AUTHORIZED', 403, 'You are not allowed to delete contacts'],
    ['BULK_REQUIRES_ADMIN', 403, 'Deleting several contacts requires the admin or owner role'],
    ['ORDERS_REQUIRE_ADMIN', 403, 'Contacts with orders can only be deleted by an admin or owner'],
    ['PROTECTED_CONTACTS', 409, 'Some contacts have orders, recent conversations or an active block: acknowledge to continue'],
    ['RATE_LIMIT_ACCOUNT', 429, 'The deletion limit for this company was reached; try again later'],
    ['RATE_LIMIT_USER', 429, 'The deletion limit for this user was reached; try again later'],
    ['BATCH_TOO_LARGE', 400, `at most ${MAX_BULK_DELETE} contacts per request`],
    ['EMPTY_BATCH', 400, 'contact_ids must be a non-empty array'],
  ]
  for (const [code, status, text] of table) {
    if (message.includes(code)) return NextResponse.json({ error: text, code, deleted: 0, ...(detail ? { detail } : {}) }, { status })
  }
  console.error('[contacts] bulk_delete_contacts_internal failed:', message)
  return NextResponse.json({ error: 'Failed to delete contacts', deleted: 0 }, { status: 500 })
}

export async function POST(request: Request) {
  try {
    const { accountId, userId, role } = await requireRole('agent')

    const body = (await request.json().catch(() => null)) as { contact_ids?: unknown; confirm?: unknown; acknowledge_protected?: unknown } | null
    const raw = body?.contact_ids
    if (!Array.isArray(raw) || raw.length === 0) {
      return NextResponse.json({ error: 'contact_ids must be a non-empty array' }, { status: 400 })
    }
    if (raw.length > MAX_BULK_DELETE) {
      return NextResponse.json({ error: `at most ${MAX_BULK_DELETE} contacts per request`, code: 'BATCH_TOO_LARGE' }, { status: 400 })
    }
    if (!raw.every((id) => typeof id === 'string' && UUID.test(id))) {
      return NextResponse.json({ error: 'contact_ids must be UUIDs' }, { status: 400 })
    }
    const ids = [...new Set((raw as string[]).map((id) => id.toLowerCase()))]

    if (ids.length > 1) {
      if (!hasMinRole(role, 'admin')) {
        return NextResponse.json({ error: 'Deleting several contacts requires the admin or owner role', code: 'BULK_REQUIRES_ADMIN' }, { status: 403 })
      }
      if (body?.confirm !== BULK_DELETE_CONFIRMATION) {
        return NextResponse.json({ error: `Type ${BULK_DELETE_CONFIRMATION} to confirm`, code: 'CONFIRMATION_REQUIRED' }, { status: 400 })
      }
    }

    const db = supabaseAdmin()
    const publicBase = process.env.NEXT_PUBLIC_SUPABASE_URL

    // 1) the database transaction (also queues the Storage objects). Storage has NOT been touched when this fails.
    const { data, error } = await db.rpc('bulk_delete_contacts_internal', {
      p_account_id: accountId,
      p_contact_ids: ids,
      p_public_base: publicBase ?? null,
      p_actor_user_id: userId,
      p_ack_protected: body?.acknowledge_protected === true,
    })
    if (error) return deleteErrorResponse(error)
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
