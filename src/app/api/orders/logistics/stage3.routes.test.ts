import { beforeEach, describe, expect, it, vi } from 'vitest'

const getCurrentAccount = vi.fn()
const resolveAccess = vi.fn()
const runDocumentOcr = vi.fn()
const reviewDocument = vi.fn()
const getDocumentDetail = vi.fn()
const getOrderPanel = vi.fn()

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: () => getCurrentAccount(),
  toErrorResponse: (e: Error) => new Response(JSON.stringify({ error: e.message }), { status: e.message === 'Unauthorized' ? 401 : 500 }),
}))
vi.mock('@/lib/orders/confirmed-orders', () => ({ resolveConfirmedOrdersAccess: (c: unknown) => resolveAccess(c) }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ admin: true }) }))
vi.mock('@/lib/orders/logistics/ocr/run', () => ({ runDocumentOcr: (...a: unknown[]) => runDocumentOcr(...a) }))
vi.mock('@/lib/orders/logistics/review', () => ({
  reviewDocument: (...a: unknown[]) => reviewDocument(...a),
  getDocumentDetail: (...a: unknown[]) => getDocumentDetail(...a),
}))
vi.mock('@/lib/orders/logistics/panel', () => ({ getOrderPanel: (...a: unknown[]) => getOrderPanel(...a) }))

import { GET as DETAIL } from './documents/[id]/route'
import { POST as OCR } from './documents/[id]/ocr/route'
import { POST as REVIEW } from './documents/[id]/review/route'
import { GET as PANEL } from './orders/[orderId]/route'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const OTHER = '55555555-5555-4555-8555-555555555555'
const DOC = '33333333-3333-4333-8333-333333333333'
const ORDER = '22222222-2222-4222-8222-222222222222'
const ctx = (role = 'agent') => ({ supabase: {}, userId: 'user-1', accountId: ACCOUNT, role })
const idParams = { params: Promise.resolve({ id: DOC }) }
const json = (body: unknown) => new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const handlers: Array<[string, () => Promise<Response>]> = [
  ['detail', () => DETAIL(new Request('http://x'), idParams)],
  ['ocr', () => OCR(new Request('http://x', { method: 'POST' }), idParams)],
  ['review', () => REVIEW(json({ action: 'validate' }), idParams)],
  ['panel', () => PANEL(new Request('http://x'), { params: Promise.resolve({ orderId: ORDER }) })],
]

beforeEach(() => {
  getCurrentAccount.mockResolvedValue(ctx())
  resolveAccess.mockResolvedValue({ kind: 'ok', operationalRole: 'logistics' })
  runDocumentOcr.mockResolvedValue({ ok: true, status: 200, body: { attempt: 1, ocr_status: 'done', error_code: null } })
  reviewDocument.mockResolvedValue({ ok: true, status: 200, body: { changed: true, status: 'validated', version: 1, document: {} } })
  getDocumentDetail.mockResolvedValue({ ok: true, status: 200, body: { document: {}, ocr: null, reviewed_data: null, comparison: [] } })
  getOrderPanel.mockResolvedValue({ ok: true, status: 200, body: { order: {}, logistics: { status: 'pending_voucher', version: 0 }, vouchers: [], events: [] } })
})

describe.each(handlers)('%s endpoint authority', (_name, call) => {
  it('no session -> 401 and no service is reached', async () => {
    getCurrentAccount.mockRejectedValue(new Error('Unauthorized'))
    expect((await call()).status).toBe(401)
    for (const s of [runDocumentOcr, reviewDocument, getDocumentDetail, getOrderPanel]) expect(s).not.toHaveBeenCalled()
  })

  it('flag OFF -> 403 feature_disabled (zero PR-04 behaviour on a legacy account)', async () => {
    resolveAccess.mockResolvedValue({ kind: 'disabled' })
    const res = await call()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'feature_disabled' })
    for (const s of [runDocumentOcr, reviewDocument, getDocumentDetail, getOrderPanel]) expect(s).not.toHaveBeenCalled()
  })

  it('commercial / no area -> 403 even when the chat is shared; a viewer -> 403', async () => {
    resolveAccess.mockResolvedValue({ kind: 'forbidden' })
    expect((await call()).status).toBe(403)
    resolveAccess.mockResolvedValue({ kind: 'ok', operationalRole: 'logistics' })
    getCurrentAccount.mockResolvedValue(ctx('viewer'))
    expect((await call()).status).toBe(403)
    for (const s of [runDocumentOcr, reviewDocument, getDocumentDetail, getOrderPanel]) expect(s).not.toHaveBeenCalled()
  })
})

describe('service wiring', () => {
  it('review: account and actor come from the session; an account_id / actor in the body is never used', async () => {
    await REVIEW(json({ action: 'correct', expected_row_version: 2, reviewed_data: { dni: '1' }, account_id: OTHER, actor: OTHER, user_id: OTHER }), idParams)
    const [callCtx, , id, input] = reviewDocument.mock.calls[0]
    expect(callCtx.accountId).toBe(ACCOUNT)
    expect(callCtx.userId).toBe('user-1')
    expect(id).toBe(DOC)
    expect(input).toEqual({ action: 'correct', expectedRowVersion: 2, reviewedData: { dni: '1' } })
    expect(JSON.stringify(reviewDocument.mock.calls[0])).not.toContain(OTHER)
  })

  it('review: a non-object body is a 400', async () => {
    expect((await REVIEW(new Request('http://x', { method: 'POST', body: 'nope' }), idParams)).status).toBe(400)
    expect((await REVIEW(json([1]), idParams)).status).toBe(400)
    expect(reviewDocument).not.toHaveBeenCalled()
  })

  it('ocr: runs ONE attempt with the resolved provider (not_configured by default: no real provider exists)', async () => {
    await OCR(new Request('http://x', { method: 'POST' }), idParams)
    const [callCtx, , provider, id] = runDocumentOcr.mock.calls[0]
    expect(callCtx.accountId).toBe(ACCOUNT)
    expect(id).toBe(DOC)
    expect(provider.name).toBe('not_configured')
  })

  it('service refusals keep their HTTP status and error code', async () => {
    reviewDocument.mockResolvedValue({ ok: false, status: 409, error: 'stale', extra: { row_version: 4 } })
    const res = await REVIEW(json({ action: 'validate' }), idParams)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'stale', row_version: 4 })
  })

  it('every success answer is non-cacheable', async () => {
    for (const [, call] of handlers) expect((await call()).headers.get('cache-control')).toBe('no-store')
  })
})
