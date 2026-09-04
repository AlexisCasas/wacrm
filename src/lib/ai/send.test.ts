import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  resolveOutboundTransport: vi.fn(),
  sendManyChatTextToContact: vi.fn(),
  engineSendText: vi.fn(),
  state: {
    insertCalls: [] as Record<string, unknown>[],
    insertError: null as { message: string } | null,
    conversationUpdateCalls: [] as Record<string, unknown>[],
  },
}))

vi.mock('@/lib/whatsapp/send-message', () => ({
  resolveOutboundTransport: h.resolveOutboundTransport,
}))

// Keep the real error classes (`instanceof` checks in send.ts depend on
// them) — mock only the network-touching function.
vi.mock('@/lib/manychat/contact-send', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendManyChatTextToContact: h.sendManyChatTextToContact,
}))

vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: h.engineSendText,
}))

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      if (table === 'messages') {
        return {
          insert: (row: Record<string, unknown>) => {
            h.state.insertCalls.push(row)
            return Promise.resolve({ error: h.state.insertError })
          },
        }
      }
      if (table === 'conversations') {
        return {
          update: (row: Record<string, unknown>) => {
            h.state.conversationUpdateCalls.push(row)
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
      }
      // Proves flow_runs (or anything else) is never touched by the AI
      // ManyChat send path — reaching this is a test failure.
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

import { sendAiTextToConversation } from './send'
import {
  ManyChatNotConfiguredError,
  ManyChatContactNotLinkedError,
} from '@/lib/manychat/contact-send'
import { ManyChatApiError } from '@/lib/manychat/api'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  text: 'Hola! ¿En qué puedo ayudarte?',
  configOwnerUserId: 'user-1',
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.insertCalls = []
  h.state.insertError = null
  h.state.conversationUpdateCalls = []
  h.resolveOutboundTransport.mockReturnValue('meta')
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'wamid.ai1' })
  h.sendManyChatTextToContact.mockResolvedValue({
    whatsappMessageId: 'manychat-out:abc-123',
  })
})

describe('sendAiTextToConversation — transport=manychat', () => {
  beforeEach(() => {
    h.resolveOutboundTransport.mockReturnValue('manychat')
  })

  it('sends via the ManyChat transport primitive, never Meta', async () => {
    await sendAiTextToConversation(ARGS)
    expect(h.sendManyChatTextToContact).toHaveBeenCalledWith({
      db: expect.anything(),
      accountId: 'acct-1',
      contactId: 'contact-1',
      text: ARGS.text,
    })
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('persists exactly one message row on success', async () => {
    await sendAiTextToConversation(ARGS)
    expect(h.state.insertCalls).toHaveLength(1)
  })

  it("persists sender_type='bot', content_type='text', status='sent', ai_generated=true", async () => {
    await sendAiTextToConversation(ARGS)
    expect(h.state.insertCalls[0]).toMatchObject({
      conversation_id: 'conv-1',
      sender_type: 'bot',
      content_type: 'text',
      content_text: ARGS.text,
      status: 'sent',
      ai_generated: true,
    })
  })

  it('uses the transport-returned message id — never a fabricated wamid', async () => {
    await sendAiTextToConversation(ARGS)
    expect(h.state.insertCalls[0].message_id).toBe('manychat-out:abc-123')
    expect(String(h.state.insertCalls[0].message_id)).not.toMatch(/^wamid\./)
  })

  it('updates last_message_text and last_message_at', async () => {
    await sendAiTextToConversation(ARGS)
    expect(h.state.conversationUpdateCalls).toHaveLength(1)
    expect(h.state.conversationUpdateCalls[0]).toMatchObject({
      last_message_text: ARGS.text,
    })
    expect(h.state.conversationUpdateCalls[0].last_message_at).toBeTruthy()
  })

  it('never touches flow_runs (no pause-on-agent-send for an AI reply)', async () => {
    // The fake admin-client throws on any table other than
    // messages/conversations — a successful resolve proves this.
    await expect(sendAiTextToConversation(ARGS)).resolves.toBeDefined()
  })

  it('does not persist when the mapping is missing (no send, no fallback)', async () => {
    h.sendManyChatTextToContact.mockRejectedValue(
      new ManyChatContactNotLinkedError('not linked yet'),
    )
    await expect(sendAiTextToConversation(ARGS)).rejects.toBeInstanceOf(
      ManyChatContactNotLinkedError,
    )
    expect(h.state.insertCalls).toHaveLength(0)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not persist when MANYCHAT_API_KEY is missing (no send, no fallback)', async () => {
    h.sendManyChatTextToContact.mockRejectedValue(
      new ManyChatNotConfiguredError('MANYCHAT_API_KEY missing'),
    )
    await expect(sendAiTextToConversation(ARGS)).rejects.toBeInstanceOf(
      ManyChatNotConfiguredError,
    )
    expect(h.state.insertCalls).toHaveLength(0)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it.each([401, 403, 429, 500])(
    'does not persist a message when ManyChat responds %i',
    async (status) => {
      h.sendManyChatTextToContact.mockRejectedValue(
        new ManyChatApiError(status, `ManyChat error ${status}`),
      )
      await expect(sendAiTextToConversation(ARGS)).rejects.toMatchObject({ status })
      expect(h.state.insertCalls).toHaveLength(0)
      expect(h.engineSendText).not.toHaveBeenCalled()
    },
  )

  it('does not persist on a ManyChat timeout (504)', async () => {
    h.sendManyChatTextToContact.mockRejectedValue(
      new ManyChatApiError(504, 'ManyChat request timed out after 10000ms'),
    )
    await expect(sendAiTextToConversation(ARGS)).rejects.toMatchObject({ status: 504 })
    expect(h.state.insertCalls).toHaveLength(0)
  })

  it('does not persist when ManyChat 200s but status != "success" (502 from the client)', async () => {
    h.sendManyChatTextToContact.mockRejectedValue(
      new ManyChatApiError(502, 'ManyChat returned HTTP 200 but did not confirm success'),
    )
    await expect(sendAiTextToConversation(ARGS)).rejects.toMatchObject({ status: 502 })
    expect(h.state.insertCalls).toHaveLength(0)
  })

  it('does not swallow a DB insert failure — throws rather than silently dropping the reply', async () => {
    h.state.insertError = { message: 'constraint violation' }
    await expect(sendAiTextToConversation(ARGS)).rejects.toThrow()
  })

  it('never logs MANYCHAT_API_KEY on a ManyChat failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.sendManyChatTextToContact.mockRejectedValue(
      new ManyChatApiError(401, 'unauthorized — invalid token'),
    )
    await sendAiTextToConversation(ARGS).catch(() => {})
    const logged = errorSpy.mock.calls
      .flat()
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join('\n')
    expect(logged).not.toContain('mc-key-test')
    errorSpy.mockRestore()
  })
})

describe('sendAiTextToConversation — transport=meta (unchanged behavior)', () => {
  beforeEach(() => {
    h.resolveOutboundTransport.mockReturnValue('meta')
  })

  it('delegates to engineSendText with aiGenerated: true, exactly as before', async () => {
    await sendAiTextToConversation(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith({
      accountId: 'acct-1',
      userId: 'user-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      text: ARGS.text,
      aiGenerated: true,
    })
  })

  it('never touches the ManyChat transport primitive', async () => {
    await sendAiTextToConversation(ARGS)
    expect(h.sendManyChatTextToContact).not.toHaveBeenCalled()
  })

  it('returns engineSendText\'s result untouched', async () => {
    const result = await sendAiTextToConversation(ARGS)
    expect(result).toEqual({ whatsapp_message_id: 'wamid.ai1' })
  })

  it('propagates an engineSendText failure (e.g. Meta rejects the send)', async () => {
    h.engineSendText.mockRejectedValue(new Error('Meta API error: 400'))
    await expect(sendAiTextToConversation(ARGS)).rejects.toThrow('Meta API error: 400')
  })
})
