import { beforeEach, describe, expect, it, vi } from 'vitest'

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OWNER = '11111111-1111-4111-8111-111111111111'
const NEWBIE = '22222222-2222-4222-8222-222222222222'

const rpc = vi.fn()
const maybeSingle = vi.fn()
const eqAccount = vi.fn()
const requireRole = vi.fn()
vi.mock('@/lib/auth/account', () => ({
  requireRole: (...a: unknown[]) => requireRole(...a),
  toErrorResponse: (e: Error) => new Response(JSON.stringify({ error: e.message }), { status: e.message === 'forbidden' ? 403 : 500 }),
}))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc,
    from: () => ({ select: () => ({ eq: (...a: unknown[]) => { eqAccount(...a); return { maybeSingle } } }) }),
  }),
}))

import { GET } from './route'

beforeEach(() => {
  rpc.mockReset(); maybeSingle.mockReset(); eqAccount.mockReset(); requireRole.mockReset()
  requireRole.mockResolvedValue({ accountId: ACCOUNT, userId: OWNER })
})

describe('GET /api/orders/sellers', () => {
  it('needs the agent role (a viewer cannot even list)', async () => {
    requireRole.mockRejectedValue(new Error('forbidden'))
    expect((await GET()).status).toBe(403)
    expect(requireRole).toHaveBeenCalledWith('agent')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('feature OFF (no settings row, or confirm_enabled false): enabled=false and no roster is read or returned', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null })
    expect(await (await GET()).json()).toEqual({ enabled: false, sellers: [] })
    maybeSingle.mockResolvedValue({ data: { confirm_enabled: false }, error: null })
    expect(await (await GET()).json()).toEqual({ enabled: false, sellers: [] })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('feature ON: returns the account members from the real profiles, by user id (owner and accepted members alike)', async () => {
    maybeSingle.mockResolvedValue({ data: { confirm_enabled: true }, error: null })
    rpc.mockResolvedValue({ data: [{ user_id: OWNER, name: 'Titular', account_role: 'owner' }, { user_id: NEWBIE, name: 'Miembro', account_role: 'agent' }], error: null })
    const body = await (await GET()).json()
    expect(body).toEqual({ enabled: true, sellers: [{ id: OWNER, name: 'Titular' }, { id: NEWBIE, name: 'Miembro' }] })
    expect(JSON.stringify(body)).not.toContain('account_role')
  })

  it('always asks for the SESSION account, never anything the client sends', async () => {
    maybeSingle.mockResolvedValue({ data: { confirm_enabled: true }, error: null })
    rpc.mockResolvedValue({ data: [], error: null })
    await GET()
    expect(eqAccount).toHaveBeenCalledWith('account_id', ACCOUNT)
    expect(rpc).toHaveBeenCalledWith('order_seller_candidates', { p_account: ACCOUNT })
  })

  it('database errors are 500s without details', async () => {
    maybeSingle.mockResolvedValue({ data: { confirm_enabled: true }, error: null })
    rpc.mockResolvedValue({ data: null, error: { message: 'boom with internals' } })
    const res = await GET()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('internals')
  })
})
