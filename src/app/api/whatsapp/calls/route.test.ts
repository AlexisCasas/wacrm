import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  callRow: { phone_number_id: '740434745820831' } as { phone_number_id: string } | null,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  rpcResult: true as boolean,
  rpcError: null as { code: string } | null,
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
  checkRateLimit: () => ({ success: true }),
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

  it('records the accepted agent and links only the supplied conversation through the guarded RPC', async () => {
    const response = await POST(request({
      action: 'agent_action',
      agent_action: 'accepted',
      call_id: 'wacid.qa-call03',
      conversation_id: 'a3000000-0000-4000-8000-000000000001',
    }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      success: true,
      action: 'accepted',
      conversation_id: 'a3000000-0000-4000-8000-000000000001',
    })
    expect(h.rpcCalls).toContainEqual({
      name: 'whatsapp_call_session_agent_action',
      args: {
        p_account_id: 'account-from-session',
        p_phone_number_id: '740434745820831',
        p_call_id: 'wacid.qa-call03',
        p_actor_user_id: 'agent-from-session',
        p_action: 'accepted',
        p_conversation_id: 'a3000000-0000-4000-8000-000000000001',
      },
    })
  })

  it('rejects unsupported agent actions before querying or mutating a call', async () => {
    const response = await POST(request({
      action: 'agent_action',
      agent_action: 'force_connect',
      call_id: 'wacid.qa-call03',
    }))

    expect(response.status).toBe(400)
    expect(h.rpcCalls.filter((call) => call.name !== 'whatsapp_call_sdp_prune')).toHaveLength(0)
  })

  it('rejects malformed conversation IDs before calling the database', async () => {
    const response = await POST(request({
      action: 'agent_action',
      agent_action: 'accepted',
      call_id: 'wacid.qa-call03',
      conversation_id: 'not-a-uuid',
    }))

    expect(response.status).toBe(400)
    expect(h.rpcCalls.filter((call) => call.name !== 'whatsapp_call_sdp_prune')).toHaveLength(0)
  })

  it('returns conflict when the lease/action is no longer valid', async () => {
    h.rpcResult = false
    const response = await POST(request({
      action: 'agent_action',
      agent_action: 'accepted',
      call_id: 'wacid.qa-call03',
    }))

    expect(response.status).toBe(409)
  })

  it('maps a cross-tenant or unauthorized database guard to 403', async () => {
    h.rpcError = { code: '42501' }
    const response = await POST(request({
      action: 'agent_action',
      agent_action: 'accepted',
      call_id: 'wacid.qa-call03',
      conversation_id: 'a3000000-0000-4000-8000-000000000001',
    }))

    expect(response.status).toBe(403)
  })

  it('rejects malformed call IDs for agent actions', async () => {
    const response = await POST(request({
      action: 'agent_action',
      agent_action: 'ended',
      call_id: 'not-a-meta-call-id',
    }))

    expect(response.status).toBe(400)
  })
})
