export class BulkDeleteError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'BulkDeleteError'
  }
}

export type BulkDeleteResult = { deleted: number; conversations_deleted: number; messages_deleted: number; cleanup_complete: boolean; storage_deleted: number; storage_pending: number }

/**
 * Deletes exactly the given contacts with their chats, messages and chat media: ONE database transaction first (all or none), then the queued Storage files.
 * The body carries only the selected ids: never filters, search text, tags or a time range.
 */
export async function bulkDeleteContacts(contactIds: string[]): Promise<BulkDeleteResult> {
  const res = await fetch('/api/contacts/bulk-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contact_ids: contactIds }),
  })
  const body = (await res.json().catch(() => ({}))) as Partial<BulkDeleteResult> & { error?: string }
  if (!res.ok) throw new BulkDeleteError(body.error ?? 'bulk delete failed', res.status)
  return { deleted: body.deleted ?? 0, conversations_deleted: body.conversations_deleted ?? 0, messages_deleted: body.messages_deleted ?? 0, cleanup_complete: body.cleanup_complete ?? true, storage_deleted: body.storage_deleted ?? 0, storage_pending: body.storage_pending ?? 0 }
}
