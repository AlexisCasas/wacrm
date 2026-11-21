import { beforeEach, describe, expect, it, vi } from 'vitest'

const getCurrentAccount = vi.fn()
const resolveAccess = vi.fn()
const getLogisticsSummary = vi.fn()

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: () => getCurrentAccount(),
  toErrorResponse: (e: Error) => new Response(JSON.stringify({ error: e.message }), { status: e.message === 'Unauthorized' ? 401 : 500 }),
}))
vi.mock('@/lib/orders/confirmed-orders', () => ({ resolveConfirmedOrdersAccess: (c: unknown) => resolveAccess(c) }))
vi.mock('@/lib/orders/logistics/panel', () => ({ getLogisticsSummary: (...a: unknown[]) => getLogisticsSummary(...a), MAX_SUMMARY_IDS: 50 }))

import { GET } from './route'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const OTHER = '55555555-5555-4555-8555-555555555555'
const A = '22222222-2222-4222-8222-222222222222'
const B = '33333333-3333-4333-8333-333333333333'
const ctx = (role = 'agent') => ({ supabase: {}, userId: 'user-1', accountId: ACCOUNT, role })
const get = (qs: string) => GET(new Request(`http://x/api/orders/logistics/summary${qs}`))

beforeEach(() => {
  getCurrentAccount.mockResolvedValue(ctx())
  resolveAccess.mockResolvedValue({ kind: 'ok', operationalRole: 'logistics' })
  getLogisticsSummary.mockResolvedValue({ ok: true, status: 200, body: { summary: {} } })
})

describe('GET /api/orders/logistics/summary', () => {
  it('no session -> 401; flag OFF -> 403; commercial / viewer -> 403; nothing is read', async () => {
    getCurrentAccount.mockRejectedValueOnce(new Error('Unauthorized'))
    expect((await get(`?ids=${A}`)).status).toBe(401)
    resolveAccess.mockResolvedValueOnce({ kind: 'disabled' })
    expect(await (await get(`?ids=${A}`)).json()).toEqual({ error: 'feature_disabled' })
    resolveAccess.mockResolvedValueOnce({ kind: 'forbidden' })
    expect((await get(`?ids=${A}`)).status).toBe(403)
    getCurrentAccount.mockResolvedValueOnce(ctx('viewer'))
    expect((await get(`?ids=${A}`)).status).toBe(403)
    expect(getLogisticsSummary).not.toHaveBeenCalled()
  })

  it('passes the ids and the SESSION account; an account_id in the query is ignored', async () => {
    await get(`?ids=${A},${B}&account_id=${OTHER}`)
    const [callCtx, ids] = getLogisticsSummary.mock.calls[0]
    expect(callCtx.accountId).toBe(ACCOUNT)
    expect(ids).toEqual([A, B])
    expect(JSON.stringify(getLogisticsSummary.mock.calls[0])).not.toContain(OTHER)
  })

  it('more than 50 ids is refused before any service call; the answer is not cacheable', async () => {
    const many = Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`).join(',')
    expect((await get(`?ids=${many}`)).status).toBe(400)
    expect(getLogisticsSummary).not.toHaveBeenCalled()
    expect((await get(`?ids=${A}`)).headers.get('cache-control')).toBe('no-store')
  })
})
