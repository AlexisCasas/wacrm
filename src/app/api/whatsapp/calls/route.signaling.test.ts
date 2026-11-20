import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from './route'

const h = vi.hoisted(() => ({
  accountId: 'a3000000-0000-4000-8000-000000000001',
  userId: 'a3000000-0000-4000-8000-000000000002',
  contactId: 'a3000000-0000-4000-8000-000000000003',
  conversationId: 'a3000000-0000-4000-8000-000000000004',
  requestId: 'a3000000-0000-4000-8000-000000000005',
  phoneNumberId: '740434745820831',
  config: {
    phone_number_id: '740434745820831',
    access_token: 'encrypted-token',
    messaging_account_id: null,
    status: 'connected',
  },
  contact: { id: 'a3000000-0000-4000-8000-000000000003', phone: '51980942247' },
  session: null as Record<string, unknown> | null,
  attemptCreated: true,
  attemptState: 'pending',
  from: vi.fn(),
  rpc: vi.fn(),
  callWhatsApp: vi.fn(),
  getPermission: vi.fn(),
  sendPermission: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  pilotAllowed: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({
    accountId: h.accountId,
    userId: h.userId,
    role: 'agent',
  })),
  toErrorResponse: vi.fn(() => Response.json({ error: 'unexpected' }, { status: 500 })),
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ from: h.from, rpc: h.rpc }),
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(() => ({ success: true })),
  rateLimitResponse: vi.fn(() => Response.json({ error: 'rate limited' }, { status: 429 })),
  RATE_LIMITS: { send: { limit: 10, windowMs: 60000 } },
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: h.encrypt,
  decrypt: h.decrypt,
}))

vi.mock('@/lib/whatsapp/calling-api', () => ({
  callWhatsApp: h.callWhatsApp,
  getWhatsAppCallPermission: h.getPermission,
  sendWhatsAppCallPermissionRequest: h.sendPermission,
}))

vi.mock('@/lib/whatsapp/calling-pilot', () => ({
  isWhatsAppCallingPilotAllowed: h.pilotAllowed,
}))

function makeRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/whatsapp/calls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function setupDb() {
  h.from.mockImplementation((table: string) => {
    const builder: Record<string, unknown> & {
      filters: Record<string, unknown>
      select: () => typeof builder
      eq: (key: string, value: unknown) => typeof builder
      maybeSingle: () => Promise<{ data: unknown; error: null }>
      limit: () => Promise<{ data: unknown[]; error: null }>
    } = {
      filters: {},
      select: () => builder,
      eq: (key, value) => {
        builder.filters[key] = value
        return builder
      },
      maybeSingle: async () => {
        if (table === 'whatsapp_config') return { data: h.config, error: null }
        if (table === 'contacts') return { data: h.contact, error: null }
        if (table === 'whatsapp_call_sessions') return { data: h.session, error: null }
        return { data: null, error: null }
      },
      limit: async () => ({ data: [], error: null }),
    }
    return builder
  })

  h.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === 'whatsapp_call_sdp_prune') return { data: 0, error: null }
    if (name === 'whatsapp_call_outbound_attempt_begin') {
      return {
        data: {
          attempt_id: 'a3000000-0000-4000-8000-000000000006',
          state: h.attemptState,
          call_id: null,
          callback_data: h.requestId,
          created: h.attemptCreated,
        },
        error: null,
      }
    }
    if (name === 'whatsapp_call_outbound_attempt_complete'
      || name === 'whatsapp_call_session_agent_sdp_store'
      || name === 'whatsapp_call_session_agent_action') {
      return { data: true, error: null }
    }
    return { data: null, error: null }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.session = null
  h.attemptCreated = true
  h.attemptState = 'pending'
  setupDb()
  h.pilotAllowed.mockReturnValue(true)
  h.decrypt.mockImplementation((value: string) => {
    if (value === 'encrypted-token') return 'meta-access-token'
    if (value.startsWith('encrypted:')) return value.slice('encrypted:'.length)
    return value
  })
  h.encrypt.mockImplementation((value: string) => `encrypted:${value}`)
  h.getPermission.mockResolvedValue({
    status: 'permanent',
    canStartCall: true,
    canRequestPermission: true,
    actions: [],
  })
  h.callWhatsApp.mockImplementation(async ({ action }: { action: { action: string } }) => {
    if (action.action === 'connect') return { action: 'connect', callId: 'wacid.qa-outbound' }
    return { action: action.action, success: true }
  })
})

afterEach(() => vi.restoreAllMocks())

describe('WhatsApp Calling signaling API', () => {
  it('fails closed when the pilot gate is disabled', async () => {
    h.pilotAllowed.mockReturnValue(false)
    const response = await POST(makeRequest({
      action: 'connect',
      contact_id: h.contactId,
      conversation_id: h.conversationId,
      request_id: h.requestId,
      session: { sdp_type: 'offer', sdp: 'v=0\r\n' },
    }))
    expect(response.status).toBe(403)
    expect(h.callWhatsApp).not.toHaveBeenCalled()
    expect(h.rpc).not.toHaveBeenCalledWith('whatsapp_call_outbound_attempt_begin', expect.anything())
  })

  it('requires a current Meta permission before sending the outbound connect', async () => {
    h.getPermission.mockResolvedValue({
      status: 'no_permission',
      canStartCall: false,
      canRequestPermission: true,
      actions: [],
    })
    const response = await POST(makeRequest({
      action: 'connect',
      contact_id: h.contactId,
      conversation_id: h.conversationId,
      request_id: h.requestId,
      session: { sdp_type: 'offer', sdp: 'v=0\r\n' },
    }))
    expect(response.status).toBe(409)
    expect(h.rpc).toHaveBeenCalledWith('whatsapp_call_outbound_attempt_begin', expect.anything())
    expect(h.rpc).toHaveBeenCalledWith('whatsapp_call_outbound_attempt_fail', expect.objectContaining({
      p_state: 'failed',
      p_failure_code: 'call_permission_not_current',
    }))
    expect(h.callWhatsApp).not.toHaveBeenCalled()
  })

  it('marks a permission lookup failure as failed before any Meta connect request', async () => {
    h.getPermission.mockRejectedValueOnce({ httpStatus: 503 })
    const response = await POST(makeRequest({
      action: 'connect',
      contact_id: h.contactId,
      conversation_id: h.conversationId,
      request_id: h.requestId,
      session: { sdp_type: 'offer', sdp: 'v=0\r\n' },
    }))
    expect(response.status).toBe(503)
    expect(h.rpc).toHaveBeenCalledWith('whatsapp_call_outbound_attempt_fail', expect.objectContaining({
      p_state: 'failed',
      p_failure_code: 'permission_lookup_failed',
    }))
    expect(h.callWhatsApp).not.toHaveBeenCalled()
  })

  it('does not reuse a failed idempotency key as if it were pending', async () => {
    h.attemptCreated = false
    h.attemptState = 'failed'
    const response = await POST(makeRequest({
      action: 'connect',
      contact_id: h.contactId,
      conversation_id: h.conversationId,
      request_id: h.requestId,
      session: { sdp_type: 'offer', sdp: 'v=0\r\n' },
    }))
    const data = await response.json()
    expect(response.status).toBe(409)
    expect(data.code).toBe('call_attempt_failed')
    expect(h.getPermission).not.toHaveBeenCalled()
    expect(h.callWhatsApp).not.toHaveBeenCalled()
  })

  it('starts one outbound call and persists the returned call_id and encrypted offer', async () => {
    const response = await POST(makeRequest({
      action: 'connect',
      contact_id: h.contactId,
      conversation_id: h.conversationId,
      request_id: h.requestId,
      session: { sdp_type: 'offer', sdp: 'v=0\r\n' },
    }))
    const data = await response.json()
    expect(response.status).toBe(201)
    expect(data).toMatchObject({
      success: true,
      call_id: 'wacid.qa-outbound',
      session_persisted: true,
    })
    expect(h.rpc).toHaveBeenCalledWith('whatsapp_call_outbound_attempt_begin', expect.objectContaining({
      p_request_id: h.requestId,
      p_agent_sdp_encrypted: 'encrypted:v=0\r\n',
    }))
    expect(h.callWhatsApp).toHaveBeenCalledWith(expect.objectContaining({
      phoneNumberId: h.phoneNumberId,
      action: expect.objectContaining({
        action: 'connect',
        to: '51980942247',
        bizOpaqueCallbackData: h.requestId,
        session: { sdp_type: 'offer', sdp: 'v=0\r\n' },
      }),
    }))
    expect(h.rpc).toHaveBeenCalledWith('whatsapp_call_outbound_attempt_complete', expect.objectContaining({
      p_request_id: h.requestId,
      p_call_id: 'wacid.qa-outbound',
      p_agent_sdp_encrypted: 'encrypted:v=0\r\n',
    }))
  })

  it('reuses a stored inbound SDP answer for accept instead of accepting a new SDP', async () => {
    h.session = {
      phone_number_id: h.phoneNumberId,
      call_id: 'wacid.qa-inbound',
      direction: 'USER_INITIATED',
      contact_id: h.contactId,
      conversation_id: h.conversationId,
      claimed_by_user_id: h.userId,
      claim_expires_at: new Date(Date.now() + 60000).toISOString(),
      initiated_by_user_id: null,
      accepted_by_user_id: null,
      rejected_by_user_id: null,
      ended_by_user_id: null,
      biz_opaque_callback_data: null,
      agent_sdp_encrypted: 'encrypted:stored-answer',
      agent_sdp_type: 'answer',
      agent_sdp_expires_at: new Date(Date.now() + 60000).toISOString(),
      state: 'ringing',
    }
    const response = await POST(makeRequest({
      action: 'accept',
      call_id: 'wacid.qa-inbound',
      session: { sdp_type: 'answer', sdp: 'different-client-answer' },
      conversation_id: h.conversationId,
    }))
    const data = await response.json()
    expect(response.status).toBe(200)
    expect(data).toMatchObject({ success: true, action: 'accept', agent_attribution_recorded: true })
    expect(h.callWhatsApp).toHaveBeenCalledWith(expect.objectContaining({
      action: {
        action: 'accept',
        callId: 'wacid.qa-inbound',
        session: { sdp_type: 'answer', sdp: 'stored-answer' },
      },
    }))
    expect(h.rpc).toHaveBeenCalledWith('whatsapp_call_session_agent_action', expect.objectContaining({
      p_action: 'accepted',
      p_actor_user_id: h.userId,
    }))
  })

  it('does not resend a request whose idempotency key is already pending', async () => {
    h.attemptCreated = false
    h.attemptState = 'pending'
    const response = await POST(makeRequest({
      action: 'connect',
      contact_id: h.contactId,
      conversation_id: h.conversationId,
      request_id: h.requestId,
      session: { sdp_type: 'offer', sdp: 'v=0\\r\\n' },
    }))
    expect(response.status).toBe(409)
    expect(h.callWhatsApp).not.toHaveBeenCalled()
  })

  it('marks a definite Meta 4xx rejection as failed, not unknown', async () => {
    h.callWhatsApp.mockRejectedValueOnce({ httpStatus: 400 })
    const response = await POST(makeRequest({
      action: 'connect',
      contact_id: h.contactId,
      conversation_id: h.conversationId,
      request_id: h.requestId,
      session: { sdp_type: 'offer', sdp: 'v=0\\r\\n' },
    }))
    expect(response.status).toBe(502)
    expect(h.rpc).toHaveBeenCalledWith('whatsapp_call_outbound_attempt_fail', expect.objectContaining({
      p_request_id: h.requestId,
      p_state: 'failed',
      p_failure_code: 'meta_request_rejected',
    }))
  })

  it('keeps a network-uncertain Meta outcome blocked from automatic retry', async () => {
    h.callWhatsApp.mockRejectedValueOnce(new Error('network timeout'))
    const response = await POST(makeRequest({
      action: 'connect',
      contact_id: h.contactId,
      conversation_id: h.conversationId,
      request_id: h.requestId,
      session: { sdp_type: 'offer', sdp: 'v=0\\r\\n' },
    }))
    expect(response.status).toBe(202)
    expect(h.rpc).toHaveBeenCalledWith('whatsapp_call_outbound_attempt_fail', expect.objectContaining({
      p_request_id: h.requestId,
      p_state: 'unknown',
      p_failure_code: 'meta_request_outcome_unknown',
    }))
  })

  it('does not send a second accept after Meta has already connected the call', async () => {
    h.session = {
      phone_number_id: h.phoneNumberId,
      call_id: 'wacid.qa-inbound',
      direction: 'USER_INITIATED',
      contact_id: h.contactId,
      conversation_id: h.conversationId,
      claimed_by_user_id: h.userId,
      claim_expires_at: new Date(Date.now() + 60000).toISOString(),
      initiated_by_user_id: null,
      accepted_by_user_id: null,
      rejected_by_user_id: null,
      ended_by_user_id: null,
      biz_opaque_callback_data: null,
      agent_sdp_encrypted: 'encrypted:stored-answer',
      agent_sdp_type: 'answer',
      agent_sdp_expires_at: new Date(Date.now() + 60000).toISOString(),
      state: 'connected',
    }
    const response = await POST(makeRequest({
      action: 'accept',
      call_id: 'wacid.qa-inbound',
      conversation_id: h.conversationId,
    }))
    expect(response.status).toBe(200)
    expect(h.callWhatsApp).not.toHaveBeenCalled()
    expect(h.rpc).toHaveBeenCalledWith('whatsapp_call_session_agent_action', expect.objectContaining({
      p_action: 'accepted',
      p_actor_user_id: h.userId,
    }))
  })

})


describe('WhatsApp Calling API trust boundary', () => {
  it('does not expose raw agent attribution writes to the browser', async () => {
    const response = await POST(makeRequest({
      action: 'agent_action',
      call_id: 'wacid.qa-inbound',
      agent_action: 'ended',
    }))
    expect(response.status).toBe(400)
    expect(h.callWhatsApp).not.toHaveBeenCalled()
  })
})
