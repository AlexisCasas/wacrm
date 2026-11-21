import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.fn()
const getCurrentAccount = vi.fn()
const rate = vi.fn()
vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: () => getCurrentAccount(),
  toErrorResponse: (e: Error) => new Response(JSON.stringify({ error: e.message }), { status: e.message === 'Unauthorized' ? 401 : 500 }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...a: unknown[]) => rate(...a),
  rateLimitResponse: () => new Response('{}', { status: 429 }),
  RATE_LIMITS: { adminAction: {} },
}))

import { POST } from './route'

const ID = '33333333-3333-4333-8333-333333333333'
const post = (id = ID, body?: unknown) =>
  POST(new Request('http://x', { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }), { params: Promise.resolve({ id }) })

beforeEach(() => {
  rpc.mockReset()
  rate.mockReset()
  rate.mockReturnValue({ success: true })
  getCurrentAccount.mockReset()
  getCurrentAccount.mockResolvedValue({ supabase: { rpc }, userId: 'user-1', accountId: 'acc-1' })
})

describe('POST /api/conversations/[id]/derive-to-commercial', () => {
  it('no session -> 401 and the database is never called', async () => {
    getCurrentAccount.mockRejectedValue(new Error('Unauthorized'))
    expect((await post()).status).toBe(401)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('validates the id before calling the database', async () => {
    expect((await post('not-a-uuid')).status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('calls the RPC with ONLY the conversation id: no account, actor or stage from the browser', async () => {
    rpc.mockResolvedValue({ data: [{ stage: 'shared', changed: true }], error: null })
    const res = await post(ID, { account_id: 'other', actor: 'someone', stage: 'commercial', p_account_id: 'other' })
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('derive_conversation_to_commercial', { p_conversation_id: ID })
    expect(await res.json()).toEqual({ ok: true, stage: 'shared', changed: true })
  })

  it('already shared is a success that reports changed:false (idempotent double click)', async () => {
    rpc.mockResolvedValue({ data: [{ stage: 'shared', changed: false }], error: null })
    expect(await (await post()).json()).toEqual({ ok: true, stage: 'shared', changed: false })
  })

  it.each(['conversation_not_accessible', 'operational_roles_disabled', 'Only logistics or supervisor can derive a conversation to commercial'])(
    'a database refusal (%s) is a 403',
    async (message) => {
      rpc.mockResolvedValue({ data: null, error: { code: '42501', message } })
      const res = await post()
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: message })
    },
  )

  it('an invalid transition (commercial conversation) is a 409', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '22023', message: 'invalid_transition' } })
    const res = await post()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'invalid_transition' })
  })

  it('an unexpected failure is a generic 500 without internal details', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'internal detail' } })
    const res = await post()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('internal detail')
  })

  it('is rate limited per user', async () => {
    rate.mockReturnValue({ success: false })
    expect((await post()).status).toBe(429)
    expect(rate.mock.calls[0][0]).toBe('routing:derive:user-1')
    expect(rpc).not.toHaveBeenCalled()
  })
})
