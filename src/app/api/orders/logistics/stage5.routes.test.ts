import { beforeEach, describe, expect, it, vi } from 'vitest'

const getCurrentAccount = vi.fn()
const resolveAccess = vi.fn()
const listChatMedia = vi.fn()
const selectEvidenceFromChat = vi.fn()

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: () => getCurrentAccount(),
  toErrorResponse: (e: Error) => new Response(JSON.stringify({ error: e.message }), { status: e.message === 'Unauthorized' ? 401 : 500 }),
}))
vi.mock('@/lib/orders/confirmed-orders', () => ({ resolveConfirmedOrdersAccess: (c: unknown) => resolveAccess(c) }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ admin: true }) }))
vi.mock('@/lib/orders/logistics/evidence', () => ({
  listChatMedia: (...a: unknown[]) => listChatMedia(...a),
  selectEvidenceFromChat: (...a: unknown[]) => selectEvidenceFromChat(...a),
}))

import { GET as CHAT_MEDIA } from './orders/[orderId]/chat-media/route'
import { POST as EVIDENCE } from './orders/[orderId]/evidence/route'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const OTHER = '55555555-5555-4555-8555-555555555555'
const ORDER = '22222222-2222-4222-8222-222222222222'
const MSG = '77777777-7777-4777-8777-777777777777'
const ctx = (role = 'agent') => ({ supabase: {}, userId: 'user-1', accountId: ACCOUNT, role })
const params = { params: Promise.resolve({ orderId: ORDER }) }
const json = (body: unknown) => new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const handlers: Array<[string, () => Promise<Response>]> = [
  ['chat-media', () => CHAT_MEDIA(new Request('http://x'), params)],
  ['evidence', () => EVIDENCE(json({ message_id: MSG, request_key: 'k' }), params)],
]

beforeEach(() => {
  getCurrentAccount.mockResolvedValue(ctx())
  resolveAccess.mockResolvedValue({ kind: 'ok', operationalRole: 'logistics' })
  listChatMedia.mockResolvedValue({ ok: true, status: 200, body: { media: [] } })
  selectEvidenceFromChat.mockResolvedValue({ ok: true, status: 201, body: { created: true, evidence: {} } })
})

describe.each(handlers)('%s endpoint authority', (_name, call) => {
  it('no session -> 401; flag OFF -> 403; commercial / no area / viewer -> 403 (a shared chat grants nothing)', async () => {
    getCurrentAccount.mockRejectedValueOnce(new Error('Unauthorized'))
    expect((await call()).status).toBe(401)
    resolveAccess.mockResolvedValueOnce({ kind: 'disabled' })
    const off = await call()
    expect(off.status).toBe(403)
    expect(await off.json()).toEqual({ error: 'feature_disabled' })
    resolveAccess.mockResolvedValueOnce({ kind: 'forbidden' })
    expect((await call()).status).toBe(403)
    getCurrentAccount.mockResolvedValueOnce(ctx('viewer'))
    expect((await call()).status).toBe(403)
    expect(listChatMedia).not.toHaveBeenCalled()
    expect(selectEvidenceFromChat).not.toHaveBeenCalled()
  })
})

describe('wiring', () => {
  it('evidence: the account / actor come from the session; only message_id and request_key are read from the body', async () => {
    await EVIDENCE(json({ message_id: MSG, request_key: 'k-1', account_id: OTHER, conversation_id: OTHER, order_id: OTHER, actor: OTHER }), params)
    const [callCtx, , orderId, input] = selectEvidenceFromChat.mock.calls[0]
    expect(callCtx).toMatchObject({ accountId: ACCOUNT, userId: 'user-1' })
    expect(orderId).toBe(ORDER)
    expect(input).toEqual({ messageId: MSG, requestKey: 'k-1' })
    expect(JSON.stringify(selectEvidenceFromChat.mock.calls[0])).not.toContain(OTHER)
  })

  it('evidence: a body that is not an object is a 400', async () => {
    expect((await EVIDENCE(new Request('http://x', { method: 'POST', body: 'nope' }), params)).status).toBe(400)
    expect(selectEvidenceFromChat).not.toHaveBeenCalled()
  })

  it('refusals keep their status and code; answers are never cacheable', async () => {
    selectEvidenceFromChat.mockResolvedValue({ ok: false, status: 409, error: 'not_packing' })
    const res = await EVIDENCE(json({ message_id: MSG, request_key: 'k' }), params)
    expect([res.status, await res.json()]).toEqual([409, { error: 'not_packing' }])
    expect((await CHAT_MEDIA(new Request('http://x'), params)).headers.get('cache-control')).toBe('no-store')
  })
})
