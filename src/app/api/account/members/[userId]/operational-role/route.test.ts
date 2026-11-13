import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.fn()
const requireRole = vi.fn()
vi.mock('@/lib/auth/account', () => ({
  requireRole: (...a: unknown[]) => requireRole(...a),
  toErrorResponse: (e: Error) => new Response(JSON.stringify({ error: e.message }), { status: e.message === 'forbidden' ? 403 : 500 }),
}))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => ({ success: true }), rateLimitResponse: () => new Response('{}', { status: 429 }), RATE_LIMITS: { adminAction: {} } }))

import { PATCH } from './route'

const TARGET = '22222222-2222-4222-8222-222222222222'
const call = (body: unknown, userId = TARGET) =>
  PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ userId }) })

beforeEach(() => {
  rpc.mockReset()
  requireRole.mockReset()
  requireRole.mockResolvedValue({ supabase: { rpc }, accountId: 'acc', userId: 'me' })
})

describe('PATCH /api/account/members/[userId]/operational-role', () => {
  it('requires admin and never reaches the RPC for agents/viewers', async () => {
    requireRole.mockRejectedValue(new Error('forbidden'))
    expect((await call({ operational_role: 'logistics' })).status).toBe(403)
    expect(requireRole).toHaveBeenCalledWith('admin')
    expect(rpc).not.toHaveBeenCalled()
  })

  it.each(['commercial', 'logistics', 'supervisor', null])('forwards %j to set_member_operational_role and nothing else', async (value) => {
    rpc.mockResolvedValue({ error: null })
    const res = await call({ operational_role: value })
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('set_member_operational_role', { p_user_id: TARGET, p_operational_role: value })
  })

  it('rejects invalid values, missing key, and ignores account_id/role sent by the browser', async () => {
    expect((await call({ operational_role: 'owner' })).status).toBe(400)
    expect((await call({})).status).toBe(400)
    expect((await call({ operational_role: 'admin' })).status).toBe(400)
    expect((await call({ operational_role: 'logistics' }, 'not-a-uuid')).status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
    rpc.mockResolvedValue({ error: null })
    await call({ operational_role: 'logistics', role: 'owner', account_id: 'other' })
    expect(rpc.mock.calls[0][1]).toEqual({ p_user_id: TARGET, p_operational_role: 'logistics' })
  })

  it('maps flag-off / cross-account (42501) to 403 and bad input (22023) to 400', async () => {
    rpc.mockResolvedValue({ error: { code: '42501', message: 'operational_roles_disabled' } })
    expect((await call({ operational_role: 'logistics' })).status).toBe(403)
    rpc.mockResolvedValue({ error: { code: '22023', message: 'Target user not found' } })
    expect((await call({ operational_role: 'logistics' })).status).toBe(400)
  })
})
