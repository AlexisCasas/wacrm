import { beforeEach, describe, expect, it, vi } from 'vitest'

const getCurrentAccount = vi.fn()
const resolveAccess = vi.fn()
const uploadVoucher = vi.fn()
const listDocuments = vi.fn()
const documentSignedUrl = vi.fn()

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: () => getCurrentAccount(),
  toErrorResponse: (e: Error) => new Response(JSON.stringify({ error: e.message }), { status: e.message === 'Unauthorized' ? 401 : 500 }),
}))
vi.mock('@/lib/orders/confirmed-orders', () => ({ resolveConfirmedOrdersAccess: (c: unknown) => resolveAccess(c) }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ admin: true }) }))
vi.mock('@/lib/orders/logistics/documents', () => ({
  uploadVoucher: (...a: unknown[]) => uploadVoucher(...a),
  listDocuments: (...a: unknown[]) => listDocuments(...a),
  documentSignedUrl: (...a: unknown[]) => documentSignedUrl(...a),
}))

import { GET, POST } from './route'
import { GET as URL_GET } from './[id]/url/route'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const OTHER = '55555555-5555-4555-8555-555555555555'
const ORDER = '22222222-2222-4222-8222-222222222222'
const DOC = '33333333-3333-4333-8333-333333333333'
const ctx = (role = 'agent') => ({ supabase: {}, userId: 'user-1', accountId: ACCOUNT, role })

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])
function post(fields: Record<string, string | File>) {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.set(k, v)
  return POST(new Request('http://x/api/orders/logistics/documents', { method: 'POST', body: form }))
}
const pdf = () => new File([PDF], 'v.pdf', { type: 'application/pdf' })

beforeEach(() => {
  getCurrentAccount.mockResolvedValue(ctx())
  resolveAccess.mockResolvedValue({ kind: 'ok', operationalRole: 'logistics' })
  uploadVoucher.mockResolvedValue({ ok: true, status: 201, body: { created: true, document: { id: DOC } } })
  listDocuments.mockResolvedValue({ ok: true, status: 200, body: { documents: [] } })
  documentSignedUrl.mockResolvedValue({ ok: true, status: 200, body: { url: 'https://signed.example/x', expires_in: 120, mime_type: 'application/pdf', filename: 'v.pdf' } })
})

describe('authority (every PR-04 document endpoint)', () => {
  it('no session -> 401, nothing is read or written', async () => {
    getCurrentAccount.mockRejectedValue(new Error('Unauthorized'))
    expect((await post({ file: pdf(), request_key: 'k' })).status).toBe(401)
    expect((await GET(new Request('http://x/api/orders/logistics/documents'))).status).toBe(401)
    expect(uploadVoucher).not.toHaveBeenCalled()
    expect(listDocuments).not.toHaveBeenCalled()
  })

  it('flag OFF -> 403 feature_disabled on upload, list and url (legacy account: ZERO PR-04 behaviour)', async () => {
    resolveAccess.mockResolvedValue({ kind: 'disabled' })
    for (const res of [
      await post({ file: pdf(), request_key: 'k' }),
      await GET(new Request('http://x/api/orders/logistics/documents')),
      await URL_GET(new Request('http://x'), { params: Promise.resolve({ id: DOC }) }),
    ]) {
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'feature_disabled' })
    }
    expect(uploadVoucher).not.toHaveBeenCalled()
    expect(listDocuments).not.toHaveBeenCalled()
    expect(documentSignedUrl).not.toHaveBeenCalled()
  })

  it('commercial / no area (PR-02 resolver says forbidden) -> 403 operational_role_required, even if the chat is shared', async () => {
    resolveAccess.mockResolvedValue({ kind: 'forbidden' })
    const res = await post({ file: pdf(), request_key: 'k' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'operational_role_required' })
    expect(uploadVoucher).not.toHaveBeenCalled()
  })

  it('a viewer with a logistics area is read-only everywhere: 403', async () => {
    getCurrentAccount.mockResolvedValue(ctx('viewer'))
    expect((await post({ file: pdf(), request_key: 'k' })).status).toBe(403)
    expect(uploadVoucher).not.toHaveBeenCalled()
  })

  it.each(['agent', 'admin', 'owner'])('logistics / supervisor with account role %s is allowed', async (role) => {
    getCurrentAccount.mockResolvedValue(ctx(role))
    expect((await post({ file: pdf(), request_key: 'k' })).status).toBe(201)
  })
})

describe('POST /api/orders/logistics/documents', () => {
  it('uses the SESSION account and user; an account_id / user_id in the form is never read', async () => {
    await post({ file: pdf(), request_key: 'k-1', order_id: ORDER, account_id: OTHER, user_id: OTHER, role: 'owner' })
    const [callCtx, , input] = uploadVoucher.mock.calls[0]
    expect(callCtx.accountId).toBe(ACCOUNT)
    expect(callCtx.userId).toBe('user-1')
    expect(input).toMatchObject({ orderId: ORDER, batchId: null, requestKey: 'k-1', allowDuplicate: false, fileName: 'v.pdf' })
    expect(JSON.stringify(uploadVoucher.mock.calls[0])).not.toContain(OTHER)
  })

  it('bulk upload: no order, batch id, explicit duplicate decision', async () => {
    await post({ file: pdf(), request_key: 'k-2', batch_id: DOC, allow_duplicate: 'true' })
    expect(uploadVoucher.mock.calls[0][2]).toMatchObject({ orderId: null, batchId: DOC, allowDuplicate: true })
  })

  it('missing file / request key -> 400, nothing uploaded', async () => {
    expect((await post({ request_key: 'k' })).status).toBe(400)
    expect((await post({ file: pdf() })).status).toBe(400)
    expect(uploadVoucher).not.toHaveBeenCalled()
  })

  it('not a multipart body -> 400', async () => {
    const res = await POST(new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' }))
    expect(res.status).toBe(400)
  })

  it('declared body far above the limit -> 413 before parsing it', async () => {
    const res = await POST(new Request('http://x', { method: 'POST', headers: { 'content-length': String(50 * 1024 * 1024) }, body: 'x' }))
    expect(res.status).toBe(413)
  })

  it('propagates service refusals (duplicate -> 409 with the reference)', async () => {
    uploadVoucher.mockResolvedValue({ ok: false, status: 409, error: 'duplicate', extra: { duplicate_of: DOC } })
    const res = await post({ file: pdf(), request_key: 'k' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'duplicate', duplicate_of: DOC })
  })
})

describe('GET /api/orders/logistics/documents', () => {
  it('passes filters through; the account is the session one', async () => {
    await GET(new Request(`http://x/api/orders/logistics/documents?order_id=${ORDER}&association=pending&limit=10&account_id=${OTHER}`))
    expect(listDocuments.mock.calls[0][0].accountId).toBe(ACCOUNT)
    expect(listDocuments.mock.calls[0][1]).toMatchObject({ orderId: ORDER, association: 'pending', limit: 10 })
    expect(JSON.stringify(listDocuments.mock.calls[0])).not.toContain(OTHER)
  })
})

describe('GET /api/orders/logistics/documents/[id]/url', () => {
  it('is never cacheable and returns no storage path', async () => {
    const res = await URL_GET(new Request('http://x'), { params: Promise.resolve({ id: DOC }) })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toMatchObject({ url: 'https://signed.example/x', expires_in: 120 })
  })

  it('maps a service refusal (404 for other-account / hidden documents)', async () => {
    documentSignedUrl.mockResolvedValue({ ok: false, status: 404, error: 'not_found' })
    const res = await URL_GET(new Request('http://x'), { params: Promise.resolve({ id: DOC }) })
    expect(res.status).toBe(404)
  })
})
