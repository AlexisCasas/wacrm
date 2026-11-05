/**
 * Which Storage objects may be removed together with the chats of deleted contacts.
 *
 * Only ONE thing is ever deletable: a public object of the `chat-media` bucket whose path starts with the CALLER's own namespace
 * `account-<account_id>/` and that no message of a surviving conversation (and no flow / automation catalog) uses. Everything else is
 * skipped with a reason and never touched (fail closed): other buckets (flow-media / voice-notes hold the Flow catalog shared by every contact),
 * other accounts' paths, external hosts, WhatsApp proxy urls, signed urls, malformed or traversing paths.
 */
export const CHAT_MEDIA_BUCKET = 'chat-media'
const PUBLIC_PREFIX = '/storage/v1/object/public/'

export type MediaCandidate = { media_url: string; shared: boolean }
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

export type MediaPlan = {
  identified: number
  deletable: string[]
  preservedShared: string[]
  skipped: Array<{ url: string; reason: SkipReason }>
}

/** Groups candidate urls by object: an object is deletable only if NO url pointing at it is shared. */
export function planMediaCleanup(candidates: MediaCandidate[], ctx: { accountId: string; publicBase: string | undefined }, alreadyHandled: ReadonlySet<string> = new Set()): MediaPlan {
  const byPath = new Map<string, { shared: boolean }>()
  const skipped: MediaPlan['skipped'] = []
  for (const c of candidates) {
    const r = classifyMediaUrl(c.media_url, ctx)
    if (r.kind === 'skip') { skipped.push({ url: c.media_url, reason: r.reason }); continue }
    const prev = byPath.get(r.path)
    byPath.set(r.path, { shared: (prev?.shared ?? false) || c.shared })
  }
  const deletable: string[] = []
  const preservedShared: string[] = []
  for (const [path, v] of byPath) {
    if (alreadyHandled.has(path)) continue
    if (v.shared) preservedShared.push(path)
    else deletable.push(path)
  }
  return { identified: candidates.length, deletable: deletable.sort(), preservedShared: preservedShared.sort(), skipped }
}

type StorageLike = { from: (bucket: string) => { remove: (paths: string[]) => Promise<{ data: unknown[] | null; error: { message: string } | null }> } }
export type RemoveResult = { removed: number; alreadyMissing: number; failed: Array<{ path: string; error: string }> }

/** Removes the objects in chunks. An error never throws: it is returned so the caller can stop BEFORE touching the database. */
export async function removeChatMedia(storage: StorageLike, paths: string[], chunkSize = 100): Promise<RemoveResult> {
  const out: RemoveResult = { removed: 0, alreadyMissing: 0, failed: [] }
  for (let i = 0; i < paths.length; i += chunkSize) {
    const chunk = paths.slice(i, i + chunkSize)
    try {
      const { data, error } = await storage.from(CHAT_MEDIA_BUCKET).remove(chunk)
      if (error) { for (const path of chunk) out.failed.push({ path, error: error.message }); continue }
      const removed = Array.isArray(data) ? data.length : 0
      out.removed += removed
      out.alreadyMissing += chunk.length - removed
    } catch (e) {
      for (const path of chunk) out.failed.push({ path, error: e instanceof Error ? e.message : 'storage error' })
    }
  }
  return out
}
