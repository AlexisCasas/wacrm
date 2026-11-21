import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---- fake Supabase query builder: records every filter, resolves with the rows the test configured ----
interface Call {
  table: string
  select?: string
  eq: Array<[string, unknown]>
  or: string[]
  in: Array<[string, unknown[]]>
  order: Array<[string, boolean]>
  limit?: number
}
const calls: Call[] = []
const data: { orders: Record<string, unknown>[]; items: Record<string, unknown>[]; profileRole: string | null; flag: unknown; flagError: boolean } = {
  orders: [],
  items: [],
  profileRole: null,
  flag: true,
  flagError: false,
}

function builder(table: string) {
  const call: Call = { table, eq: [], or: [], in: [], order: [] }
  calls.push(call)
  const b: Record<string, unknown> = {
    select: (s: string) => ((call.select = s), b),
    eq: (c: string, v: unknown) => (call.eq.push([c, v]), b),
    or: (f: string) => (call.or.push(f), b),
    in: (c: string, v: unknown[]) => (call.in.push([c, v]), b),
    order: (c: string, o: { ascending: boolean }) => (call.order.push([c, o.ascending]), b),
    limit: (n: number) => ((call.limit = n), b),
    maybeSingle: async () => {
      if (table === 'profiles') return { data: data.profileRole === null ? { operational_role: null } : { operational_role: data.profileRole }, error: null }
      return { data: null, error: null }
    },
    then: (resolve: (v: unknown) => unknown) => {
      if (table === 'order_confirmations') return resolve({ data: data.orders.slice(0, call.limit), error: null })
      if (table === 'order_confirmation_items') return resolve({ data: data.items, error: null })
      return resolve({ data: [], error: null })
    },
  }
  return b
}

const ctx = { supabase: { from: (t: string) => builder(t) }, userId: 'user-1', accountId: 'acc-1' }
const getCurrentAccount = vi.fn()
vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: () => getCurrentAccount(),
  toErrorResponse: (e: Error) => new Response(JSON.stringify({ error: e.message }), { status: e.message === 'Unauthorized' ? 401 : 500 }),
}))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => (data.flagError ? { data: null, error: { message: 'boom' } } : { data: data.flag === null ? null : { logistics_mvp_enabled: data.flag }, error: null }),
        }),
      }),
    }),
  }),
}))

import { GET } from './route'
import { GET as ACCESS } from './access/route'

const get = (qs = '') => GET(new Request('http://x/api/orders/confirmed' + qs))
const ORDER_A = '11111111-1111-4111-8111-111111111111'
const ORDER_B = '22222222-2222-4222-8222-222222222222'
const row = (over: Record<string, unknown> = {}) => ({
  id: ORDER_A,
  confirmed_at: '2026-11-16T17:12:59.474993+00:00',
  customer_name: 'Cliente Uno',
  product: 'Producto A',
  quantity: 2,
  price: '120.00',
  seller_name: 'Angelo',
  seller_user_id: 'user-1',
  order_status: 'Pedido confirmado',
  delivery_status: 'held',
  agency: 'Shalom',
  destination: 'Lima',
  department: 'Lima',
  conversation_id: '33333333-3333-4333-8333-333333333333',
  // stored but must never leave the server:
  dni: '12345678',
  phone: '999888777',
  ...over,
})
const listCall = () => calls.find((c) => c.table === 'order_confirmations')!

beforeEach(() => {
  calls.length = 0
  data.orders = [row()]
  data.items = []
  data.profileRole = 'supervisor'
  data.flag = true
  data.flagError = false
  getCurrentAccount.mockReset()
  getCurrentAccount.mockResolvedValue(ctx)
})

describe('GET /api/orders/confirmed: access', () => {
  it('no session -> 401 and nothing is read', async () => {
    getCurrentAccount.mockRejectedValue(new Error('Unauthorized'))
    expect((await get()).status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('logistics_mvp_enabled=false (or no settings row) -> 403 feature_disabled and no order is read', async () => {
    for (const flag of [false, null]) {
      data.flag = flag
      calls.length = 0
      const res = await get()
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'feature_disabled' })
      expect(calls.some((c) => c.table === 'order_confirmations')).toBe(false)
    }
  })

  it('a failing flag lookup is a 500, never an open door', async () => {
    data.flagError = true
    expect((await get()).status).toBe(500)
    expect(calls.some((c) => c.table === 'order_confirmations')).toBe(false)
  })

  it('operational_role NULL -> 403 operational_role_required (account_role alone grants nothing, owner/admin included)', async () => {
    data.profileRole = null
    const res = await get()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'operational_role_required' })
    expect(calls.some((c) => c.table === 'order_confirmations')).toBe(false)
  })

  it('an unknown operational_role value is treated as no role', async () => {
    data.profileRole = 'owner'
    expect((await get()).status).toBe(403)
  })
})

describe('GET /api/orders/confirmed: who can see the logistics stage', () => {
  it.each(['supervisor', 'logistics'])('%s sees every confirmed order of the account (no seller filter)', async (role) => {
    data.profileRole = role
    const res = await get()
    expect(res.status).toBe(200)
    expect(listCall().eq).toContainEqual(['account_id', 'acc-1'])
    expect(listCall().eq.some(([c]) => c === 'seller_user_id')).toBe(false)
  })

  it('commercial has NO access (it hands the order over): 403 and no order is read', async () => {
    data.profileRole = 'commercial'
    const res = await get()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'operational_role_required' })
    expect(calls.some((c) => c.table === 'order_confirmations')).toBe(false)
    expect(calls.some((c) => c.table === 'order_confirmation_items')).toBe(false)
  })

  it('the account always comes from the session: an account_id / seller_user_id sent by the browser is ignored', async () => {
    data.profileRole = 'logistics'
    await get('?account_id=other-account&seller_user_id=someone-else&accountId=x')
    expect(listCall().eq).toContainEqual(['account_id', 'acc-1'])
    expect(JSON.stringify(calls)).not.toContain('other-account')
    expect(JSON.stringify(calls)).not.toContain('someone-else')
  })

  it('items are read for the same account and only for the page orders', async () => {
    await get()
    const items = calls.find((c) => c.table === 'order_confirmation_items')!
    expect(items.eq).toContainEqual(['account_id', 'acc-1'])
    expect(items.in).toEqual([['order_id', [ORDER_A]]])
  })
})

describe('GET /api/orders/confirmed: payload', () => {
  it('never selects nor returns DNI / phone, and drops internal columns', async () => {
    const res = await get()
    expect(listCall().select).not.toMatch(/\bdni\b|\bphone\b|order_description|request_key|last_error/)
    const text = await res.text()
    expect(text).not.toContain('12345678')
    expect(text).not.toContain('999888777')
    expect(text).not.toMatch(/"dni"|"phone"|seller_user_id/)
  })

  it('legacy order (no item rows): one line from the snapshot, unit price unknown, total = price', async () => {
    const body = await (await get()).json()
    expect(body.orders).toHaveLength(1)
    expect(body.orders[0]).toMatchObject({ total: 120, quantity: 2, product_summary: 'Producto A', is_multiproduct: false })
    expect(body.orders[0].lines).toEqual([{ line_number: 1, product_name: 'Producto A', quantity: 2, unit_price: null, subtotal: 120 }])
  })

  it('multi-product order: ONE header with N real items, no duplicated header, items ordered by line', async () => {
    data.orders = [row({ product: '2 x C\n1 x D', quantity: 3, price: '175.00' })]
    data.items = [
      { order_id: ORDER_A, line_number: 2, product_name: 'Producto D', quantity: 1, unit_price: '25.00', subtotal: '25.00' },
      { order_id: ORDER_A, line_number: 1, product_name: 'Producto C', quantity: 2, unit_price: '75.00', subtotal: '150.00' },
    ]
    const body = await (await get()).json()
    expect(body.orders).toHaveLength(1)
    const o = body.orders[0]
    expect(o.is_multiproduct).toBe(true)
    expect(o.lines.map((l: { product_name: string }) => l.product_name)).toEqual(['Producto C', 'Producto D'])
    expect(o.lines[0]).toEqual({ line_number: 1, product_name: 'Producto C', quantity: 2, unit_price: 75, subtotal: 150 })
    expect(o.quantity).toBe(3)
    expect(o.total).toBe(175)
    expect(o.product_summary).toBe('2 × Producto C + 1 × Producto D')
  })

  it('conversation_id NULL is a valid order (null), not an error', async () => {
    data.orders = [row({ conversation_id: null, department: null })]
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).orders[0]).toMatchObject({ conversation_id: null, department: null })
  })

  it('an unknown delivery_status is returned as is (the UI falls back safely)', async () => {
    data.orders = [row({ delivery_status: 'something_new' })]
    expect((await (await get()).json()).orders[0].delivery_status).toBe('something_new')
  })
})

describe('GET /api/orders/confirmed: filters and pagination', () => {
  it('orders by confirmed_at DESC then id DESC and asks for limit+1 (default 25)', async () => {
    await get()
    expect(listCall().order).toEqual([['confirmed_at', false], ['id', false]])
    expect(listCall().limit).toBe(26)
  })

  it('returns next_cursor only when there is one more row, and the cursor keeps the raw timestamp + id of the last row', async () => {
    data.orders = [row(), row({ id: ORDER_B, confirmed_at: '2026-11-16T17:12:59.474992+00:00' })]
    const body = await (await get('?limit=1')).json()
    expect(body.orders).toHaveLength(1)
    const cursor = JSON.parse(Buffer.from(body.next_cursor, 'base64url').toString())
    expect(cursor).toEqual({ t: '2026-11-16T17:12:59.474993+00:00', id: ORDER_A })

    data.orders = [row()]
    expect((await (await get('?limit=1')).json()).next_cursor).toBeNull()
  })

  it('applies the cursor as keyset (confirmed_at < t OR (= t AND id < id)), never as an offset', async () => {
    data.orders = [row(), row({ id: ORDER_B })]
    const first = await (await get('?limit=1')).json()
    calls.length = 0
    await get(`?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`)
    expect(listCall().or).toEqual([`confirmed_at.lt.2026-11-16T17:12:59.474993+00:00,and(confirmed_at.eq.2026-11-16T17:12:59.474993+00:00,id.lt.${ORDER_A})`])
  })

  it('delivery_status filter is validated against the known states', async () => {
    await get('?status=held')
    expect(listCall().eq).toContainEqual(['delivery_status', 'held'])
    expect((await get('?status=held);drop')).status).toBe(400)
  })

  it('search is sanitized and only targets customer / product / seller', async () => {
    await get('?q=' + encodeURIComponent('Ana),seller_user_id.eq.x%*'))
    expect(listCall().or).toHaveLength(1)
    expect(listCall().or[0]).toMatch(/^customer_name\.ilike\.\*[^,()%]*\*,product\.ilike\.\*[^,()%]*\*,seller_name\.ilike\.\*[^,()%]*\*$/)
    expect(listCall().or[0]).not.toContain('seller_user_id')
  })

  it('customer / product / seller search is unchanged (and a plain word adds no id filter)', async () => {
    await get('?q=' + encodeURIComponent('taladro'))
    expect(listCall().or).toEqual(['customer_name.ilike.*taladro*,product.ilike.*taladro*,seller_name.ilike.*taladro*'])
    for (const col of ['customer_name', 'product', 'seller_name']) expect(listCall().or[0]).toContain(`${col}.ilike.`)
    expect(listCall().or[0]).not.toContain('id.gte')
  })

  it('a full UUID is also matched against the order id (still scoped to the session account)', async () => {
    await get('?q=' + encodeURIComponent('B5479C55-78D8-4507-8BA5-D9C9923D9199'))
    expect(listCall().or).toHaveLength(1)
    expect(listCall().or[0]).toContain('customer_name.ilike.*B5479C55-78D8-4507-8BA5-D9C9923D9199*')
    expect(listCall().or[0]).toMatch(/,and\(id\.gte\.b5479c55-78d8-4507-8ba5-d9c9923d9199,id\.lte\.b5479c55-78d8-4507-8ba5-d9c9923d9199\)$/)
    expect(listCall().eq).toContainEqual(['account_id', 'acc-1'])
  })

  it('an id prefix (b5479c55) becomes an inclusive uuid range', async () => {
    await get('?q=b5479c55')
    expect(listCall().or[0]).toMatch(/,and\(id\.gte\.b5479c55-0000-0000-0000-000000000000,id\.lte\.b5479c55-ffff-ffff-ffff-ffffffffffff\)$/)
  })

  it('the id search is combined with a cursor (two ANDed or() groups) and with the status filter', async () => {
    data.orders = [row(), row({ id: ORDER_B })]
    const first = await (await get('?limit=1')).json()
    calls.length = 0
    await get(`?limit=1&q=b5479c55&status=held&cursor=${encodeURIComponent(first.next_cursor)}`)
    expect(listCall().or).toHaveLength(2)
    expect(listCall().eq).toContainEqual(['delivery_status', 'held'])
  })

  it('too short or non-hex text never adds an id filter (and nothing else changes: permissions are untouched)', async () => {
    for (const q of ['b5479c5', 'xyz12345', 'b5479c55x']) {
      calls.length = 0
      await get('?q=' + q)
      expect(listCall().or[0]).not.toContain('id.gte')
    }
    data.profileRole = 'commercial'
    calls.length = 0
    expect((await get('?q=b5479c55')).status).toBe(403)
    expect(calls.some((c) => c.table === 'order_confirmations')).toBe(false)
  })

  it.each(['?limit=0', '?limit=51', '?limit=abc', '?cursor=not-a-cursor'])('rejects %s with 400 and reads nothing', async (qs) => {
    expect((await get(qs)).status).toBe(400)
    expect(calls.some((c) => c.table === 'order_confirmations')).toBe(false)
  })
})

describe('GET /api/orders/confirmed/access', () => {
  it('reports enabled/allowed/scope for the menu (fail-closed)', async () => {
    data.profileRole = 'logistics'
    expect(await (await ACCESS()).json()).toEqual({ enabled: true, allowed: true })
    data.profileRole = 'supervisor'
    expect(await (await ACCESS()).json()).toEqual({ enabled: true, allowed: true })
    data.profileRole = 'commercial'
    expect(await (await ACCESS()).json()).toEqual({ enabled: true, allowed: false })
    data.profileRole = null
    expect(await (await ACCESS()).json()).toEqual({ enabled: true, allowed: false })
    data.profileRole = 'logistics'
    data.flag = false
    expect(await (await ACCESS()).json()).toEqual({ enabled: false, allowed: false })
    getCurrentAccount.mockRejectedValue(new Error('Unauthorized'))
    expect((await ACCESS()).status).toBe(401)
  })
})
