import { afterEach, describe, expect, it, vi } from 'vitest'
import { callWhatsApp, getWhatsAppCallPermission, sendWhatsAppCallPermissionRequest, META_CALLING_API_VERSION } from './calling-api'

const BASE = {
  phoneNumberId: '740434745820831',
  accessToken: 'test-access-token',
  messagingAccountId: '123456789012345',
}

const OFFER = {
  sdp_type: 'offer' as const,
  sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n',
}

const ANSWER = {
  sdp_type: 'answer' as const,
  sdp: 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('callWhatsApp', () => {
  it('sends a business-initiated connect offer and returns Meta call ID', async () => {
    const captured: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      captured.push({ url, init })
      return new Response(JSON.stringify({
        messaging_product: 'whatsapp',
        calls: [{ id: 'wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh' }],
      }), { status: 200 })
    }))

    const result = await callWhatsApp({
      ...BASE,
      action: {
        action: 'connect',
        to: '+51980942247',
        session: OFFER,
        bizOpaqueCallbackData: 'call-test-01',
      },
    })

    expect(result).toEqual({
      action: 'connect',
      callId: 'wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh',
    })
    expect(captured[0]?.url).toBe(
      `https://graph.facebook.com/${META_CALLING_API_VERSION}/740434745820831/calls`,
    )
    expect(captured[0]?.init.method).toBe('POST')
    expect((captured[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer test-access-token')
    expect(JSON.parse(String(captured[0]?.init.body))).toEqual({
      messaging_product: 'whatsapp',
      messaging_account_id: '123456789012345',
      action: 'connect',
      to: '51980942247',
      session: OFFER,
      biz_opaque_callback_data: 'call-test-01',
    })
  })

  it('sends an answer for accept and returns success', async () => {
    let body: Record<string, unknown> | null = null
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ messaging_product: 'whatsapp', success: true }), { status: 200 })
    }))

    const result = await callWhatsApp({
      ...BASE,
      action: {
        action: 'accept',
        callId: 'wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh',
        session: ANSWER,
      },
    })

    expect(result).toEqual({ action: 'accept', success: true })
    expect(body).toMatchObject({
      messaging_product: 'whatsapp',
      action: 'accept',
      call_id: 'wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh',
      session: ANSWER,
    })
  })

  it.each(['pre_accept', 'reject', 'terminate'] as const)(
    'supports the %s signaling action',
    async (action) => {
      let body: Record<string, unknown> | null = null
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body))
        return new Response(JSON.stringify({ messaging_product: 'whatsapp', success: true }), { status: 200 })
      }))

      const callAction = action === 'pre_accept'
        ? { action, callId: 'wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh', session: ANSWER }
        : { action, callId: 'wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh' }

      await callWhatsApp({ ...BASE, action: callAction })
      expect(body).toMatchObject({
        action,
        call_id: 'wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh',
      })
      if (action === 'pre_accept') expect(body).toHaveProperty('session', ANSWER)
      else expect(body).not.toHaveProperty('session')
    },
  )

  it('rejects malformed recipients, call IDs and SDP before making a network request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(callWhatsApp({
      ...BASE,
      action: { action: 'connect', to: 'not-a-phone', session: OFFER },
    })).rejects.toThrow(/E.164/)

    await expect(callWhatsApp({
      ...BASE,
      phoneNumberId: 'invalid',
      action: { action: 'reject', callId: 'wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh' },
    })).rejects.toThrow(/phone_number_id/)

    await expect(callWhatsApp({
      ...BASE,
      action: { action: 'accept', callId: 'bad-id', session: ANSWER },
    })).rejects.toThrow(/call ID/)

    await expect(callWhatsApp({
      ...BASE,
      action: { action: 'accept', callId: 'wacid.valid', session: { sdp_type: 'answer', sdp: 'not-sdp' } },
    })).rejects.toThrow(/SDP answer/)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('preserves Meta error metadata without exposing the access token in the URL', async () => {
    let requestedUrl = ''
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requestedUrl = url
      return new Response(JSON.stringify({
        error: {
          message: 'Calling is not enabled for this number',
          code: 100,
          error_subcode: 138001,
          type: 'OAuthException',
          fbtrace_id: 'trace-call-test',
        },
      }), { status: 400, headers: { 'Retry-After': '10' } })
    }))

    await expect(callWhatsApp({
      ...BASE,
      action: { action: 'reject', callId: 'wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh' },
    })).rejects.toMatchObject({
      name: 'MetaApiError',
      message: 'Calling is not enabled for this number',
      code: 100,
      errorSubcode: 138001,
      httpStatus: 400,
      retryAfterSeconds: 10,
      fbtraceId: 'trace-call-test',
    })

    expect(requestedUrl).not.toContain('test-access-token')
  })

  it('does not accept a malformed successful response for connect', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ calls: [] }), { status: 200 })))

    await expect(callWhatsApp({
      ...BASE,
      action: { action: 'connect', to: '51980942247', session: OFFER },
    })).rejects.toThrow(/did not return a call ID/)
  })

  it('returns only confirmed success for non-connect actions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 200 })))

    await expect(callWhatsApp({
      ...BASE,
      action: { action: 'terminate', callId: 'wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh' },
    })).rejects.toThrow(/did not confirm/)
  })
})

describe('WhatsApp call permissions', () => {
  it('reads Meta permission state and action limits by BSUID', async () => {
    let requestedUrl = ''
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requestedUrl = url
      return new Response(JSON.stringify({
        permission: { status: 'temporary', expiration_time: 1795724800 },
        actions: [
          { action_name: 'start_call', can_perform_action: true, limits: [{ time_period: 'PT24H', max_allowed: 100, current_usage: 1 }] },
          { action_name: 'send_call_permission_request', can_perform_action: false, limits: [{ time_period: 'P7D', max_allowed: 2, current_usage: 2 }] },
        ],
      }), { status: 200 })
    }))
    const result = await getWhatsAppCallPermission({
      phoneNumberId: BASE.phoneNumberId,
      accessToken: BASE.accessToken,
      recipient: 'PE.123456789',
    })
    expect(requestedUrl).toContain('/740434745820831/call_permissions?recipient=PE.123456789')
    expect(result).toMatchObject({
      status: 'temporary',
      expirationTime: 1795724800,
      canStartCall: true,
      canRequestPermission: false,
      actions: [
        { actionName: 'start_call', canPerformAction: true, limits: [{ timePeriod: 'PT24H', maxAllowed: 100, currentUsage: 1 }] },
        { actionName: 'send_call_permission_request', canPerformAction: false, limits: [{ timePeriod: 'P7D', maxAllowed: 2, currentUsage: 2 }] },
      ],
    })
  })

  it("sends the free-form permission request with Meta's interactive payload", async () => {
    const captured: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      captured.push({ url, init })
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.permission-request' }] }), { status: 200 })
    }))
    const result = await sendWhatsAppCallPermissionRequest({
      phoneNumberId: BASE.phoneNumberId,
      accessToken: BASE.accessToken,
      messagingAccountId: '123456789012345',
      userWaId: '+51911111111',
      bodyText: '¿Nos autorizas a llamarte para ayudarte con tu consulta?',
    })
    expect(result).toEqual({ messageId: 'wamid.permission-request' })
    expect(captured[0]?.url).toBe(`https://graph.facebook.com/${META_CALLING_API_VERSION}/740434745820831/messages`)
    expect(JSON.parse(String(captured[0]?.init.body))).toMatchObject({
      messaging_product: 'whatsapp',
      messaging_account_id: '123456789012345',
      to: '51911111111',
      type: 'interactive',
      interactive: {
        type: 'call_permission_request',
        action: { name: 'call_permission_request' },
        body: { text: '¿Nos autorizas a llamarte para ayudarte con tu consulta?' },
      },
    })
  })

  it('rejects ambiguous permission targets before contacting Meta', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const target = {
      phoneNumberId: BASE.phoneNumberId,
      accessToken: BASE.accessToken,
      userWaId: '51911111111',
      recipient: 'PE.123456789',
    }
    await expect(getWhatsAppCallPermission(target)).rejects.toThrow(/exactly one/)
    await expect(sendWhatsAppCallPermissionRequest(target)).rejects.toThrow(/exactly one/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails closed when Meta does not provide a recognized permission state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ permission: { status: 'unknown' } }), { status: 200 })))
    await expect(getWhatsAppCallPermission({
      phoneNumberId: BASE.phoneNumberId,
      accessToken: BASE.accessToken,
      userWaId: '51911111111',
    })).rejects.toThrow(/unknown WhatsApp call permission/)
  })
})
