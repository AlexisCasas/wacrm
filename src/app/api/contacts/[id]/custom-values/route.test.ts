import { beforeEach, describe, expect, it, vi } from 'vitest'

// DELETE /api/contacts/[id]/custom-values — auth, tenant scoping, per-contact deletion, definitions untouched.

let callerRole = 'agent'
let authed = true

type Contact = { id: string; account_id: string }
type ValueRow = { id: string; contact_id: string; custom_field_id: string }

const db = vi.hoisted(() => ({
  contacts: [] as Array<{ id: string; account_id: string }>,
  values: [] as Array<{ id: string; contact_id: string; custom_field_id: string }>,
  customFieldsCount: 0,
  deleteError: null as { message: string } | null,
  tablesDeleted: [] as string[],
  deleteFilters: [] as Array<[string, unknown]>,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({ data: { user: authed ? { id: 'user-1' } : null }, error: null }),
    },
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = () => Promise.resolve(
        table === 'profiles' ? { data: { account_id: 'acct-1', account_role: callerRole }, error: null }
          : table === 'accounts' ? { data: { id: 'acct-1', name: 'Acme' }, error: null }
            : { data: null, error: null })
      return b
    },
  })),
}))

vi.mock('@/lib/contacts/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {}
      let deleting = false
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.delete = () => { deleting = true; return b }
      b.eq = (k: string, v: unknown) => { filters[k] = v; return b }
      b.maybeSingle = () => Promise.resolve({
        data: db.contacts.find((c: Contact) => c.id === filters.id && c.account_id === filters.account_id) ?? null,
        error: null,
      })
      b.then = (resolve: (v: unknown) => unknown) => {
        if (!deleting) return Promise.resolve({ data: null, error: null }).then(resolve)
        db.tablesDeleted.push(table)
        db.deleteFilters.push(...Object.entries(filters))
        if (db.deleteError) return Promise.resolve({ error: db.deleteError }).then(resolve)
        // Refuse to emulate an unfiltered delete: nothing is removed without contact_id.
        if (table === 'contact_custom_values' && filters.contact_id) {
          db.values = db.values.filter((r: ValueRow) => r.contact_id !== filters.contact_id)
        }
        return Promise.resolve({ error: null }).then(resolve)
      }
      return b
    },
  }),
}))

import { DELETE } from './route'

const call = (id: string) =>
  DELETE(new Request('http://x', { method: 'DELETE' }), { params: Promise.resolve({ id }) })

beforeEach(() => {
  callerRole = 'agent'
  authed = true
  db.contacts = [
    { id: 'A', account_id: 'acct-1' },
    { id: 'B', account_id: 'acct-1' },
    { id: 'X', account_id: 'acct-other' },
  ]
  db.values = [
    { id: '1', contact_id: 'A', custom_field_id: 'f1' },
    { id: '2', contact_id: 'A', custom_field_id: 'f2' },
    { id: '3', contact_id: 'B', custom_field_id: 'f1' },
    { id: '4', contact_id: 'X', custom_field_id: 'f1' },
  ]
  db.customFieldsCount = 4
  db.deleteError = null
  db.tablesDeleted = []
  db.deleteFilters = []
})

describe('DELETE /api/contacts/[id]/custom-values', () => {
  it('removes every value of contact A only; B and other-account values stay', async () => {
    const res = await call('A')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(db.values.map((r) => r.id)).toEqual(['3', '4'])
  })

  it('only touches contact_custom_values (never custom_fields) and always filters by contact_id', async () => {
    await call('A')
    expect(db.tablesDeleted).toEqual(['contact_custom_values'])
    expect(db.deleteFilters).toEqual([['contact_id', 'A']])
    expect(db.customFieldsCount).toBe(4)
  })

  it('is idempotent for a contact without values', async () => {
    const res = await call('A')
    const again = await call('A')
    expect(res.status).toBe(200)
    expect(again.status).toBe(200)
    expect(db.values.map((r) => r.id)).toEqual(['3', '4'])
  })

  it('rejects a contact of another account (404) and deletes nothing', async () => {
    const res = await call('X')
    expect(res.status).toBe(404)
    expect(db.tablesDeleted).toEqual([])
    expect(db.values).toHaveLength(4)
  })

  it('rejects an unknown contact (404) and deletes nothing', async () => {
    const res = await call('nope')
    expect(res.status).toBe(404)
    expect(db.tablesDeleted).toEqual([])
    expect(db.values).toHaveLength(4)
  })

  it('rejects an unauthenticated caller and deletes nothing', async () => {
    authed = false
    const res = await call('A')
    expect([401, 403]).toContain(res.status)
    expect(db.tablesDeleted).toEqual([])
    expect(db.values).toHaveLength(4)
  })

  it('rejects a viewer (no edit permission) with 403 and deletes nothing', async () => {
    callerRole = 'viewer'
    const res = await call('A')
    expect(res.status).toBe(403)
    expect(db.tablesDeleted).toEqual([])
    expect(db.values).toHaveLength(4)
  })

  it('DB error returns 500, not success', async () => {
    db.deleteError = { message: 'boom' }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await call('A')
    spy.mockRestore()
    expect(res.status).toBe(500)
    expect(await res.json()).not.toHaveProperty('success')
  })
})
