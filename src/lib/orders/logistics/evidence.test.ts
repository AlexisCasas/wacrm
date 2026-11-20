import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'

import { listChatMedia, parseChatMediaPath, selectEvidenceFromChat } from '@/lib/orders/logistics/evidence'

const BASE = 'https://proj.supabase.example'
const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const OTHER = '55555555-5555-4555-8555-555555555555'
const USER = '99999999-9999-4999-8999-999999999999'
const ORDER = '22222222-2222-4222-8222-222222222222'
const CONV = '66666666-6666-4666-8666-666666666666'
const MSG = '77777777-7777-4777-8777-777777777777'
const DOC = '33333333-3333-4333-8333-333333333333'
const stored = (account = ACCOUNT, name = 'mirror/photo.jpg') => `${BASE}/storage/v1/object/public/chat-media/account-${account}/${name}`
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])

describe('parseChatMediaPath (the only media WACRM can snapshot: its own chat-media objects of THIS account)', () => {
  it('accepts a public chat-media URL of this project inside the account folder', () => {
    expect(parseChatMediaPath(stored(), ACCOUNT, BASE)).toBe(`account-${ACCOUNT}/mirror/photo.jpg`)
    expect(parseChatMediaPath(stored(ACCOUNT, 'mirror/a%20b.jpg') + '?t=1', ACCOUNT, BASE)).toBe(`account-${ACCOUNT}/mirror/a b.jpg`)
  })

  it.each([
    ['another account folder', stored(OTHER)],
    ['another host', `https://evil.example/storage/v1/object/public/chat-media/account-${ACCOUNT}/x.jpg`],
    ['another bucket', `${BASE}/storage/v1/object/public/flow-media/account-${ACCOUNT}/x.jpg`],
    ['the Meta proxy link', '/api/whatsapp/media/123'],
    ['path traversal', `${BASE}/storage/v1/object/public/chat-media/account-${ACCOUNT}/../account-${OTHER}/x.jpg`],
    ['double slash', `${BASE}/storage/v1/object/public/chat-media/account-${ACCOUNT}//x.jpg`],
    ['a signed (non public) url', `${BASE}/storage/v1/object/sign/chat-media/account-${ACCOUNT}/x.jpg?token=1`],
    ['null', null],
  ])('rejects %s', (_name, url) => {
    expect(parseChatMediaPath(url as string | null, ACCOUNT, BASE)).toBeNull()
  })

  it('without a configured project URL nothing is accepted', () => {
    expect(parseChatMediaPath(stored(), ACCOUNT, '')).toBeNull()
  })
})

interface Scenario {
  order?: Record<string, unknown> | null
  replay?: Record<string, unknown> | null
  message?: Record<string, unknown> | null
  download?: 'ok' | 'error' | 'empty' | 'html' | 'big'
  uploadError?: boolean
  rpc?: { data?: unknown; error?: { code: string; message: string } }
}

function fakes(s: Scenario) {
  const uploads: string[] = []
  const removes: string[][] = []
  const rpcs: Array<Record<string, unknown>> = []
  const admin = {
    from: (table: string) => {
      let cols = ''
      const b: Record<string, unknown> = {
        select: (c: string) => ((cols = c), b),
        eq: () => b,
        maybeSingle: async () => {
          if (table === 'order_confirmations') return { data: s.order === undefined ? { id: ORDER, conversation_id: CONV } : s.order, error: null }
          // order_documents: the idempotency lookup selects source_message_id; the view read selects the public columns
          if (cols.includes('source_message_id')) return { data: s.replay ?? null, error: null }
          return { data: { id: DOC, order_id: ORDER, kind: 'evidence', status: 'active', association: 'direct', row_version: 1 }, error: null }
        },
      }
      return b
    },
    storage: {
      from: (bucket: string) => ({
        download: async () => {
          if (s.download === 'error') return { data: null, error: { message: 'x' } }
          let bytes: Uint8Array = JPEG
          if (s.download === 'empty') bytes = new Uint8Array()
          if (s.download === 'html') bytes = new TextEncoder().encode('<html>')
          if (s.download === 'big') {
            bytes = new Uint8Array(9 * 1024 * 1024)
            bytes.set([0xff, 0xd8, 0xff])
          }
          return { data: new Blob([bytes as BlobPart]), error: null }
        },
        upload: async (path: string) => (uploads.push(`${bucket}:${path}`), { error: s.uploadError ? { message: 'x' } : null }),
        remove: async (paths: string[]) => (removes.push(paths), { error: null }),
      }),
    },
    rpc: async (_n: string, args: Record<string, unknown>) => (rpcs.push(args), { data: s.rpc?.data ?? null, error: s.rpc?.error ?? null }),
  } as unknown as SupabaseClient
  const caller = {
    from: () => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({ data: s.message === undefined ? { id: MSG, content_type: 'image', media_url: stored(), media_type: null, sender_type: 'customer', created_at: 't' } : s.message, error: null }),
      }
      return b
    },
  } as unknown as SupabaseClient
  return { admin, caller, uploads, removes, rpcs }
}

const ctxOf = (caller: SupabaseClient) => ({ supabase: caller, userId: USER, accountId: ACCOUNT })
const run = async (s: Scenario, input: { messageId?: unknown; requestKey?: unknown } = {}) => {
  const f = fakes(s)
  const r = await selectEvidenceFromChat(ctxOf(f.caller), f.admin, ORDER, { messageId: MSG, requestKey: 'req-1', ...input }, { supabaseUrl: BASE, newId: () => DOC })
  return { r, f }
}

describe('selectEvidenceFromChat', () => {
  it('validates ids and the request key before touching anything', async () => {
    const f = fakes({})
    for (const [input, error] of [
      [{ messageId: 'x', requestKey: 'k' }, 'invalid_message_id'],
      [{ messageId: MSG, requestKey: 'has space' }, 'invalid_request_key'],
      [{ messageId: MSG, requestKey: 3 }, 'invalid_request_key'],
    ] as const) {
      expect(await selectEvidenceFromChat(ctxOf(f.caller), f.admin, ORDER, input, { supabaseUrl: BASE })).toMatchObject({ ok: false, status: 400, error })
    }
    expect(await selectEvidenceFromChat(ctxOf(f.caller), f.admin, 'nope', { messageId: MSG, requestKey: 'k' })).toMatchObject({ ok: false, status: 400, error: 'invalid_order_id' })
    expect(f.uploads).toHaveLength(0)
  })

  it('unknown / other-account order -> 404; an order without conversation -> 409', async () => {
    expect((await run({ order: null })).r).toMatchObject({ ok: false, status: 404 })
    expect((await run({ order: { id: ORDER, conversation_id: null } })).r).toMatchObject({ ok: false, status: 409, error: 'order_without_conversation' })
  })

  it('a message the caller cannot read / of another conversation -> 404; text or non-visual media -> 422', async () => {
    expect((await run({ message: null })).r).toMatchObject({ ok: false, status: 404, error: 'message_not_found' })
    expect((await run({ message: { id: MSG, content_type: 'text', media_url: null } })).r).toMatchObject({ ok: false, status: 422, error: 'message_has_no_media' })
    expect((await run({ message: { id: MSG, content_type: 'audio', media_url: stored() } })).r).toMatchObject({ ok: false, status: 422, error: 'message_has_no_media' })
  })

  it("media that is NOT in this account's chat-media (Meta proxy link, other account) -> 422 media_not_stored, nothing uploaded", async () => {
    for (const url of ['/api/whatsapp/media/123', stored(OTHER)]) {
      const { r, f } = await run({ message: { id: MSG, content_type: 'image', media_url: url } })
      expect(r).toMatchObject({ ok: false, status: 422, error: 'media_not_stored' })
      expect(f.uploads).toHaveLength(0)
    }
  })

  it('unreadable / empty / non-document / oversized files are refused before any snapshot', async () => {
    expect((await run({ download: 'error' })).r).toMatchObject({ ok: false, status: 422, error: 'media_not_stored' })
    expect((await run({ download: 'empty' })).r).toMatchObject({ ok: false, status: 422, error: 'media_not_stored' })
    expect((await run({ download: 'html' })).r).toMatchObject({ ok: false, status: 415, error: 'unsupported_evidence_type' })
    expect((await run({ download: 'big' })).r).toMatchObject({ ok: false, status: 413, error: 'file_too_large' })
    for (const d of ['error', 'empty', 'html', 'big'] as const) expect((await run({ download: d })).f.uploads).toHaveLength(0)
  })

  it('replay of the same request_key answers without downloading or uploading anything', async () => {
    const { r, f } = await run({ replay: { id: DOC, order_id: ORDER, kind: 'evidence', source_message_id: MSG } })
    expect(r).toMatchObject({ ok: true, status: 200, body: { created: false } })
    expect(f.uploads).toHaveLength(0)
    expect(f.rpcs).toHaveLength(0)
  })

  it('the same key used for something else is a conflict', async () => {
    expect((await run({ replay: { id: DOC, order_id: ORDER, kind: 'evidence', source_message_id: OTHER } })).r).toMatchObject({ ok: false, status: 409, error: 'request_key_conflict' })
    expect((await run({ replay: { id: DOC, order_id: OTHER, kind: 'evidence', source_message_id: MSG } })).r).toMatchObject({ ok: false, status: 409 })
    expect((await run({ replay: { id: DOC, order_id: ORDER, kind: 'voucher', source_message_id: MSG } })).r).toMatchObject({ ok: false, status: 409 })
  })

  it('success: PRIVATE snapshot under account/order/evidence; the RPC gets the session actor and the validated ids', async () => {
    const { r, f } = await run({ rpc: { data: { ok: true, created: true, document_id: DOC } } })
    expect(r).toMatchObject({ ok: true, status: 201, body: { created: true, evidence: { id: DOC } } })
    expect(f.uploads).toEqual([`order-docs:account-${ACCOUNT}/orders/${ORDER}/evidence/${DOC}/photo.jpg`])
    expect(f.rpcs[0]).toMatchObject({ p_account: ACCOUNT, p_actor: USER, p_order: ORDER, p_message: MSG, p_doc_id: DOC, p_request_key: 'req-1', p_mime: 'image/jpeg', p_size: JPEG.byteLength })
    expect(f.removes).toHaveLength(0)
  })

  it.each([
    ['not_packing', 409],
    ['already_ready', 409],
    ['dispatch_open', 409],
    ['order_without_conversation', 409],
    ['message_not_in_conversation', 404],
  ])('database refusal %s -> HTTP %i and the snapshot is removed', async (reason, status) => {
    const { r, f } = await run({ rpc: { data: { ok: false, reason } } })
    expect(r).toMatchObject({ ok: false, status, error: reason })
    expect(f.removes).toHaveLength(1)
  })

  it('selecting the same message again (unchanged) removes the redundant snapshot', async () => {
    const { r, f } = await run({ rpc: { data: { ok: true, created: false, unchanged: true, document_id: DOC } } })
    expect(r).toMatchObject({ ok: true, status: 200, body: { created: false } })
    expect(f.removes).toHaveLength(1)
  })

  it('forbidden by the database -> 404; flag off -> 403; Storage failure -> 502 and no RPC', async () => {
    expect((await run({ rpc: { error: { code: '42501', message: 'forbidden' } } })).r).toMatchObject({ ok: false, status: 404 })
    expect((await run({ rpc: { error: { code: '42501', message: 'feature_disabled' } } })).r).toMatchObject({ ok: false, status: 403 })
    const { r, f } = await run({ uploadError: true })
    expect(r).toMatchObject({ ok: false, status: 502, error: 'storage_failed' })
    expect(f.rpcs).toHaveLength(0)
  })
})

describe('listChatMedia', () => {
  const caller = (rows: unknown[], opts: { allowed?: boolean; order?: unknown } = {}) =>
    ({
      supabase: {
        rpc: async () => ({ data: opts.allowed ?? true, error: null }),
        from: (table: string) => {
          const b: Record<string, unknown> = {
            select: () => b,
            eq: () => b,
            not: () => b,
            in: () => b,
            order: () => b,
            limit: async () => ({ data: rows, error: null }),
            maybeSingle: async () => ({ data: table === 'order_confirmations' ? (opts.order === undefined ? { id: ORDER, conversation_id: CONV } : opts.order) : null, error: null }),
          }
          return b
        },
      } as unknown as SupabaseClient,
      userId: USER,
      accountId: ACCOUNT,
      role: 'agent' as const,
    }) as const

  it('flags which messages can be kept as evidence (stored in this account) and previews only those', async () => {
    const rows = [
      { id: 'm1', content_type: 'image', media_url: stored(), media_type: 'image/jpeg', sender_type: 'customer', created_at: 't1' },
      { id: 'm2', content_type: 'image', media_url: '/api/whatsapp/media/9', media_type: null, sender_type: 'customer', created_at: 't2' },
    ]
    const r = await listChatMedia(caller(rows), ORDER, BASE)
    expect(r).toMatchObject({ ok: true, body: { media: [{ message_id: 'm1', available: true, preview_url: stored() }, { message_id: 'm2', available: false, preview_url: null }] } })
  })

  it('a caller the database does not recognise as logistics gets the 404 of a non-existent order; an order without chat -> 409', async () => {
    expect(await listChatMedia(caller([], { allowed: false }), ORDER, BASE)).toMatchObject({ ok: false, status: 404 })
    expect(await listChatMedia(caller([], { order: { id: ORDER, conversation_id: null } }), ORDER, BASE)).toMatchObject({ ok: false, status: 409, error: 'order_without_conversation' })
    expect(await listChatMedia(caller([], { order: null }), ORDER, BASE)).toMatchObject({ ok: false, status: 404 })
  })
})
