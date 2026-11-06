// WhatsApp delivery STATUS values coming from Meta's webhook (`value.statuses[].status`), reduced to what `messages.status` can store.
// Pure helpers: the forward-only / tenant-scoped write itself lives in SQL (`apply_whatsapp_message_status`, migration 20261108000000), which is
// the single place where transitions are decided.

/** The values the application persists. `messages.status` also allows `sending`, which only the sender ever writes. */
export type StoredMessageStatus = 'sent' | 'delivered' | 'read' | 'failed'

/**
 * Map Meta's status to a storable one.
 *  - `played` (a voice note was played) implies delivered + read, and the column has no such value: it is stored as `read`.
 *  - Anything else Meta may add later (`deleted`, `warning`, ...) returns null: the event is ignored instead of violating the CHECK.
 */
export function normalizeMetaStatus(raw: unknown): StoredMessageStatus | null {
  switch (raw) {
    case 'sent':
    case 'delivered':
    case 'read':
    case 'failed':
      return raw
    case 'played':
      return 'read'
    default:
      return null
  }
}

/** Meta's `timestamp` is epoch SECONDS as a string. Returns null (never throws) for anything that is not a plausible instant. */
export function parseMetaTimestamp(raw: unknown): Date | null {
  const seconds = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,12}$/.test(raw.trim()) ? Number(raw.trim()) : NaN
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  const date = new Date(seconds * 1000)
  const year = date.getUTCFullYear()
  return Number.isNaN(date.getTime()) || year < 2015 || year > 2100 ? null : date
}
