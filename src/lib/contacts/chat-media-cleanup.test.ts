import { describe, expect, it } from 'vitest'
import { classifyMediaUrl, CHAT_MEDIA_BUCKET } from './chat-media-cleanup'

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
