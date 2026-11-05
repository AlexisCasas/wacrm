import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/contacts/admin-client'
import { planMediaCleanup, removeChatMedia, type MediaCandidate } from '@/lib/contacts/chat-media-cleanup'

export const MAX_BULK_DELETE = 100
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * POST /api/contacts/bulk-delete  { contact_ids: string[] }
 *
 * Permanently deletes EXACTLY the given contacts with everything that belongs only to them: chats, messages, tags, custom values, notes,
 * identities, runs, pending waits, notifications (database) AND the chat media files (Storage). Nothing is blocked afterwards: the same
 * phone / BSUID simply creates a new contact on its next inbound. The account comes from the session; one foreign id rejects the batch.
 *
 * Order (Storage and Postgres are not one transaction, so the order is deliberate):
 *   1. contact_chat_media_candidates  — read-only: proves ownership, freezes the list of media of the selected chats.
 *   2. classify: only `chat-media/account-<session account>/…` objects used by no surviving chat or catalog are deletable.
 *   3. delete those objects. Any failure => STOP here (HTTP 502): no contact has been deleted.
 *   4. bulk_delete_contacts_internal — one transaction (all contacts or none). If it fails AFTER step 3 the response says so explicitly
 *      (`inconsistent: true`, files already removed); there is no Storage rollback to pretend with.
 *   5. media that arrived between 1 and 4 is returned by the transaction and removed in a second pass; failures are reported
 *      (`media.cleanup_complete = false`), never hidden.
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
    const ctx = { accountId, publicBase: process.env.NEXT_PUBLIC_SUPABASE_URL }

    // 1) frozen list of the media of the selected chats (also rejects a batch that contains a contact of another account)
    const planned = await db.rpc('contact_chat_media_candidates', { p_account_id: accountId, p_contact_ids: ids })
    if (planned.error) {
      if (planned.error.message?.includes('CONTACTS_NOT_IN_ACCOUNT')) {
        return NextResponse.json({ error: 'One or more contacts were not found', deleted: 0 }, { status: 404 })
      }
      console.error('[contacts] contact_chat_media_candidates failed:', planned.error.message)
      return NextResponse.json({ error: 'Failed to delete contacts', deleted: 0 }, { status: 500 })
    }

    // 2) + 3) Storage first; a failure here leaves every contact untouched
    const plan = planMediaCleanup((planned.data ?? []) as MediaCandidate[], ctx)
    const first = await removeChatMedia(db.storage, plan.deletable)
    const media = {
      identified: plan.identified,
      deleted: first.removed,
      already_missing: first.alreadyMissing,
      preserved_shared: plan.preservedShared.length,
      skipped: plan.skipped.length,
      failed: first.failed.length,
      late_deleted: 0,
      cleanup_complete: true,
    }
    if (first.failed.length > 0) {
      console.error('[contacts] chat media cleanup failed before the database delete:', first.failed.slice(0, 5))
      return NextResponse.json({
        error: 'Could not remove the chat media; no contact was deleted',
        deleted: 0,
        media: { ...media, cleanup_complete: false },
        inconsistent: first.removed > 0, // some files of the selected chats are already gone while their contacts remain
      }, { status: 502 })
    }

    // 4) one database transaction
    const { data, error } = await db.rpc('bulk_delete_contacts_internal', { p_account_id: accountId, p_contact_ids: ids })
    if (error) {
      const notFound = error.message?.includes('CONTACTS_NOT_IN_ACCOUNT')
      if (!notFound) console.error('[contacts] bulk_delete_contacts_internal failed:', error.message)
      return NextResponse.json({
        error: notFound ? 'One or more contacts were not found' : 'Failed to delete contacts',
        deleted: 0,
        media,
        inconsistent: first.removed > 0,
      }, { status: notFound ? 404 : 500 })
    }
    const result = (data ?? {}) as {
      deleted?: number; conversations_deleted?: number; messages_deleted?: number
      runs_deleted?: number; pending_automations_deleted?: number; notifications_deleted?: number
      media?: MediaCandidate[]
    }

    // 5) media that appeared after the frozen list (same rules, objects already handled are skipped)
    const handled = new Set([...plan.deletable, ...plan.preservedShared])
    const late = planMediaCleanup(result.media ?? [], ctx, handled)
    if (late.deletable.length > 0) {
      const second = await removeChatMedia(db.storage, late.deletable)
      media.late_deleted = second.removed
      media.deleted += second.removed
      media.failed += second.failed.length
      media.preserved_shared += late.preservedShared.length
      if (second.failed.length > 0) {
        console.error('[contacts] late chat media cleanup failed:', second.failed.slice(0, 5))
        media.cleanup_complete = false
      }
    }

    return NextResponse.json({
      success: true,
      deleted: result.deleted ?? 0,
      conversations_deleted: result.conversations_deleted ?? 0,
      messages_deleted: result.messages_deleted ?? 0,
      runs_deleted: result.runs_deleted ?? 0,
      pending_automations_deleted: result.pending_automations_deleted ?? 0,
      notifications_deleted: result.notifications_deleted ?? 0,
      media,
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
