import { describe, expect, it, vi } from 'vitest'
import { classifyMediaUrl, planMediaCleanup, removeChatMedia, CHAT_MEDIA_BUCKET } from './chat-media-cleanup'

const ACCOUNT = 'a1000000-0000-4000-8000-000000000001'
const OTHER = 'b1000000-0000-4000-8000-000000000001'
const BASE = 'https://supabase.example.com'
const ctx = { accountId: ACCOUNT, publicBase: BASE }
const url = (bucket: string, path: string) => `${BASE}/storage/v1/object/public/${bucket}/${path}`
const mine = (file: string) => url('chat-media', `account-${ACCOUNT}/${file}`)

describe('classifyMediaUrl — only chat-media/account-<own account>/… is deletable', () => {
  it.each([
    ['image', 'inbound/1-image.jpg'],
    ['audio', '1792440803298-voice-1792440802977.ogg'],
    ['video', 'inbound/clip.mp4'],
    ['document', '1791935563320-CAT_LORTEG_TOTAL_13M.pdf'],
  ])('%s of the caller is deletable', (_k, file) => {
    expect(classifyMediaUrl(mine(file), ctx)).toEqual({ kind: 'delete', bucket: CHAT_MEDIA_BUCKET, path: `account-${ACCOUNT}/${file}` })
  })

  it('decodes percent-encoded names to the real object path', () => {
    expect(classifyMediaUrl(mine('foto%20nueva%20%C3%B1.jpg'), ctx)).toEqual({ kind: 'delete', bucket: 'chat-media', path: `account-${ACCOUNT}/foto nueva ñ.jpg` })
  })

  it.each([
    ['another account namespace', url('chat-media', `account-${OTHER}/x.jpg`), 'wrong_namespace'],
    ['no namespace', url('chat-media', 'x.jpg'), 'invalid_path'],
    ['flow catalog bucket', url('flow-media', `account-${ACCOUNT}/catalog.png`), 'bucket_not_eligible'],
    ['voice-notes bucket', url('voice-notes', `account-${ACCOUNT}/v.ogg`), 'bucket_not_eligible'],
    ['avatars bucket', url('avatars', `account-${ACCOUNT}/a.png`), 'bucket_not_eligible'],
    ['external host', 'https://example.org/storage/v1/object/public/chat-media/account-' + ACCOUNT + '/x.jpg', 'external'],
    ['lookalike host', 'https://supabase.example.com.evil.io/storage/v1/object/public/chat-media/account-' + ACCOUNT + '/x.jpg', 'external'],
    ['WhatsApp proxy path', '/api/whatsapp/media/13688', 'not_storage'],
    ['empty', '', 'not_storage'],
    ['garbage', 'not a url', 'not_storage'],
    ['signed url', `${BASE}/storage/v1/object/sign/chat-media/account-${ACCOUNT}/x.jpg?token=abc`, 'unsupported_url'],
    ['query string', mine('x.jpg') + '?download=1', 'invalid_path'],
    ['path traversal', mine('../account-' + OTHER + '/x.jpg'), 'invalid_path'],
    ['encoded traversal', mine('%2e%2e/x.jpg'), 'invalid_path'],
    ['encoded slash', mine('a%2Fb.jpg'), 'invalid_path'],
    ['encoded backslash', mine('a%5Cb.jpg'), 'invalid_path'],
    ['bad escape', mine('%E0%A4%A.jpg'), 'invalid_path'],
    ['empty segment', url('chat-media', `account-${ACCOUNT}//x.jpg`), 'invalid_path'],
    ['namespace only', url('chat-media', `account-${ACCOUNT}`), 'invalid_path'],
  ])('%s is never deleted (%s)', (_label, input, reason) => {
    expect(classifyMediaUrl(input, ctx)).toEqual({ kind: 'skip', reason })
  })

  it('without a configured own origin nothing is provably managed (fail closed)', () => {
    expect(classifyMediaUrl(mine('x.jpg'), { accountId: ACCOUNT, publicBase: undefined })).toEqual({ kind: 'skip', reason: 'external' })
  })
})

describe('planMediaCleanup', () => {
  it('splits deletable / shared / skipped and never lists an object twice', () => {
    const plan = planMediaCleanup([
      { media_url: mine('inbound/a.jpg'), shared: false },
      { media_url: mine('inbound/a.jpg'), shared: false }, // same object used by two messages of the same chat
      { media_url: mine('shared.jpg'), shared: true },
      { media_url: url('flow-media', `account-${ACCOUNT}/catalog.png`), shared: true },
      { media_url: 'https://example.org/x.jpg', shared: false },
      { media_url: url('chat-media', `account-${OTHER}/x.jpg`), shared: false },
    ], ctx)
    expect(plan.deletable).toEqual([`account-${ACCOUNT}/inbound/a.jpg`])
    expect(plan.preservedShared).toEqual([`account-${ACCOUNT}/shared.jpg`])
    expect(plan.skipped.map((s) => s.reason).sort()).toEqual(['bucket_not_eligible', 'external', 'wrong_namespace'])
    expect(plan.identified).toBe(6)
  })

  it('an object is preserved if ANY url that points at it is shared', () => {
    const plan = planMediaCleanup([{ media_url: mine('x.jpg'), shared: false }, { media_url: mine('x.jpg'), shared: true }], ctx)
    expect(plan.deletable).toEqual([])
    expect(plan.preservedShared).toHaveLength(1)
  })

  it('objects already handled in the first pass are not handled again', () => {
    const handled = new Set([`account-${ACCOUNT}/a.jpg`])
    const plan = planMediaCleanup([{ media_url: mine('a.jpg'), shared: false }, { media_url: mine('late.jpg'), shared: false }], ctx, handled)
    expect(plan.deletable).toEqual([`account-${ACCOUNT}/late.jpg`])
  })
})

describe('removeChatMedia', () => {
  const storageWith = (impl: (paths: string[]) => Promise<{ data: unknown[] | null; error: { message: string } | null }>) => {
    const remove = vi.fn(impl)
    const from = vi.fn((bucket: string) => ({ bucket, remove }))
    return { storage: { from }, remove, from }
  }

  it('removes in chunks from the chat-media bucket only and counts removed vs already missing', async () => {
    const present = new Set(['a', 'b', 'c'])
    const { storage, remove, from } = storageWith(async (paths) => ({ data: paths.filter((p) => present.has(p)).map((name) => ({ name })), error: null }))
    const r = await removeChatMedia(storage, ['a', 'b', 'c', 'gone'], 2)
    expect(r).toEqual({ removed: 3, alreadyMissing: 1, failed: [] })
    expect(remove).toHaveBeenCalledTimes(2)
    expect(from.mock.calls.every((c) => c[0] === 'chat-media')).toBe(true)
  })

  it('a Storage error is returned, never swallowed, and does not stop the report of the other chunks', async () => {
    let n = 0
    const { storage } = storageWith(async (paths) => (++n === 1 ? { data: null, error: { message: 'boom' } } : { data: paths.map((name) => ({ name })), error: null }))
    const r = await removeChatMedia(storage, ['a', 'b', 'c'], 2)
    expect(r.failed).toEqual([{ path: 'a', error: 'boom' }, { path: 'b', error: 'boom' }])
    expect(r.removed).toBe(1)
  })

  it('a thrown error is also reported', async () => {
    const { storage } = storageWith(async () => { throw new Error('network') })
    expect((await removeChatMedia(storage, ['a'])).failed).toEqual([{ path: 'a', error: 'network' }])
  })
})
