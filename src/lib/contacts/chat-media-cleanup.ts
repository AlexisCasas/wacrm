/**
 * Which Storage objects may be removed together with the chats of deleted contacts.
 *
 * The database queues objects (classify_chat_media_object, migration 20261107) inside the delete transaction; before an object is actually
 * removed from Storage this validator must AGREE with the queued path (two independent implementations, fail closed on any difference).
 *
 * Only ONE thing is ever deletable: a public object of the `chat-media` bucket whose path starts with the CALLER's own namespace
 * `account-<account_id>/` and that no message of a surviving conversation (and no flow / automation catalog) uses. Everything else is
 * skipped with a reason and never touched (fail closed): other buckets (flow-media / voice-notes hold the Flow catalog shared by every contact),
 * other accounts' paths, external hosts, WhatsApp proxy urls, signed urls, malformed or traversing paths.
 */
export const CHAT_MEDIA_BUCKET = 'chat-media'
const PUBLIC_PREFIX = '/storage/v1/object/public/'

export type SkipReason = 'not_storage' | 'external' | 'unsupported_url' | 'bucket_not_eligible' | 'wrong_namespace' | 'invalid_path'

export type Classified = { kind: 'delete'; bucket: string; path: string } | { kind: 'skip'; reason: SkipReason }

export function classifyMediaUrl(rawUrl: string, ctx: { accountId: string; publicBase: string | undefined }): Classified {
  const skip = (reason: SkipReason): Classified => ({ kind: 'skip', reason })
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return skip('not_storage')
  if (rawUrl.startsWith('/')) return skip('not_storage') // e.g. /api/whatsapp/media/123 — the WhatsApp proxy, not Storage
  let url: URL
  try { url = new URL(rawUrl) } catch { return skip('not_storage') }
  let base: URL
  try { base = new URL(ctx.publicBase ?? '') } catch { return skip('external') } // unknown own origin: nothing can be proven managed
  if (url.origin !== base.origin) return skip('external')
  // new URL() silently collapses "/../": look at the raw path too, so a traversal attempt is refused instead of being rewritten
  if (/\/\.\.?(\/|$)/.test(rawUrl.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '').split(/[?#]/)[0])) return skip('invalid_path')
  if (!url.pathname.startsWith(PUBLIC_PREFIX)) return skip('unsupported_url') // signed / authenticated / anything but public
  if (url.search || url.hash) return skip('invalid_path')
  const rest = url.pathname.slice(PUBLIC_PREFIX.length).split('/')
  const [bucket, ...segments] = rest
  if (bucket !== CHAT_MEDIA_BUCKET) return skip('bucket_not_eligible')
  let decoded: string[]
  try { decoded = segments.map((s) => decodeURIComponent(s)) } catch { return skip('invalid_path') }
  if (decoded.length < 2) return skip('invalid_path') // needs namespace + file
  if (decoded.some((s) => s === '' || s === '.' || s === '..' || /[\\/\u0000]/.test(s))) return skip('invalid_path')
  if (decoded[0] !== `account-${ctx.accountId}`) return skip('wrong_namespace')
  return { kind: 'delete', bucket, path: decoded.join('/') }
}
