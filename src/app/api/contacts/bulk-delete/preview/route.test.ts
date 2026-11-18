import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/contacts/bulk-delete/preview — read-only impact preview (counts only, session account, role-aware flags).
const ACCOUNT_A = '11111111-1111-4111-8111-111111111111'
let callerRole = 'agent'
const db = vi.hoisted(() => ({ rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>, error: null as { message: string } | null, writes: 0 }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b; b.eq = () => b
      b.maybeSingle = () => Promise.resolve(table === 'profiles' ? { data: { account_id: ACCOUNT_A, account_role: callerRole }, error: null } : table === 'accounts' ? { data: { id: ACCOUNT_A, name: 'A' }, error: null } : { data: null, error: null })
      return b
    },
  })),
}))
vi.mock('@/lib/contacts/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      db.rpc.push({ fn, args })
      if (db.error) return Promise.resolve({ data: null, error: db.error })
      return Promise.resolve({ data: { contacts: 2, conversations: 2, messages: 9, orders: 1, contacts_with_orders: 1, blocked: 0, recent_conversations: 1, with_bsuid: 0, limits: { per_operation: 100, account_24h: 1000, agent_hour: 10, recent_days: 30 }, account_24h_used: 5 }, error: null })
    },
  }),
}))

import { POST } from './route'

const U1 = '22222222-2222-4222-8222-222222222222'
const U2 = '33333333-3333-4333-8333-333333333333'
const call = (body: unknown) => POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }))

beforeEach(() => { callerRole = 'agent'; db.rpc = []; db.error = null })

describe('POST /api/contacts/bulk-delete/preview', () => {
  it('returns the impact for the SESSION account only, calling the read-only function', async () => {
    const res = await call({ contact_ids: [U1, U2], account_id: 'evil' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ contacts: 2, conversations: 2, messages: 9, orders: 1, account_24h_used: 5 })
    expect(db.rpc).toEqual([{ fn: 'contact_delete_impact', args: { p_account_id: ACCOUNT_A, p_contact_ids: [U1, U2] } }])
  })

  it('is role-aware: an agent cannot bulk delete or delete contacts with orders; an admin can', async () => {
    expect(await (await call({ contact_ids: [U1] })).json()).toMatchObject({ role: 'agent', can_bulk: false, can_delete_with_orders: false })
    callerRole = 'admin'
    expect(await (await call({ contact_ids: [U1] })).json()).toMatchObject({ role: 'admin', can_bulk: true, can_delete_with_orders: true })
  })

  it('a viewer is forbidden and nothing is called', async () => {
    callerRole = 'viewer'
    expect((await call({ contact_ids: [U1] })).status).toBe(403)
    expect(db.rpc).toHaveLength(0)
  })

  it.each([['empty', { contact_ids: [] }], ['not uuid', { contact_ids: ['x'] }], ['missing', {}], ['too many', { contact_ids: Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) }]])('invalid input (%s) is a 400 with no database call', async (_l, body) => {
    expect((await call(body)).status).toBe(400)
    expect(db.rpc).toHaveLength(0)
  })

  it('a foreign id is a 404 and other failures are a generic 500', async () => {
    db.error = { message: 'CONTACTS_NOT_IN_ACCOUNT' }
    expect((await call({ contact_ids: [U1] })).status).toBe(404)
    db.error = { message: 'boom' }
    expect((await call({ contact_ids: [U1] })).status).toBe(500)
  })
})
