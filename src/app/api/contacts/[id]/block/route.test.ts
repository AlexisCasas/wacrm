import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/contacts/[id]/block — P0 internal WACRM contact blocking.
// The route is now a thin delegate to the transactional
// `block_contact_internal` SQL function (migration 044) — this file
// covers the route's own responsibilities (auth, RPC-arg wiring,
// response-code mapping for the RPC's null/true/false contract) and
// leaves proving the RPC's actual transactional SQL behavior to the
// migration/manual-verification, since vitest has no real Postgres to
// run it against.

const ACCOUNT = 'acct-1'

let callerRole: string = 'agent'

function makeSessionSupabaseMock() {
  function builder(table: string) {
    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of ['select', 'eq']) b[m] = vi.fn(chain)
    b.maybeSingle = vi.fn(() =>
      Promise.resolve(
        table === 'profiles'
          ? { data: { account_id: ACCOUNT, account_role: callerRole }, error: null }
          : table === 'accounts'
            ? { data: { id: ACCOUNT, name: 'Acme' }, error: null }
            : { data: null, error: null },
      ),
    )
    return b
  }

  return {
    auth: {
      getUser: vi.fn(async (): Promise<{ data: { user: { id: string } | null }; error: null }> => ({
        data: { user: { id: 'user-1' } },
        error: null,
      })),
    },
    from: vi.fn((table: string) => builder(table)),
  }
}

let sessionSupabaseMock = makeSessionSupabaseMock()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => sessionSupabaseMock),
}))

const { rpcMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
}))

vi.mock('@/lib/contacts/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: rpcMock,
  }),
}))

import { POST } from './route'

function post() {
  return POST(new Request('http://localhost/api/contacts/contact-1/block', { method: 'POST' }), {
    params: Promise.resolve({ id: 'contact-1' }),
  })
}

beforeEach(() => {
  callerRole = 'agent'
  sessionSupabaseMock = makeSessionSupabaseMock()
  rpcMock.mockReset()
  rpcMock.mockResolvedValue({ data: false, error: null })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/contacts/[id]/block — auth', () => {
  it('401s when there is no session', async () => {
    sessionSupabaseMock.auth.getUser = vi.fn(async () => ({ data: { user: null }, error: null }))
    const res = await post()
    expect(res.status).toBe(401)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('403s a viewer', async () => {
    callerRole = 'viewer'
    const res = await post()
    expect(res.status).toBe(403)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('allows an agent through', async () => {
    const res = await post()
    expect(res.status).toBe(200)
  })
})

describe('POST /api/contacts/[id]/block — RPC delegation', () => {
  it('calls block_contact_internal with account_id/user_id from the session, never the browser', async () => {
    await post()
    expect(rpcMock).toHaveBeenCalledWith('block_contact_internal', {
      p_account_id: ACCOUNT,
      p_contact_id: 'contact-1',
      p_user_id: 'user-1',
    })
  })

  it('404s when the RPC reports the contact does not exist in this account (data=null)', async () => {
    rpcMock.mockResolvedValue({ data: null, error: null })
    const res = await post()
    expect(res.status).toBe(404)
  })

  it('200s and reports blocked=true when the RPC performed the transition (data=false)', async () => {
    rpcMock.mockResolvedValue({ data: false, error: null })
    const res = await post()
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ success: true, blocked: true })
  })

  it('200s idempotently when the RPC reports it was already blocked (data=true)', async () => {
    rpcMock.mockResolvedValue({ data: true, error: null })
    const res = await post()
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ success: true, blocked: true })
  })

  it('500s without leaking the internal error message when the RPC errors', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'db exploded: secret detail' } })
    const res = await post()
    const json = await res.json()
    expect(res.status).toBe(500)
    expect(JSON.stringify(json)).not.toContain('secret detail')
  })
})
