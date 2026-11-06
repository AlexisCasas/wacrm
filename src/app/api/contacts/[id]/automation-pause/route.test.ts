import { beforeEach, describe, expect, it, vi } from 'vitest'

// PUT /api/contacts/[id]/automation-pause — auth, validation, tenant scoping and the single table it may write.

const ACCOUNT = 'acct-1'
let callerRole = 'agent'

const db = vi.hoisted(() => ({
  contactFound: true,
  contactFilters: [] as Array<[string, unknown]>,
  writes: [] as Array<{ table: string; payload: Record<string, unknown>; opts: unknown }>,
  tablesTouched: [] as string[],
  upsertError: null as { message: string } | null,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = () => Promise.resolve(
        table === 'profiles' ? { data: { account_id: ACCOUNT, account_role: callerRole }, error: null }
          : table === 'accounts' ? { data: { id: ACCOUNT, name: 'Acme' }, error: null }
            : { data: null, error: null })
      return b
    },
  })),
}))

vi.mock('@/lib/contacts/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      db.tablesTouched.push(table)
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (k: string, v: unknown) => (db.contactFilters.push([k, v]), b)
      b.maybeSingle = () => Promise.resolve({ data: db.contactFound ? { id: 'angelo' } : null, error: null })
      b.upsert = (payload: Record<string, unknown>, opts: unknown) => {
        db.writes.push({ table, payload, opts })
        return Promise.resolve({ error: db.upsertError })
      }
      return b
    },
  }),
}))

import { PUT } from './route'

const call = (id: string, body: unknown) =>
  PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })

beforeEach(() => {
  callerRole = 'agent'
  db.contactFound = true
  db.contactFilters = []
  db.writes = []
  db.tablesTouched = []
  db.upsertError = null
})

describe('PUT /api/contacts/[id]/automation-pause', () => {
  it('agent pauses: writes only contact_automation_settings for that contact + session account', async () => {
    const res = await call('angelo', { paused: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, paused: true })
    expect(db.writes).toHaveLength(1)
    expect(db.writes[0].table).toBe('contact_automation_settings')
    expect(db.writes[0].payload).toMatchObject({ contact_id: 'angelo', account_id: ACCOUNT, keyword_automations_paused: true, updated_by_user_id: 'user-1' })
    expect(db.contactFilters).toContainEqual(['account_id', ACCOUNT])
    expect(db.tablesTouched.sort()).toEqual(['contact_automation_settings', 'contacts'])
  })

  it('resume writes paused=false', async () => {
    const res = await call('angelo', { paused: false })
    expect(await res.json()).toEqual({ success: true, paused: false })
    expect(db.writes[0].payload.keyword_automations_paused).toBe(false)
  })

  it('admin can too', async () => {
    callerRole = 'admin'
    expect((await call('angelo', { paused: true })).status).toBe(200)
  })

  it('viewer is forbidden and nothing is written', async () => {
    callerRole = 'viewer'
    expect((await call('angelo', { paused: true })).status).toBe(403)
    expect(db.writes).toHaveLength(0)
  })

  it('a contact outside the account is 404 and nothing is written', async () => {
    db.contactFound = false
    expect((await call('foreign', { paused: true })).status).toBe(404)
    expect(db.writes).toHaveLength(0)
  })

  it.each([{}, { paused: 'yes' }, null])('rejects an invalid body %j', async (body) => {
    expect((await call('angelo', body)).status).toBe(400)
    expect(db.writes).toHaveLength(0)
  })

  it('a failed write is a 500', async () => {
    db.upsertError = { message: 'boom' }
    expect((await call('angelo', { paused: true })).status).toBe(500)
  })
})
