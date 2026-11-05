import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/contacts/bulk-delete — auth, validation, tenant scoping, all-or-nothing contract with the RPC.
const ACCOUNT_A = '11111111-1111-4111-8111-111111111111'
let callerRole = 'agent'

const db = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcResult: { data: { deleted: 2, conversations_deleted: 2, messages_deleted: 7 }, error: null } as { data: unknown; error: { message: string } | null },
  otherTables: [] as string[],
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = () => Promise.resolve(
        table === 'profiles' ? { data: { account_id: ACCOUNT_A, account_role: callerRole }, error: null }
          : table === 'accounts' ? { data: { id: ACCOUNT_A, name: 'A' }, error: null }
            : { data: null, error: null })
      return b
    },
  })),
}))
vi.mock('@/lib/contacts/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => { db.rpcCalls.push({ fn, args }); return Promise.resolve(db.rpcResult) },
    from: (t: string) => { db.otherTables.push(t); throw new Error('the route must only call the RPC') },
  }),
}))

import { POST, MAX_BULK_DELETE } from './route'

const U1 = '22222222-2222-4222-8222-222222222222'
const U2 = '33333333-3333-4333-8333-333333333333'
const call = (body: unknown) => POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }))

beforeEach(() => {
  callerRole = 'agent'
  db.rpcCalls = []
  db.otherTables = []
  db.rpcResult = { data: { deleted: 2, conversations_deleted: 2, messages_deleted: 7 }, error: null }
})

describe('POST /api/contacts/bulk-delete', () => {
  it('agent deletes exactly the given ids using the SESSION account (never one from the body)', async () => {
    const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ contact_ids: [U1, U2], account_id: 'evil', filters: { tag: 'x' } }) }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, deleted: 2, conversations_deleted: 2, messages_deleted: 7 })
    expect(db.rpcCalls).toEqual([{ fn: 'bulk_delete_contacts_internal', args: { p_account_id: ACCOUNT_A, p_contact_ids: [U1, U2] } }])
    expect(db.otherTables).toEqual([])
  })

  it('admin can; viewer is forbidden and nothing is called', async () => {
    callerRole = 'admin'
    expect((await call({ contact_ids: [U1] })).status).toBe(200)
    callerRole = 'viewer'
    db.rpcCalls = []
    expect((await call({ contact_ids: [U1] })).status).toBe(403)
    expect(db.rpcCalls).toHaveLength(0)
  })

  it.each([
    ['empty array', { contact_ids: [] }],
    ['missing', {}],
    ['not an array', { contact_ids: U1 }],
    ['a non-uuid', { contact_ids: [U1, 'not-a-uuid'] }],
    ['a non-string', { contact_ids: [U1, 5] }],
    ['too many', { contact_ids: Array.from({ length: MAX_BULK_DELETE + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) }],
  ])('invalid batch (%s) deletes nothing', async (_label, body) => {
    expect((await call(body)).status).toBe(400)
    expect(db.rpcCalls).toHaveLength(0)
  })

  it('invalid JSON deletes nothing', async () => {
    const res = await POST(new Request('http://x', { method: 'POST', body: '{nope' }))
    expect(res.status).toBe(400)
    expect(db.rpcCalls).toHaveLength(0)
  })

  it('duplicates are collapsed before the RPC', async () => {
    await call({ contact_ids: [U1, U1.toUpperCase(), U2] })
    expect(db.rpcCalls[0].args.p_contact_ids).toEqual([U1, U2])
  })

  it('cross-account: an id of another account rejects the whole batch (404, deleted = 0)', async () => {
    db.rpcResult = { data: null, error: { message: 'CONTACTS_NOT_IN_ACCOUNT' } }
    const res = await call({ contact_ids: [U1, U2] })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ deleted: 0 })
  })

  it('a failure inside the transaction is a 500 with deleted = 0 (the RPC rolled everything back)', async () => {
    db.rpcResult = { data: null, error: { message: 'DELETE_COUNT_MISMATCH' } }
    const res = await call({ contact_ids: [U1] })
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ deleted: 0 })
  })
})
