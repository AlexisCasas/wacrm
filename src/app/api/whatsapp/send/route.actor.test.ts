import { beforeEach, describe, expect, it, vi } from 'vitest'

// The dashboard send route must hand the send core the VERIFIED person (from requireRole), as `origin: 'manual_reply'`, and must never take
// either from the request body — otherwise any caller could claim to be a person replying from the Inbox.
const h = vi.hoisted(() => ({ send: vi.fn(), role: 'agent' as string }))

vi.mock('@/lib/auth/account', async () => {
  class ForbiddenError extends Error { readonly status = 403 as const }
  return {
    ForbiddenError,
    requireRole: async () => {
      if (h.role === 'viewer') throw new ForbiddenError("This action requires the 'agent' role or higher")
      return { supabase: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { id: 'conv-1' }, error: null }) }) }) }) }) }, accountId: 'acct-1', userId: 'user-from-session', role: h.role }
    },
    toErrorResponse: (e: { status?: number; message?: string }) => new Response(JSON.stringify({ error: e.message }), { status: e.status ?? 500 }),
  }
})
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => ({ success: true }), rateLimitResponse: () => new Response('rl', { status: 429 }), RATE_LIMITS: { send: {} } }))
vi.mock('@/lib/whatsapp/send-message', async (orig) => ({ ...(await orig<object>()), sendMessageToConversation: h.send }))

import { POST } from './route'

const post = (body: Record<string, unknown>) => POST(new Request('http://x/api/whatsapp/send', { method: 'POST', body: JSON.stringify(body) }))

beforeEach(() => { h.send.mockReset(); h.send.mockResolvedValue({ messageId: 'm1', whatsappMessageId: 'wamid.X' }); h.role = 'agent' })

describe('POST /api/whatsapp/send — who is sending', () => {
  it('passes origin manual_reply and the session user as the actor', async () => {
    const res = await post({ conversation_id: 'conv-1', message_type: 'text', content_text: 'hola' })
    expect(res.status).toBe(200)
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.send.mock.calls[0][2]).toMatchObject({ origin: 'manual_reply', actor: { userId: 'user-from-session' } })
  })
  it('ignores an actor / origin / userId supplied in the request body', async () => {
    await post({ conversation_id: 'conv-1', message_type: 'text', content_text: 'hola', actor: { userId: 'someone-else' }, origin: 'automated', userId: 'someone-else', user_id: 'someone-else' })
    expect(h.send.mock.calls[0][2]).toMatchObject({ origin: 'manual_reply', actor: { userId: 'user-from-session' } })
  })
  it('a viewer is refused with 403 before the send core is reached', async () => {
    h.role = 'viewer'
    const res = await post({ conversation_id: 'conv-1', message_type: 'text', content_text: 'hola' })
    expect(res.status).toBe(403)
    expect(h.send).not.toHaveBeenCalled()
  })
  it('a blocked BSUID send comes back as an error status, never as success', async () => {
    const { SendMessageError } = await import('@/lib/whatsapp/send-message')
    h.send.mockRejectedValue(new SendMessageError('bsuid_send_blocked', 'restricted (bsuid_not_authorized).', 403))
    const res = await post({ conversation_id: 'conv-1', message_type: 'text', content_text: 'hola' })
    expect(res.status).toBe(403)
    expect((await res.json() as { success?: boolean }).success).toBeUndefined()
  })
})
