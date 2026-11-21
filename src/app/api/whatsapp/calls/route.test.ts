import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  callRow: { phone_number_id: '740434745820831' } as { phone_number_id: string } | null,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  rpcResult: true as boolean,
  rpcError: null as { code: string } | null,
  rateKeys: [] as string[],
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({ accountId: 'account-from-session', userId: 'agent-from-session' })),
  toErrorResponse: vi.fn(() => Response.json({ error: 'Internal server error' }, { status: 500 })),
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table !== 'whatsapp_call_sessions') throw new Error(`unexpected table: ${table}`)
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: h.callRow, error: null }),
            }),
          }),
        }),
      }
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcCalls.push({ name, args })
      if (name === 'whatsapp_call_sdp_prune') return { data: 0, error: null }
      return { data: h.rpcResult, error: h.rpcError }
    },
  }),
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (key: string) => {
    h.rateKeys.push(key)
    return { success: true }
  },
  rateLimitResponse: () => Response.json({ error: 'rate limited' }, { status: 429 }),
  RATE_LIMITS: { send: {} },
}))

vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (value: string) => value }))
vi.mock('@/lib/whatsapp/calling-api', () => ({
  getWhatsAppCallPermission: vi.fn(),
  sendWhatsAppCallPermissionRequest: vi.fn(),
}))

import { POST } from './route'

function request(body: Record<string, unknown>) {
  return new Request('https://wacrm.test/api/whatsapp/calls', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  h.callRow = { phone_number_id: '740434745820831' }
  h.rpcCalls = []
  h.rpcResult = true
  h.rpcError = null
  h.rateKeys = []
})

describe('POST /api/whatsapp/calls — CALL-03A agent metadata', () => {
  it('renews only the current authenticated agent lease', async () => {
    const response = await POST(request({
      action: 'renew_claim',
      call_id: 'wacid.qa-call03',
      account_id: 'attacker-controlled-account',
    }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ success: true, action: 'renew_claim', lease_seconds: 90 })
    expect(h.rpcCalls).toContainEqual({
      name: 'whatsapp_call_claim_renew',
      args: {
        p_account_id: 'account-from-session',
        p_phone_number_id: '740434745820831',
        p_call_id: 'wacid.qa-call03',
        p_actor_user_id: 'agent-from-session',
      },
    })
  })
  // CALL-03B2.4 — lease isolation between agents and accounts.
  it('never takes the actor or account of a lease action from the request body', async () => {
    for (const action of ['claim', 'renew_claim', 'release']) {
      h.rpcCalls = []
      const response = await POST(request({
        action,
        call_id: 'wacid.qa-call0324',
        account_id: 'attacker-account',
        actor_user_id: 'attacker-agent',
        p_actor_user_id: 'attacker-agent',
      }))
      expect(response.status, action).toBe(200)
      const rpc = h.rpcCalls.find((call) => call.name !== 'whatsapp_call_sdp_prune')
      expect(rpc?.args, action).toMatchObject({
        p_account_id: 'account-from-session',
        p_actor_user_id: 'agent-from-session',
      })
    }
  })

  it('answers 409 when another agent holds the lease (claim, renew and release)', async () => {
    h.rpcResult = false
    const expected: Record<string, string> = {
      claim: 'Call is already claimed or no longer available',
      renew_claim: 'Call claim has expired or is no longer owned by you',
      release: 'Call is not claimed by you',
    }
    for (const action of ['claim', 'renew_claim', 'release']) {
      const response = await POST(request({ action, call_id: 'wacid.qa-call0324' }))
      expect(response.status, action).toBe(409)
      expect(await response.json(), action).toMatchObject({ error: expected[action] })
    }
  })

  it('answers 403 when the actor is not an agent of the account (RPC role check)', async () => {
    h.rpcError = { code: '42501' }
    for (const action of ['claim', 'renew_claim', 'release']) {
      const response = await POST(request({ action, call_id: 'wacid.qa-call0324' }))
      expect(response.status, action).toBe(403)
    }
  })

  it('does not reach any lease RPC for a call that belongs to another account', async () => {
    h.callRow = null // the lookup is scoped by the session account_id and finds nothing
    for (const action of ['claim', 'renew_claim', 'release']) {
      h.rpcCalls = []
      const response = await POST(request({ action, call_id: 'wacid.qa-call0324' }))
      expect(response.status, action).toBe(404)
      expect(h.rpcCalls.filter((call) => call.name !== 'whatsapp_call_sdp_prune'), action).toEqual([])
    }
  })

  it('keeps claim, renew and release in the shared per-agent 60/min budget used by the 30 s heartbeat', async () => {
    for (const action of ['claim', 'renew_claim', 'release']) {
      await POST(request({ action, call_id: 'wacid.qa-call0324' }))
    }
    expect(h.rateKeys).toEqual([
      'calling:agent-from-session',
      'calling:agent-from-session',
      'calling:agent-from-session',
    ])
    // A full accept uses ~7 POSTs; the heartbeat adds 2/min. The real budget is 60/min.
    const actual = await vi.importActual<typeof import('@/lib/rate-limit')>('@/lib/rate-limit')
    expect(actual.RATE_LIMITS.send.limit).toBeGreaterThanOrEqual(60)
    expect(actual.RATE_LIMITS.send.windowMs).toBe(60_000)
  })
})


vi.mock('@/lib/whatsapp/calling-pilot', () => ({
  isWhatsAppCallingPilotAllowed: () => true,
}))
