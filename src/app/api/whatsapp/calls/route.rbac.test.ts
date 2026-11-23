import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requests: [] as Array<{ action?: string; callId?: string }>,
  pruneCalls: 0,
  allow: false,
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({
    accountId: 'trusted-account',
    userId: 'trusted-operator',
    role: 'agent',
  })),
  toErrorResponse: (error: { status?: number; message?: string }) =>
    Response.json({ error: error.message ?? 'Internal server error' }, { status: error.status ?? 500 }),
}))

vi.mock('@/lib/whatsapp/calling-operator-access', () => ({
  assertCallingOperator: vi.fn(async (_actor: unknown, operation?: { action?: string; callId?: string }) => {
    h.requests.push(operation ?? {})
    if (!h.allow) throw Object.assign(new Error('Calling area not authorized'), { status: 403 })
  }),
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => {
    h.pruneCalls++
    throw new Error('DATABASE_MUST_NOT_BE_READ_BEFORE_GUARD')
  },
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({ error: 'rate limited' }, { status: 429 }),
  RATE_LIMITS: { send: {} },
}))

import { GET, POST } from './route'

function post(action: string): Request {
  return new Request('https://wacrm.test/api/whatsapp/calls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, call_id: 'wacid.rbac-test' }),
  })
}

beforeEach(() => {
  h.requests = []
  h.pruneCalls = 0
  h.allow = false
})

describe('CALL-RBAC-01 server routing', () => {
  it.each([
    '',
    '?pilot_contact_id=a3000000-0000-4000-8000-000000000004',
    '?inbox_alerts=1',
    '?call_id=wacid.rbac-test',
  ])('blocks GET before any SDP, history or notification lookup: %s', async (query) => {
    const response = await GET(new Request('https://wacrm.test/api/whatsapp/calls' + query))
    expect(response.status).toBe(403)
    expect(h.pruneCalls).toBe(0)
    expect(h.requests).toHaveLength(1)
  })

  it.each([
    'claim','renew_claim','release','pre_accept','accept','reject','terminate',
    'connect','check_permission','request_permission',
  ])('blocks %s before claims, signaling, or Meta', async (action) => {
    const response = await POST(post(action))
    expect(response.status).toBe(403)
    expect(h.pruneCalls).toBe(0)
    expect(h.requests).toEqual([{ action, callId: 'wacid.rbac-test' }])
  })
})
