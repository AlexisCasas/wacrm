import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// feat/per-account-meta-app-secret
//
// POST /api/whatsapp/config's handling of the new, optional `app_secret`
// field: encrypted before persistence, never written when blank/absent
// (so an existing secret survives an edit that doesn't touch it), and
// never echoed back in the response — plaintext or ciphertext.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  state: {
    /**
     * Existing whatsapp_config row for this account, or null (fresh
     * setup). Shared by both GET (reads access_token/app_secret/status)
     * and POST's "existing row" lookup (reads id/registered_at/
     * phone_number_id) — a real row has all of these at once, so one
     * shape serves both call sites.
     */
    existing: null as {
      id: string
      registered_at: string | null
      phone_number_id: string
      access_token?: string
      app_secret?: string | null
      status?: string
    } | null,
    /** Row conflicting on phone_number_id from ANOTHER account, or null. */
    claimedByOther: null as { account_id: string } | null,
    insertCalls: [] as Record<string, unknown>[],
    updateCalls: [] as Record<string, unknown>[],
  },
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }),
    },
    from(table: string) {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { account_id: 'acct-1' }, error: null }),
            }),
          }),
        }
      }
      if (table === 'whatsapp_config') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: h.state.existing, error: null }),
            }),
          }),
          update: (row: Record<string, unknown>) => {
            h.state.updateCalls.push(row)
            return { eq: async () => ({ error: null }) }
          },
          insert: (row: Record<string, unknown>) => {
            h.state.insertCalls.push(row)
            return Promise.resolve({ error: null })
          },
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      if (table !== 'whatsapp_config') throw new Error(`unexpected admin table: ${table}`)
      return {
        select: () => ({
          eq: () => ({
            neq: () => ({
              maybeSingle: async () => ({ data: h.state.claimedByOther, error: null }),
            }),
          }),
        }),
      }
    },
  }),
}))

vi.mock('@/lib/whatsapp/meta-api', () => ({
  verifyPhoneNumber: vi.fn(async () => ({
    id: 'pn-1',
    display_phone_number: '+1 555 000 1111',
    verified_name: 'Test Biz',
  })),
  registerPhoneNumber: vi.fn(),
  subscribeWabaToApp: vi.fn(),
}))

import { POST, GET } from './route'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'

function req(body: Record<string, unknown>) {
  return { json: async () => body } as unknown as Request
}

beforeEach(() => {
  h.state.existing = null
  h.state.claimedByOther = null
  h.state.insertCalls = []
  h.state.updateCalls = []
})

const BASE_PAYLOAD = {
  phone_number_id: 'pn-1',
  access_token: 'meta-access-token',
}

describe('POST /api/whatsapp/config — app_secret encryption', () => {
  it('encrypts a newly provided app_secret before persisting it (insert path)', async () => {
    const res = await POST(req({ ...BASE_PAYLOAD, app_secret: 'my-plain-app-secret' }))
    expect(res.status).toBe(200)

    expect(h.state.insertCalls).toHaveLength(1)
    const stored = h.state.insertCalls[0].app_secret as string
    expect(stored).toBeTypeOf('string')
    expect(stored).not.toBe('my-plain-app-secret');
    expect(stored.includes('my-plain-app-secret')).toBe(false)
    expect(decrypt(stored)).toBe('my-plain-app-secret')
  })

  it('encrypts a new app_secret on the update path too', async () => {
    h.state.existing = { id: 'cfg-1', registered_at: null, phone_number_id: 'pn-1' }
    const res = await POST(req({ ...BASE_PAYLOAD, app_secret: 'rotated-secret' }))
    expect(res.status).toBe(200)

    expect(h.state.updateCalls).toHaveLength(1)
    const stored = h.state.updateCalls[0].app_secret as string
    expect(decrypt(stored)).toBe('rotated-secret')
  })
})

describe('POST /api/whatsapp/config — blank app_secret preserves the existing value', () => {
  it('omits app_secret from the update payload entirely when the field is left blank', async () => {
    h.state.existing = { id: 'cfg-1', registered_at: null, phone_number_id: 'pn-1' }
    const res = await POST(req({ ...BASE_PAYLOAD })) // no app_secret key at all
    expect(res.status).toBe(200)

    expect(h.state.updateCalls).toHaveLength(1)
    expect('app_secret' in h.state.updateCalls[0]).toBe(false)
  })

  it('omits app_secret from the update payload when it is an empty string', async () => {
    h.state.existing = { id: 'cfg-1', registered_at: null, phone_number_id: 'pn-1' }
    const res = await POST(req({ ...BASE_PAYLOAD, app_secret: '' }))
    expect(res.status).toBe(200)

    expect('app_secret' in h.state.updateCalls[0]).toBe(false)
  })

  it('omits app_secret from the update payload when it is only whitespace', async () => {
    h.state.existing = { id: 'cfg-1', registered_at: null, phone_number_id: 'pn-1' }
    const res = await POST(req({ ...BASE_PAYLOAD, app_secret: '   ' }))
    expect(res.status).toBe(200)

    expect('app_secret' in h.state.updateCalls[0]).toBe(false)
  })

  it('a fresh insert with no app_secret supplied simply omits the column (defaults to NULL)', async () => {
    const res = await POST(req({ ...BASE_PAYLOAD }))
    expect(res.status).toBe(200)
    expect('app_secret' in h.state.insertCalls[0]).toBe(false)
  })
})

describe('POST /api/whatsapp/config — plaintext never returns to the client', () => {
  it('the success response never includes app_secret in any form', async () => {
    const res = await POST(req({ ...BASE_PAYLOAD, app_secret: 'super-secret-value' }))
    const json = await res.json()
    const serialized = JSON.stringify(json)

    expect(json).not.toHaveProperty('app_secret')
    expect(serialized.includes('super-secret-value')).toBe(false)
    // Also guard against the ciphertext leaking, not just the plaintext.
    const stored = h.state.insertCalls[0].app_secret as string
    expect(serialized.includes(stored)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// GET /api/whatsapp/config — Hallazgo 2: app_secret must reach the client
// ONLY as a boolean (`app_secret_configured`), never as ciphertext or
// plaintext in any response field.
// ---------------------------------------------------------------------------
describe('GET /api/whatsapp/config — app_secret_configured boolean, never the value', () => {
  it('returns app_secret_configured=true when the row has an app_secret', async () => {
    h.state.existing = {
      id: 'cfg-1',
      registered_at: null,
      phone_number_id: 'pn-1',
      access_token: encrypt('meta-access-token'),
      app_secret: encrypt('my-app-secret'),
      status: 'connected',
    }
    const res = await GET()
    const json = await res.json()
    expect(json.connected).toBe(true)
    expect(json.app_secret_configured).toBe(true)
  })

  it('returns app_secret_configured=false when app_secret is null (legacy row)', async () => {
    h.state.existing = {
      id: 'cfg-1',
      registered_at: null,
      phone_number_id: 'pn-1',
      access_token: encrypt('meta-access-token'),
      app_secret: null,
      status: 'connected',
    }
    const res = await GET()
    const json = await res.json()
    expect(json.app_secret_configured).toBe(false)
  })

  it('never includes app_secret itself — plaintext or ciphertext — in the response', async () => {
    const secretCiphertext = encrypt('my-app-secret')
    h.state.existing = {
      id: 'cfg-1',
      registered_at: null,
      phone_number_id: 'pn-1',
      access_token: encrypt('meta-access-token'),
      app_secret: secretCiphertext,
      status: 'connected',
    }
    const res = await GET()
    const json = await res.json()
    const serialized = JSON.stringify(json)

    expect(json).not.toHaveProperty('app_secret')
    expect(serialized.includes('my-app-secret')).toBe(false)
    expect(serialized.includes(secretCiphertext)).toBe(false)
  })

  it('still returns app_secret_configured on the token_corrupted branch', async () => {
    h.state.existing = {
      id: 'cfg-1',
      registered_at: null,
      phone_number_id: 'pn-1',
      access_token: 'not-valid-ciphertext', // fails to decrypt
      app_secret: encrypt('my-app-secret'),
      status: 'connected',
    }
    const res = await GET()
    const json = await res.json()
    expect(json.reason).toBe('token_corrupted')
    expect(json.app_secret_configured).toBe(true)
    expect(json).not.toHaveProperty('app_secret')
  })
})
