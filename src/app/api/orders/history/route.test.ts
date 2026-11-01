import { beforeEach, describe, expect, it, vi } from 'vitest'

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CONV = '33333333-3333-4333-8333-333333333333'
const CONTACT = '44444444-4444-4444-8444-444444444444'

const requireRole = vi.fn()
const settings = vi.fn()
const conversation = vi.fn()
const result = vi.fn()
const calls: Array<[string, ...unknown[]]> = []
const writes = vi.fn()

// A recording query builder: every method logs itself and returns the builder; awaiting it yields `result()`.
const builder = (table: string): Record<string, unknown> => {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'or', 'lt', 'order', 'limit']) b[m] = (...a: unknown[]) => { calls.push([`${table}.${m}`, ...a]); return b }
  b.maybeSingle = async () => (table === 'conversations' ? conversation() : { data: null })
  b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej)
  for (const m of ['insert', 'update', 'delete', 'upsert']) b[m] = (...a: unknown[]) => writes(m, ...a)
  return b
}
const supabase = { from: (t: string) => builder(t), rpc: (...a: unknown[]) => writes('rpc', ...a) }

vi.mock('@/lib/auth/account', () => ({
  requireRole: (...a: unknown[]) => requireRole(...a),
  toErrorResponse: (e: Error) => new Response(JSON.stringify({ error: e.message }), { status: e.message === 'forbidden' ? 403 : e.message === 'unauthorized' ? 401 : 500 }),
}))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: (...a: unknown[]) => writes('admin.rpc', ...a),
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: settings }) }) }),
  }),
}))

import { GET } from './route'

const get = (qs: string) => GET(new Request(`http://x/api/orders/history${qs}`))
const row = (i: number) => ({ id: `id-${i}`, confirmed_at: '2026-10-31T16:12:16Z', product: 'P', quantity: 1, price: 110, confirmed_by_name: 'A', seller_name: 'B', delivery_status: 'held', sent_at: null, acknowledged_at: null, attempts: 0 })

beforeEach(() => {
  calls.length = 0
  for (const f of [requireRole, settings, conversation, result, writes]) f.mockReset()
  requireRole.mockResolvedValue({ supabase, accountId: ACCOUNT, userId: 'u' })
  settings.mockResolvedValue({ data: { confirm_enabled: true }, error: null })
  conversation.mockResolvedValue({ data: { contact_id: CONTACT } })
  result.mockReturnValue({ data: [row(1), row(2)], error: null })
})

describe('GET /api/orders/history', () => {
  it('needs the agent role: 401 without a session, 403 for a viewer, and nothing is read', async () => {
    requireRole.mockRejectedValue(new Error('forbidden'))
    expect((await get(`?conversation_id=${CONV}`)).status).toBe(403)
    requireRole.mockRejectedValue(new Error('unauthorized'))
    expect((await get(`?conversation_id=${CONV}`)).status).toBe(401)
    expect(requireRole).toHaveBeenCalledWith('agent')
    expect(calls).toEqual([])
  })

  it('rejects a missing or malformed conversation id and a bad cursor', async () => {
    expect((await get('')).status).toBe(400)
    expect((await get('?conversation_id=nope')).status).toBe(400)
    expect((await get(`?conversation_id=${CONV}&before=garbage`)).status).toBe(400)
    expect(calls).toEqual([])
  })

  it('feature off for the account: enabled=false and no order is read', async () => {
    settings.mockResolvedValue({ data: { confirm_enabled: false }, error: null })
    expect(await (await get(`?conversation_id=${CONV}`)).json()).toEqual({ enabled: false, orders: [], has_more: false })
    settings.mockResolvedValue({ data: null, error: null })
    expect((await (await get(`?conversation_id=${CONV}`)).json()).enabled).toBe(false)
    expect(calls).toEqual([])
  })

  it('a conversation outside the caller account has no orders (no leak, no 403)', async () => {
    conversation.mockResolvedValue({ data: null })
    expect(await (await get(`?conversation_id=${CONV}`)).json()).toEqual({ enabled: true, orders: [], has_more: false })
    expect(calls.some(([c]) => c === 'order_confirmations.select')).toBe(false)
    // The conversation lookup itself is scoped to the session account.
    expect(calls).toContainEqual(['conversations.eq', 'account_id', ACCOUNT])
  })

  it('reads with the caller client, scoped to the session account, by conversation OR its contact, newest first', async () => {
    const body = await (await get(`?conversation_id=${CONV}`)).json()
    expect(body.orders).toHaveLength(2)
    expect(calls).toContainEqual(['order_confirmations.eq', 'account_id', ACCOUNT])
    expect(calls).toContainEqual(['order_confirmations.or', `conversation_id.eq.${CONV},contact_id.eq.${CONTACT}`])
    expect(calls).toContainEqual(['order_confirmations.order', 'confirmed_at', { ascending: false }])
    expect(calls).toContainEqual(['order_confirmations.limit', 51])
  })

  it('a conversation without a contact is found by conversation only', async () => {
    conversation.mockResolvedValue({ data: { contact_id: null } })
    await get(`?conversation_id=${CONV}`)
    expect(calls).toContainEqual(['order_confirmations.eq', 'conversation_id', CONV])
    expect(calls.some(([c]) => c === 'order_confirmations.or')).toBe(false)
  })

  it('selects only the allow-listed columns', async () => {
    await get(`?conversation_id=${CONV}`)
    const sel = calls.find(([c]) => c === 'order_confirmations.select')!
    for (const forbidden of ['dni', 'phone', 'customer_name', 'last_error_code']) expect(String(sel[1])).not.toContain(forbidden)
  })

  it('paginates: 51 rows come back as 50 plus has_more, and a cursor adds the "before" filter', async () => {
    result.mockReturnValue({ data: Array.from({ length: 51 }, (_, i) => row(i)), error: null })
    const body = await (await get(`?conversation_id=${CONV}&before=2026-10-31T00:00:00Z`)).json()
    expect(body.orders).toHaveLength(50)
    expect(body.has_more).toBe(true)
    expect(calls).toContainEqual(['order_confirmations.lt', 'confirmed_at', '2026-10-31T00:00:00Z'])
  })

  it('a database error is a generic 500 with no detail', async () => {
    result.mockReturnValue({ data: null, error: { code: 'XX000', message: 'secret detail' } })
    const res = await get(`?conversation_id=${CONV}`)
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret')
  })

  it('is strictly read-only: no insert/update/delete/upsert/rpc is ever issued', async () => {
    await get(`?conversation_id=${CONV}`)
    expect(writes).not.toHaveBeenCalled()
  })
})
