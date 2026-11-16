import { beforeEach, describe, expect, it, vi } from 'vitest'

// Comercial -> Logistica handoff, server side of /api/whatsapp/send. The decision belongs to the database function
// conversation_operational_access (also enforced by RLS); the route asks it BEFORE anything is read or sent to Meta.
const h = vi.hoisted(() => ({
  send: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
}))

vi.mock('@/lib/auth/account', async () => {
  class ForbiddenError extends Error {
    readonly status = 403 as const
  }
  return {
    ForbiddenError,
    requireRole: async () => ({
      supabase: {
        rpc: h.rpc,
        from: (t: string) => {
          h.from(t)
          return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { id: 'conv-1' }, error: null }) }) }) }) }
        },
      },
      accountId: 'acct-1',
      userId: 'user-1',
      role: 'agent',
    }),
    toErrorResponse: (e: { status?: number; message?: string }) => new Response(JSON.stringify({ error: e.message }), { status: e.status ?? 500 }),
  }
})
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => ({ success: true }), rateLimitResponse: () => new Response('rl', { status: 429 }), RATE_LIMITS: { send: {} } }))
vi.mock('@/lib/whatsapp/send-message', async (orig) => ({ ...(await orig<object>()), sendMessageToConversation: h.send }))

import { POST } from './route'

const post = (body: Record<string, unknown>) => POST(new Request('http://x/api/whatsapp/send', { method: 'POST', body: JSON.stringify(body) }))
const text = { conversation_id: 'conv-1', message_type: 'text', content_text: 'hola' }

beforeEach(() => {
  h.send.mockReset()
  h.send.mockResolvedValue({ messageId: 'm1', whatsappMessageId: 'wamid.X' })
  h.rpc.mockReset()
  h.rpc.mockResolvedValue({ data: true, error: null })
  h.from.mockReset()
})

describe('POST /api/whatsapp/send: conversation stage (handoff)', () => {
  it('asks the database function with the SESSION account and the conversation, and sends when allowed (commercial PRE / logistics POST / supervisor / flag OFF)', async () => {
    const res = await post(text)
    expect(res.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledWith('conversation_operational_access', { p_account_id: 'acct-1', p_conversation_id: 'conv-1' })
    expect(h.send).toHaveBeenCalledTimes(1)
  })

  it('commercial on a confirmed (POST) conversation, or logistics on a PRE one: 403, nothing read, nothing sent to Meta', async () => {
    h.rpc.mockResolvedValue({ data: false, error: null })
    const res = await post(text)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/operational area/)
    expect(h.send).not.toHaveBeenCalled()
    expect(h.from).not.toHaveBeenCalled()
  })

  it('an account_id sent by the browser is never the authority', async () => {
    await post({ ...text, account_id: 'other-account' })
    expect(h.rpc).toHaveBeenCalledWith('conversation_operational_access', { p_account_id: 'acct-1', p_conversation_id: 'conv-1' })
  })

  it('a database without the function yet (migration pending) behaves as before', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: '42883', message: 'function does not exist' } })
    expect((await post(text)).status).toBe(200)
    h.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'not in schema cache' } })
    expect((await post(text)).status).toBe(200)
  })

  it('any other failure of the check fails closed', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'boom' } })
    const res = await post(text)
    expect(res.status).toBe(403)
    expect(h.send).not.toHaveBeenCalled()
  })
})
