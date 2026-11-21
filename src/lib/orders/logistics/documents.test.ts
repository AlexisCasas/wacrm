import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'

import { documentSignedUrl, listDocuments, uploadVoucher } from '@/lib/orders/logistics/documents'
import { MAX_DOCUMENT_BYTES } from '@/lib/orders/logistics/constants'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const USER = '99999999-9999-4999-8999-999999999999'
const ORDER = '22222222-2222-4222-8222-222222222222'
const DOC = '33333333-3333-4333-8333-333333333333'
const BATCH = '44444444-4444-4444-8444-444444444444'

const PDF = new TextEncoder().encode('%PDF-1.7\nvoucher bytes')

interface Fake {
  uploads: Array<{ path: string; contentType?: string }>
  removes: string[][]
  rpcs: Array<{ name: string; args: Record<string, unknown> }>
  admin: SupabaseClient
}

/** A fake service client: records Storage and RPC traffic, answers from the configured scenario. */
function fakeAdmin(opts: {
  existing?: Record<string, unknown> | null
  uploadError?: boolean
  rpc?: { data?: unknown; error?: { code: string; message: string } }
  view?: Record<string, unknown> | null
  signed?: { signedUrl?: string; error?: boolean }
}): Fake {
  const f: Fake = { uploads: [], removes: [], rpcs: [], admin: undefined as unknown as SupabaseClient }
  const view = opts.view === undefined ? { id: DOC, order_id: ORDER, kind: 'voucher', status: 'pending_review', association: 'direct', row_version: 1 } : opts.view
  f.admin = {
    storage: {
      from: () => ({
        upload: async (path: string, _bytes: Uint8Array, o: { contentType?: string }) => {
          f.uploads.push({ path, contentType: o.contentType })
          return opts.uploadError ? { error: { message: 'x' } } : { error: null }
        },
        remove: async (paths: string[]) => (f.removes.push(paths), { error: null }),
        createSignedUrl: async () => (opts.signed?.error ? { data: null, error: { message: 'x' } } : { data: { signedUrl: opts.signed?.signedUrl ?? 'https://signed.example/x' }, error: null }),
      }),
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      f.rpcs.push({ name, args })
      return { data: opts.rpc?.data ?? null, error: opts.rpc?.error ?? null }
    },
    from: () => {
      const b: Record<string, unknown> = {
        select: (cols: string) => ((b._cols = cols), b),
        eq: () => b,
        maybeSingle: async () => ({ data: String(b._cols).includes('content_hash') ? (opts.existing ?? null) : view, error: null }),
      }
      return b
    },
  } as unknown as SupabaseClient
  return f
}

const input = (over: Record<string, unknown> = {}) => ({
  fileName: 'Comprobante.pdf',
  bytes: PDF,
  orderId: ORDER as string | null,
  batchId: null as string | null,
  requestKey: 'req-1',
  allowDuplicate: false,
  ...over,
})
const ctx = { userId: USER, accountId: ACCOUNT }
const upload = (f: Fake, over: Record<string, unknown> = {}) => uploadVoucher(ctx, f.admin, input(over), () => DOC)

describe('uploadVoucher · validation (nothing is uploaded or registered)', () => {
  it.each([
    ['bad request key', { requestKey: 'has space' }, 400, 'invalid_request_key'],
    ['bad order id', { orderId: 'nope' }, 400, 'invalid_order_id'],
    ['bad batch id', { batchId: 'nope' }, 400, 'invalid_batch_id'],
    ['empty file', { bytes: new Uint8Array() }, 400, 'empty_file'],
    ['too large', { bytes: new Uint8Array(MAX_DOCUMENT_BYTES + 1) }, 413, 'file_too_large'],
    ['unsupported type (html pretending to be a pdf)', { bytes: new TextEncoder().encode('<html>x</html>'), fileName: 'v.pdf' }, 415, 'unsupported_file_type'],
  ])('%s', async (_name, over, status, error) => {
    const f = fakeAdmin({})
    const r = await upload(f, over)
    expect(r).toMatchObject({ ok: false, status, error })
    expect(f.uploads).toHaveLength(0)
    expect(f.rpcs).toHaveLength(0)
  })
})

describe('uploadVoucher · idempotency', () => {
  it('same request_key + same content = replay: the existing document, no upload, no RPC', async () => {
    const { sha256Hex } = await import('@/lib/orders/logistics/files')
    const f = fakeAdmin({ existing: { id: DOC, order_id: ORDER, status: 'pending_review', content_hash: sha256Hex(PDF) } })
    const r = await upload(f)
    expect(r).toMatchObject({ ok: true, status: 200, body: { created: false } })
    expect(f.uploads).toHaveLength(0)
    expect(f.rpcs).toHaveLength(0)
    expect(JSON.stringify(r)).not.toContain('content_hash')
  })

  it('same request_key + different content = 409 conflict', async () => {
    const f = fakeAdmin({ existing: { id: DOC, content_hash: 'f'.repeat(64) } })
    expect(await upload(f)).toMatchObject({ ok: false, status: 409, error: 'request_key_conflict' })
    expect(f.uploads).toHaveLength(0)
  })
})

describe('uploadVoucher · direct (order known) and bulk', () => {
  it('direct: private path account/order scoped, sniffed type, association by order id, actor + account from the session context', async () => {
    const f = fakeAdmin({ rpc: { data: { ok: true, created: true, document_id: DOC } } })
    const r = await upload(f)
    expect(r).toMatchObject({ ok: true, status: 201, body: { created: true, document: { id: DOC } } })
    expect(f.uploads).toEqual([{ path: `account-${ACCOUNT}/orders/${ORDER}/vouchers/${DOC}/Comprobante.pdf`, contentType: 'application/pdf' }])
    expect(f.rpcs[0].name).toBe('register_order_document')
    expect(f.rpcs[0].args).toMatchObject({ p_account: ACCOUNT, p_actor: USER, p_order: ORDER, p_batch: null, p_request_key: 'req-1', p_mime: 'application/pdf', p_doc_id: DOC })
    expect(f.removes).toHaveLength(0)
  })

  it('bulk: no order, grouped by batch, stored under "unassigned"', async () => {
    const f = fakeAdmin({ rpc: { data: { ok: true, created: true, document_id: DOC } } })
    await upload(f, { orderId: null, batchId: BATCH })
    expect(f.uploads[0].path).toBe(`account-${ACCOUNT}/orders/unassigned/vouchers/${DOC}/Comprobante.pdf`)
    expect(f.rpcs[0].args).toMatchObject({ p_order: null, p_batch: BATCH })
  })

  it('the declared name never decides the extension or the type', async () => {
    const f = fakeAdmin({ rpc: { data: { ok: true, created: true, document_id: DOC } } })
    await upload(f, { fileName: '../../evil.exe' })
    expect(f.uploads[0].path.endsWith('/evil.pdf')).toBe(true)
  })
})

describe('uploadVoucher · refusals clean up the private object', () => {
  it('Storage failure -> 502 and no RPC', async () => {
    const f = fakeAdmin({ uploadError: true })
    expect(await upload(f)).toMatchObject({ ok: false, status: 502, error: 'storage_failed' })
    expect(f.rpcs).toHaveLength(0)
  })

  it('duplicate -> 409 with the duplicate reference, object removed', async () => {
    const f = fakeAdmin({ rpc: { data: { ok: false, reason: 'duplicate', duplicate_of: DOC, duplicate_order_id: ORDER } } })
    expect(await upload(f)).toMatchObject({ ok: false, status: 409, error: 'duplicate', extra: { duplicate_of: DOC, duplicate_order_id: ORDER } })
    expect(f.removes).toHaveLength(1)
  })

  it('allow_duplicate is passed to the database (explicit decision of a person)', async () => {
    const f = fakeAdmin({ rpc: { data: { ok: true, created: true, document_id: DOC } } })
    await upload(f, { allowDuplicate: true })
    expect(f.rpcs[0].args.p_allow_duplicate).toBe(true)
  })

  it('order locked (packaging started) -> 409, object removed', async () => {
    const f = fakeAdmin({ rpc: { data: { ok: false, reason: 'order_locked' } } })
    expect(await upload(f)).toMatchObject({ ok: false, status: 409, error: 'order_locked' })
    expect(f.removes).toHaveLength(1)
  })

  it('order of another account / non-existent: 404 (indistinguishable), object removed', async () => {
    const f = fakeAdmin({ rpc: { error: { code: '42501', message: 'forbidden' } } })
    expect(await upload(f)).toMatchObject({ ok: false, status: 404, error: 'not_found' })
    expect(f.removes).toHaveLength(1)
  })

  it('flag turned off in the database -> 403 feature_disabled, object removed', async () => {
    const f = fakeAdmin({ rpc: { error: { code: '42501', message: 'feature_disabled' } } })
    expect(await upload(f)).toMatchObject({ ok: false, status: 403, error: 'feature_disabled' })
    expect(f.removes).toHaveLength(1)
  })

  it('an unexpected database error -> 500 without leaking its text, object removed', async () => {
    const f = fakeAdmin({ rpc: { error: { code: 'XX000', message: 'secret internal detail' } } })
    const r = await upload(f)
    expect(r).toMatchObject({ ok: false, status: 500, error: 'internal_error' })
    expect(JSON.stringify(r)).not.toContain('secret')
    expect(f.removes).toHaveLength(1)
  })

  it('lost a race with the same request_key: the winner is returned and OUR object is removed', async () => {
    const f = fakeAdmin({ rpc: { data: { ok: true, created: false, document_id: DOC } } })
    expect(await upload(f)).toMatchObject({ ok: true, status: 200, body: { created: false } })
    expect(f.removes).toHaveLength(1)
  })
})

describe('listDocuments (caller client, RLS on top of the account filter)', () => {
  const caller = (rows: unknown[], calls: Array<[string, unknown]> = []) => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => (calls.push([c, v]), b),
      order: () => b,
      limit: async (n: number) => (calls.push(['limit', n]), { data: rows, error: null }),
    }
    return { supabase: { from: () => b } as unknown as SupabaseClient, userId: USER, accountId: ACCOUNT, role: 'agent' as const }
  }

  it('always filters by the session account and clamps the limit', async () => {
    const calls: Array<[string, unknown]> = []
    const r = await listDocuments(caller([{ id: DOC }], calls), { orderId: ORDER, association: 'pending', limit: 9999 })
    expect(r).toMatchObject({ ok: true, body: { documents: [{ id: DOC }] } })
    expect(calls).toEqual(expect.arrayContaining([['account_id', ACCOUNT], ['order_id', ORDER], ['association', 'pending'], ['limit', 100]]))
  })

  it.each([
    [{ orderId: 'x' }, 'invalid_order_id'],
    [{ batchId: 'x' }, 'invalid_batch_id'],
    [{ kind: 'x' }, 'invalid_kind'],
    [{ status: 'x' }, 'invalid_status'],
    [{ association: 'x' }, 'invalid_association'],
  ])('rejects invalid filter %j', async (filter, error) => {
    expect(await listDocuments(caller([]), filter)).toMatchObject({ ok: false, status: 400, error })
  })
})

describe('documentSignedUrl', () => {
  const caller = (doc: unknown) => ({
    supabase: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: doc, error: null }) }) }) }) }) } as unknown as SupabaseClient,
    userId: USER,
    accountId: ACCOUNT,
    role: 'agent' as const,
  })

  it('a document the caller cannot see (other account / hidden by RLS / unknown) is a plain 404', async () => {
    const f = fakeAdmin({})
    expect(await documentSignedUrl(caller(null), f.admin, DOC)).toMatchObject({ ok: false, status: 404, error: 'not_found' })
  })

  it('returns a short-lived URL and never the storage path', async () => {
    const f = fakeAdmin({ signed: { signedUrl: 'https://signed.example/abc?token=1' } })
    const r = await documentSignedUrl(caller({ id: DOC, storage_path: `account-${ACCOUNT}/orders/x/vouchers/y/z.pdf`, mime_type: 'application/pdf', original_filename: 'z.pdf' }), f.admin, DOC)
    expect(r).toMatchObject({ ok: true, body: { url: 'https://signed.example/abc?token=1', expires_in: 120, mime_type: 'application/pdf', filename: 'z.pdf' } })
    expect(JSON.stringify(r)).not.toContain('account-')
  })

  it('invalid id -> 400; storage failure -> 502', async () => {
    const f = fakeAdmin({ signed: { error: true } })
    expect(await documentSignedUrl(caller(null), f.admin, 'nope')).toMatchObject({ ok: false, status: 400 })
    expect(await documentSignedUrl(caller({ id: DOC, storage_path: 'p', mime_type: 'a', original_filename: 'b' }), f.admin, DOC)).toMatchObject({ ok: false, status: 502 })
  })
})
