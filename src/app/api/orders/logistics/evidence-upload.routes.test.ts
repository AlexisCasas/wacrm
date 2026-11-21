import { beforeEach, describe, expect, it, vi } from 'vitest'

const getCurrentAccount = vi.fn()
const resolveAccess = vi.fn()
const uploadEvidence = vi.fn()

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: () => getCurrentAccount(),
  toErrorResponse: (e: Error) => new Response(JSON.stringify({ error: e.message }), { status: e.message === 'Unauthorized' ? 401 : 500 }),
}))
vi.mock('@/lib/orders/confirmed-orders', () => ({ resolveConfirmedOrdersAccess: (c: unknown) => resolveAccess(c) }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ admin: true }) }))
vi.mock('@/lib/orders/logistics/evidence', () => ({ uploadEvidence: (...a: unknown[]) => uploadEvidence(...a) }))

import { POST } from './orders/[orderId]/evidence/upload/route'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const OTHER = '55555555-5555-4555-8555-555555555555'
const ORDER = '22222222-2222-4222-8222-222222222222'
const ctx = (role = 'agent', userId = 'user-1') => ({ supabase: {}, userId, accountId: ACCOUNT, role })
const params = { params: Promise.resolve({ orderId: ORDER }) }
const form = (extra: Record<string, string> = {}, withFile = true) => {
  const fd = new FormData()
  if (withFile) fd.append('file', new File([new Uint8Array([0xff, 0xd8, 0xff])], 'embalaje.jpg', { type: 'image/jpeg' }))
  fd.append('request_key', 'k-1')
  for (const [k, v] of Object.entries(extra)) fd.append(k, v)
  return fd
}
const call = (fd: FormData = form(), headers: Record<string, string> = {}) => POST(new Request('http://x', { method: 'POST', body: fd, headers }), params)

let user = 0
beforeEach(() => {
  uploadEvidence.mockReset()
  getCurrentAccount.mockResolvedValue(ctx('agent', `user-${(user += 1)}`))
  resolveAccess.mockResolvedValue({ kind: 'ok', operationalRole: 'logistics' })
  uploadEvidence.mockResolvedValue({ ok: true, status: 201, body: { created: true, evidence: {} } })
})

describe('POST /api/orders/logistics/orders/[orderId]/evidence/upload', () => {
  it('no session -> 401; flag OFF -> 403 feature_disabled; commercial / no area -> 403; viewer -> 403; the service is never reached', async () => {
    getCurrentAccount.mockRejectedValueOnce(new Error('Unauthorized'))
    expect((await call()).status).toBe(401)
    resolveAccess.mockResolvedValueOnce({ kind: 'disabled' })
    const off = await call()
    expect(off.status).toBe(403)
    expect(await off.json()).toEqual({ error: 'feature_disabled' })
    resolveAccess.mockResolvedValueOnce({ kind: 'forbidden' })
    const commercial = await call()
    expect(commercial.status).toBe(403)
    expect(await commercial.json()).toEqual({ error: 'operational_role_required' })
    getCurrentAccount.mockResolvedValueOnce(ctx('viewer', 'viewer-1'))
    expect((await call()).status).toBe(403)
    expect(uploadEvidence).not.toHaveBeenCalled()
  })

  it('the account / actor come from the session; only the file and request_key are read from the form', async () => {
    const res = await call(form({ account_id: OTHER, order_id: OTHER, actor: OTHER, user_id: OTHER }))
    expect(res.status).toBe(201)
    const [callCtx, , orderId, input] = uploadEvidence.mock.calls[0]
    expect(callCtx).toMatchObject({ accountId: ACCOUNT })
    expect(orderId).toBe(ORDER)
    expect(input).toMatchObject({ fileName: 'embalaje.jpg', requestKey: 'k-1' })
    expect(JSON.stringify(uploadEvidence.mock.calls[0].slice(0, 3))).not.toContain(OTHER)
  })

  it('a missing file is a 400; a body that is not a form is a 400; an oversized declared length is a 413 before reading anything', async () => {
    const noFile = await call(form({}, false))
    expect(noFile.status).toBe(400)
    expect(await noFile.json()).toEqual({ error: 'file_required' })
    expect((await POST(new Request('http://x', { method: 'POST', body: 'nope', headers: { 'content-type': 'text/plain' } }), params)).status).toBe(400)
    const big = await call(form(), { 'content-length': String(50 * 1024 * 1024) })
    expect(big.status).toBe(413)
    expect(uploadEvidence).not.toHaveBeenCalled()
  })

  it('the service verdicts are passed through (cross-account 404, validation 415, state 409) with no store of the answer', async () => {
    uploadEvidence.mockResolvedValueOnce({ ok: false, status: 404, error: 'not_found' })
    expect((await call()).status).toBe(404)
    uploadEvidence.mockResolvedValueOnce({ ok: false, status: 415, error: 'unsupported_extension' })
    const r = await call()
    expect(r.status).toBe(415)
    expect(await r.json()).toEqual({ error: 'unsupported_extension' })
    uploadEvidence.mockResolvedValueOnce({ ok: false, status: 409, error: 'not_packing' })
    expect((await call()).status).toBe(409)
    const ok = await call()
    expect(ok.headers.get('Cache-Control')).toBe('no-store')
  })
})
