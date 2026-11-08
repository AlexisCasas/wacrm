import { beforeEach, describe, expect, it, vi } from 'vitest'

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TAG = '11111111-1111-4111-8111-111111111111'
const requireRole = vi.fn()
const updated = vi.fn()
const byId = vi.fn()
const byAccount = vi.fn()

vi.mock('@/lib/auth/account', () => ({
  requireRole: (...args: unknown[]) => requireRole(...args),
  toErrorResponse: () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }),
}))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      update: (...args: unknown[]) => {
        updated(...args)
        return {
          eq: (...idArgs: unknown[]) => {
            byId(...idArgs)
            return { eq: (...accountArgs: unknown[]) => {
              byAccount(...accountArgs)
              return { select: () => ({ maybeSingle: async () => ({ data: { id: TAG, name: 'Cargador Xiaomi', is_order_product: true }, error: null }) }) }
            } }
          },
        }
      },
    }),
  }),
}))

import { PATCH } from './route'

const req = (body: unknown) => new Request('http://x/api/tags/' + TAG + '/product', {
  method: 'PATCH',
  body: JSON.stringify(body),
})
const params = { params: Promise.resolve({ id: TAG }) }

beforeEach(() => {
  requireRole.mockReset()
  updated.mockReset()
  byId.mockReset()
  byAccount.mockReset()
  requireRole.mockResolvedValue({ accountId: ACCOUNT })
})

describe('PATCH /api/tags/[id]/product', () => {
  it('requires admin role; agents cannot classify tags', async () => {
    requireRole.mockRejectedValue(new Error('forbidden'))
    expect((await PATCH(req({ is_order_product: true }), params)).status).toBe(403)
    expect(requireRole).toHaveBeenCalledWith('admin')
    expect(updated).not.toHaveBeenCalled()
  })
  it('requires a strict boolean', async () => {
    expect((await PATCH(req({ is_order_product: 'true' }), params)).status).toBe(400)
    expect(updated).not.toHaveBeenCalled()
  })
  it('updates only the selected tag in session account', async () => {
    const res = await PATCH(req({ is_order_product: true }), params)
    expect(res.status).toBe(200)
    expect(updated).toHaveBeenCalledWith({ is_order_product: true })
    expect(byId).toHaveBeenCalledWith('id', TAG)
    expect(byAccount).toHaveBeenCalledWith('account_id', ACCOUNT)
    expect((await res.json()).tag.name).toBe('Cargador Xiaomi')
  })
})
