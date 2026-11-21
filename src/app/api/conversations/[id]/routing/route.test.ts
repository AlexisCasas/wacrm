import { beforeEach, describe, expect, it, vi } from 'vitest'

const readRoutingState = vi.fn()
const getCurrentAccount = vi.fn()
vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: () => getCurrentAccount(),
  toErrorResponse: (e: Error) => new Response(JSON.stringify({ error: e.message }), { status: e.message === 'Unauthorized' ? 401 : 500 }),
}))
vi.mock('@/lib/conversations/routing', () => ({ readRoutingState: (...a: unknown[]) => readRoutingState(...a) }))

import { GET } from './route'

const ID = '33333333-3333-4333-8333-333333333333'
const get = (id = ID) => GET(new Request('http://x?account_id=other'), { params: Promise.resolve({ id }) })

beforeEach(() => {
  readRoutingState.mockReset()
  getCurrentAccount.mockReset()
  getCurrentAccount.mockResolvedValue({ userId: 'user-1', accountId: 'acc-1' })
})

describe('GET /api/conversations/[id]/routing', () => {
  it('requires a session', async () => {
    getCurrentAccount.mockRejectedValue(new Error('Unauthorized'))
    expect((await get()).status).toBe(401)
    expect(readRoutingState).not.toHaveBeenCalled()
  })

  it('validates the id', async () => {
    expect((await get('nope')).status).toBe(400)
  })

  it('reads with the SESSION context only (an account_id in the query is never used) and returns the state', async () => {
    readRoutingState.mockResolvedValue({ enabled: true, stage: 'shared', can_derive: false, derived: null })
    const res = await get()
    expect(res.status).toBe(200)
    expect(readRoutingState).toHaveBeenCalledWith({ userId: 'user-1', accountId: 'acc-1' }, ID)
    expect(await res.json()).toMatchObject({ stage: 'shared' })
  })

  it('a conversation the caller cannot work (RLS) is a 404', async () => {
    readRoutingState.mockResolvedValue(null)
    expect((await get()).status).toBe(404)
  })

  it('feature OFF answers enabled:false (200) so the UI shows nothing', async () => {
    readRoutingState.mockResolvedValue({ enabled: false, stage: null, can_derive: false, derived: null })
    expect(await (await get()).json()).toEqual({ enabled: false, stage: null, can_derive: false, derived: null })
  })
})
