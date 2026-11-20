import { beforeEach, describe, expect, it, vi } from 'vitest'

const getCurrentAccount = vi.fn()
const resolveAccess = vi.fn()
const rpc = vi.fn()
const svc = {
  getPaymentsPanel: vi.fn(), registerPayment: vi.fn(), confirmPayment: vi.fn(), rejectPayment: vi.fn(), voidPayment: vi.fn(), correctPayment: vi.fn(), markDeliveredManual: vi.fn(),
  getPaymentsSummary: vi.fn(), listOrdersWithBalance: vi.fn(), getConversationFinancials: vi.fn(),
}
const evidence = { uploadPaymentProof: vi.fn(), paymentDocumentSignedUrl: vi.fn() }

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: () => getCurrentAccount(),
  toErrorResponse: (e: Error) => new Response(JSON.stringify({ error: e.message }), { status: e.message === 'Unauthorized' ? 401 : 500 }),
}))
vi.mock('@/lib/orders/confirmed-orders', () => ({ resolveConfirmedOrdersAccess: (c: unknown) => resolveAccess(c) }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ admin: true }) }))
vi.mock('@/lib/orders/payments/service', () => ({
  getPaymentsPanel: (...a: unknown[]) => svc.getPaymentsPanel(...a), registerPayment: (...a: unknown[]) => svc.registerPayment(...a), confirmPayment: (...a: unknown[]) => svc.confirmPayment(...a),
  rejectPayment: (...a: unknown[]) => svc.rejectPayment(...a), voidPayment: (...a: unknown[]) => svc.voidPayment(...a), correctPayment: (...a: unknown[]) => svc.correctPayment(...a),
  markDeliveredManual: (...a: unknown[]) => svc.markDeliveredManual(...a), getPaymentsSummary: (...a: unknown[]) => svc.getPaymentsSummary(...a),
  listOrdersWithBalance: (...a: unknown[]) => svc.listOrdersWithBalance(...a), getConversationFinancials: (...a: unknown[]) => svc.getConversationFinancials(...a), MAX_SUMMARY_IDS: 50,
}))
vi.mock('@/lib/orders/payments/evidence', () => ({ uploadPaymentProof: (...a: unknown[]) => evidence.uploadPaymentProof(...a), paymentDocumentSignedUrl: (...a: unknown[]) => evidence.paymentDocumentSignedUrl(...a) }))

import { GET as CONVERSATION } from './conversation/route'
import { GET as DOC_URL } from './documents/[id]/url/route'
import { POST as UPLOAD } from './orders/[orderId]/evidence/route'
import { GET as PANEL, POST as ACTION } from './orders/[orderId]/route'
import { GET as SUMMARY } from './summary/route'
import { GET as WITH_BALANCE } from './with-balance/route'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const ORDER = '22222222-2222-4222-8222-222222222222'
const PAYMENT = '33333333-3333-4333-8333-333333333333'
let user = 0
const ctx = (role = 'agent') => ({ supabase: { rpc }, userId: `user-${(user += 1)}`, accountId: ACCOUNT, role })
const params = { params: Promise.resolve({ orderId: ORDER }) }
const post = (body: unknown) => new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const ok = (body: unknown = {}) => ({ ok: true, status: 200, body })

beforeEach(() => {
  for (const f of [...Object.values(svc), ...Object.values(evidence)]) f.mockReset().mockResolvedValue(ok())
  getCurrentAccount.mockResolvedValue(ctx())
  resolveAccess.mockResolvedValue({ kind: 'ok', operationalRole: 'logistics' })
  rpc.mockReset().mockResolvedValue({ data: true, error: null })
})

const operatorEndpoints: Array<[string, () => Promise<Response>]> = [
  ['panel', () => PANEL(new Request('http://x'), params)],
  ['action', () => ACTION(post({ action: 'confirm', payment_id: PAYMENT }), params)],
  ['summary', () => SUMMARY(new Request(`http://x/?ids=${ORDER}`))],
  ['with-balance', () => WITH_BALANCE()],
  ['upload', () => UPLOAD(new Request('http://x', { method: 'POST', body: new FormData() }), params)],
]

describe.each(operatorEndpoints)('%s endpoint authority', (_name, call) => {
  it('no session -> 401; logistics flag OFF -> 403; Commercial / no area -> 403; viewer -> 403; order_payments_enabled OFF (database) -> 403; nothing reaches a service', async () => {
    getCurrentAccount.mockRejectedValueOnce(new Error('Unauthorized'))
    expect((await call()).status).toBe(401)
    resolveAccess.mockResolvedValueOnce({ kind: 'disabled' })
    expect(await (await call()).json()).toEqual({ error: 'feature_disabled' })
    resolveAccess.mockResolvedValueOnce({ kind: 'forbidden' })
    expect((await call()).status).toBe(403)
    getCurrentAccount.mockResolvedValueOnce(ctx('viewer'))
    expect((await call()).status).toBe(403)
    rpc.mockResolvedValueOnce({ data: false, error: null })
    expect((await call()).status).toBe(403)
    expect(Object.values(svc).every((f) => f.mock.calls.length === 0)).toBe(true)
    expect(evidence.uploadPaymentProof).not.toHaveBeenCalled()
  })
  it('the database access check is asked with the SESSION account', async () => {
    await call()
    expect(rpc).toHaveBeenCalledWith('order_payments_access', { p_account_id: ACCOUNT })
  })
})

describe('actions', () => {
  it('register / confirm / reject: the account and actor come from the session; the body only carries the payment data; verdicts pass through', async () => {
    const c = ctx()
    getCurrentAccount.mockResolvedValue(c)
    svc.registerPayment.mockResolvedValueOnce({ ok: true, status: 201, body: { payment_id: PAYMENT } })
    const r = await ACTION(post({ action: 'register', request_key: 'k1', amount: '30.00', kind: 'advance', paid_at: '2027-01-01T00:00:00Z', account_id: 'evil', user_id: 'evil', balance: 0 }), params)
    expect(r.status).toBe(201)
    expect(svc.registerPayment).toHaveBeenCalledWith({ userId: c.userId, accountId: ACCOUNT }, { admin: true }, ORDER, expect.objectContaining({ requestKey: 'k1', amount: '30.00' }))
    expect(JSON.stringify(svc.registerPayment.mock.calls[0])).not.toContain('evil')
    svc.confirmPayment.mockResolvedValueOnce({ ok: false, status: 409, error: 'exceeds_balance', extra: { pending_balance: 20 } })
    const x = await ACTION(post({ action: 'confirm', payment_id: PAYMENT }), params)
    expect(x.status).toBe(409)
    expect(await x.json()).toEqual({ error: 'exceeds_balance', pending_balance: 20 })
    await ACTION(post({ action: 'reject', payment_id: PAYMENT, reason: 'ilegible' }), params)
    expect(svc.rejectPayment).toHaveBeenCalled()
    await ACTION(post({ action: 'mark_delivered', note: 'Olva' }), params)
    expect(svc.markDeliveredManual).toHaveBeenCalledWith(expect.anything(), { admin: true }, ORDER, 'Olva')
  })

  it('void and correct are SUPERVISOR only: a logistics operator gets 403 and the service is never called', async () => {
    for (const action of ['void', 'correct']) {
      const r = await ACTION(post({ action, payment_id: PAYMENT, reason: 'x' }), params)
      expect(r.status).toBe(403)
      expect(await r.json()).toEqual({ error: 'supervisor_required' })
    }
    expect(svc.voidPayment).not.toHaveBeenCalled()
    expect(svc.correctPayment).not.toHaveBeenCalled()
    resolveAccess.mockResolvedValue({ kind: 'ok', operationalRole: 'supervisor' })
    expect((await ACTION(post({ action: 'void', payment_id: PAYMENT, reason: 'x' }), params)).status).toBe(200)
    expect((await ACTION(post({ action: 'correct', payment_id: PAYMENT, reason: 'x', request_key: 'fix1', amount: '40.00', kind: 'advance', paid_at: '2027-01-01T00:00:00Z' }), params)).status).toBe(200)
    expect(svc.voidPayment).toHaveBeenCalled()
    expect(svc.correctPayment).toHaveBeenCalled()
  })

  it('invalid body / action are 400; GET panel is wired to the session and never cached', async () => {
    expect((await ACTION(new Request('http://x', { method: 'POST', body: 'not json' }), params)).status).toBe(400)
    expect((await ACTION(post({ action: 'refund' }), params)).status).toBe(400)
    svc.getPaymentsPanel.mockResolvedValueOnce(ok({ tracked: true }))
    const r = await PANEL(new Request('http://x'), params)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(svc.getPaymentsPanel).toHaveBeenCalledWith(expect.objectContaining({ accountId: ACCOUNT }), { admin: true }, ORDER, false)
  })

  it('summary takes 1..50 ids only', async () => {
    expect((await SUMMARY(new Request('http://x/?ids='))).status).toBe(400)
    expect((await SUMMARY(new Request(`http://x/?ids=${Array.from({ length: 51 }, () => ORDER).join(',')}`))).status).toBe(400)
    expect((await SUMMARY(new Request(`http://x/?ids=${ORDER}`))).status).toBe(200)
  })
})

describe('Comercial read-only endpoint and signed URLs', () => {
  it('the conversation view needs only a session (the database decides: Comercial included); it never exposes payments, and a refusal is a plain 404', async () => {
    getCurrentAccount.mockResolvedValue(ctx())
    svc.getConversationFinancials.mockResolvedValueOnce(ok({ orders: [] }))
    expect((await CONVERSATION(new Request(`http://x/?conversation_id=${ORDER}`))).status).toBe(200)
    expect(svc.getConversationFinancials).toHaveBeenCalledWith(expect.objectContaining({ accountId: ACCOUNT }), ORDER)
    svc.getConversationFinancials.mockResolvedValueOnce({ ok: false, status: 404, error: 'not_found' })
    expect((await CONVERSATION(new Request(`http://x/?conversation_id=${ORDER}`))).status).toBe(404)
    getCurrentAccount.mockRejectedValueOnce(new Error('Unauthorized'))
    expect((await CONVERSATION(new Request(`http://x/?conversation_id=${ORDER}`))).status).toBe(401)
  })

  it('the signed URL is minted by the service for the SESSION account only; its refusals pass through; never cached', async () => {
    evidence.paymentDocumentSignedUrl.mockResolvedValueOnce(ok({ url: 'https://signed', expires_in: 120, mime_type: 'application/pdf', filename: 'a.pdf' }))
    const r = await DOC_URL(new Request('http://x'), { params: Promise.resolve({ id: PAYMENT }) })
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(evidence.paymentDocumentSignedUrl).toHaveBeenCalledWith({ supabase: { rpc }, accountId: ACCOUNT }, { admin: true }, PAYMENT)
    evidence.paymentDocumentSignedUrl.mockResolvedValueOnce({ ok: false, status: 404, error: 'not_found' })
    expect((await DOC_URL(new Request('http://x'), { params: Promise.resolve({ id: PAYMENT }) })).status).toBe(404)
  })
})
