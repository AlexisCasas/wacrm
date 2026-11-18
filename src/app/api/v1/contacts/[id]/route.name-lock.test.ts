import { describe, expect, it, vi, beforeEach } from 'vitest'

// FIX 03 — PATCH /api/v1/contacts/{id}: a name set through the API is saved with its lock;
// an empty/null name is a loud 400 (nothing written); email/company keep their behaviour.

const h = vi.hoisted(() => ({
  existing: { id: 'c1', name: 'Perfil', email: null, company: null } as Record<string, unknown> | null,
  updates: [] as { payload: Record<string, unknown>; filters: [string, unknown][] }[],
}))

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: async () => ({
    accountId: 'acct-1',
    supabase: {
      from: () => {
        const rec = { payload: {} as Record<string, unknown>, filters: [] as [string, unknown][] }
        const b: Record<string, unknown> = {
          update: (p: Record<string, unknown>) => { rec.payload = p; return b },
          eq: (k: string, v: unknown) => { rec.filters.push([k, v]); return b },
          then: (res: (v: unknown) => unknown) => { h.updates.push(rec); return Promise.resolve({ error: null }).then(res) },
        }
        return b
      },
    },
  }),
}))
vi.mock('@/lib/api/v1/contacts', () => ({
  getContactById: async () => h.existing,
  setContactTags: async () => {},
  resolveAuditUserId: async () => 'u1',
  ContactError: class ContactError extends Error { status = 400 },
}))

import { PATCH } from './route'

const call = (body: unknown) =>
  PATCH(new Request('http://x/api/v1/contacts/c1', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'c1' }) })

beforeEach(() => { h.existing = { id: 'c1', name: 'Perfil', email: null, company: null }; h.updates = [] })

describe('PATCH /api/v1/contacts/{id} — name lock', () => {
  it('a changed name is written with name_locked=true in one update, scoped to the account', async () => {
    const res = await call({ name: ' Cliente API ' })
    expect(res.status).toBe(200)
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0].payload).toMatchObject({ name: 'Cliente API', name_locked: true })
    expect(h.updates[0].filters).toContainEqual(['account_id', 'acct-1'])
  })

  it('the same name again is not an edit: no name and no lock in the update', async () => {
    const res = await call({ name: 'Perfil', company: 'ACME' })
    expect(res.status).toBe(200)
    expect(h.updates[0].payload).toMatchObject({ company: 'ACME' })
    expect('name' in h.updates[0].payload).toBe(false)
    expect('name_locked' in h.updates[0].payload).toBe(false)
  })

  it.each([[''], ['   '], [null]])('an empty name (%j) is a 400 and writes nothing', async (value) => {
    const res = await call({ name: value, company: 'ACME' })
    expect(res.status).toBe(400)
    expect(h.updates).toHaveLength(0)
  })

  it('email and company can still be cleared with null (unchanged contract)', async () => {
    const res = await call({ email: null, company: null })
    expect(res.status).toBe(200)
    expect(h.updates[0].payload).toMatchObject({ email: null, company: null })
    expect('name_locked' in h.updates[0].payload).toBe(false)
  })

  it('a non-string name is still rejected as before', async () => {
    expect((await call({ name: 5 })).status).toBe(400)
    expect(h.updates).toHaveLength(0)
  })
})
