export class BulkDeleteError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'BulkDeleteError'
  }
}

export type BulkDeleteMedia = { identified: number; deleted: number; preserved_shared: number; skipped: number; failed: number; cleanup_complete: boolean }
export type BulkDeleteResult = { deleted: number; conversations_deleted: number; messages_deleted: number; media: BulkDeleteMedia | null }

/**
 * Deletes exactly the given contacts with their chats, messages and chat media: files first, then ONE database transaction (all or none).
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
  return { deleted: body.deleted ?? 0, conversations_deleted: body.conversations_deleted ?? 0, messages_deleted: body.messages_deleted ?? 0, media: body.media ?? null }
}
