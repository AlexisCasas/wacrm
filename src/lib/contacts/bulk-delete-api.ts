export class BulkDeleteError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Stable machine code from the server (BULK_REQUIRES_ADMIN, PROTECTED_CONTACTS, RATE_LIMIT_ACCOUNT, ...). */
    readonly code?: string,
    /** Counts only (never personal data), e.g. what is protected or how much of a limit is used. */
    readonly detail?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'BulkDeleteError'
  }
}

export type BulkDeleteResult = { deleted: number; conversations_deleted: number; messages_deleted: number; cleanup_complete: boolean; storage_deleted: number; storage_pending: number }

export interface DeletionOptions {
  /** Must be exactly "ELIMINAR" when more than one contact is deleted (the server verifies it). */
  confirm?: string
  /** Explicit acknowledgement for contacts with orders, recent chats or an active block. */
  acknowledgeProtected?: boolean
}

export interface DeletionImpact {
  contacts: number
  conversations: number
  messages: number
  orders: number
  contacts_with_orders: number
  blocked: number
  recent_conversations: number
  with_bsuid: number
  limits: { per_operation: number; account_24h: number; agent_hour: number; recent_days: number }
  account_24h_used: number
  role: string
  can_bulk: boolean
  can_delete_with_orders: boolean
}

/** Server-verified word typed to confirm a multi-contact deletion. */
export const DELETE_CONFIRM_WORD = 'ELIMINAR'

async function readError(res: Response, fallback: string): Promise<BulkDeleteError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string; detail?: Record<string, unknown> }
  return new BulkDeleteError(body.error ?? fallback, res.status, body.code, body.detail)
}

/** Read-only: what deleting these contacts would remove. Counts only. */
export async function previewContactDeletion(contactIds: string[]): Promise<DeletionImpact> {
  const res = await fetch('/api/contacts/bulk-delete/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contact_ids: contactIds }),
  })
  if (!res.ok) throw await readError(res, 'preview failed')
  return (await res.json()) as DeletionImpact
}

/**
 * Deletes exactly the given contacts with their chats, messages and chat media: ONE database transaction first (all or none), then the queued Storage files.
 * The body carries only the selected ids (and the typed confirmation / acknowledgement): never filters, search text, tags or a time range.
 */
export async function bulkDeleteContacts(contactIds: string[], options: DeletionOptions = {}): Promise<BulkDeleteResult> {
  const res = await fetch('/api/contacts/bulk-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contact_ids: contactIds,
      ...(options.confirm ? { confirm: options.confirm } : {}),
      ...(options.acknowledgeProtected ? { acknowledge_protected: true } : {}),
    }),
  })
  if (!res.ok) throw await readError(res, 'bulk delete failed')
  const body = (await res.json().catch(() => ({}))) as Partial<BulkDeleteResult>
  return { deleted: body.deleted ?? 0, conversations_deleted: body.conversations_deleted ?? 0, messages_deleted: body.messages_deleted ?? 0, cleanup_complete: body.cleanup_complete ?? true, storage_deleted: body.storage_deleted ?? 0, storage_pending: body.storage_pending ?? 0 }
}
