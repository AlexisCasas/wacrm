import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    updateCalls: [] as Record<string, unknown>[],
    rpcCalls: [] as { name: string; args: unknown }[],
    /** Set to simulate a real Supabase UPDATE failure on `conversations`
     *  — resolved as `{ error }`, never thrown, matching how Supabase
     *  actually reports it. */
    handoffUpdateError: null as { message: string } | null,
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      // conversations
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          h.state.updateCalls.push(payload)
          return {
            eq: () =>
              Promise.resolve({ error: h.state.handoffUpdateError }),
          }
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    embeddingsProvider: null,
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.autoResponders = []
  h.state.claim = true
  h.state.updatePayload = null
  h.state.updateCalls = []
  h.state.rpcCalls = []
  h.state.handoffUpdateError = null
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    // Exact args, not just a partial match — proves accountId,
    // conversationId, contactId, and configOwnerUserId all flow through
    // dispatchInboundToAiReply → sendAiTextToConversation → the Meta
    // sender unchanged, and that aiGenerated is always set.
    expect(h.engineSendText).toHaveBeenCalledWith({
      accountId: 'acct-1',
      userId: 'user-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      text: 'Hello!',
      aiGenerated: true,
    })
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('suppressWhenAutomationsActive: true (explicit) behaves identically to the default — native Meta webhook call shape, unchanged', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply({ ...ARGS, suppressWhenAutomationsActive: true })
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('suppressWhenAutomationsActive: false skips the automations check entirely and continues to send (ManyChat bridge)', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply({ ...ARGS, suppressWhenAutomationsActive: false })
    expect(h.generateReply).toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalled()
  })

  it('the native/default call shape (no suppressWhenAutomationsActive arg at all) is unaffected by this change', async () => {
    // ARGS never sets the new field — proves the Meta webhook's
    // existing call site (which never passes it) keeps suppressing on
    // an active automation without needing any code change there.
    expect(ARGS).not.toHaveProperty('suppressWhenAutomationsActive')
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff (model chose to hand off, or returned no text)', () => {
  // Test #1 / #2: conversation disabled + summary written.
  it('disables auto-reply and writes a summary', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  // Test #3: customer notice sent — via the exact same transport-aware
  // sender as a normal reply (Meta in this test's default env), never a
  // second/bespoke send path.
  it('sends the deterministic customer handoff notice', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        contactId: 'contact-1',
        text: 'Para ayudarte correctamente con esta consulta, voy a derivarte con uno de nuestros asesores. En breve continuarán la atención contigo por este medio.',
        aiGenerated: true,
      }),
    )
    // Never the model's own (empty/rejected) text.
    expect(h.engineSendText).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: '' }),
    )
  })

  // Test #4 + #5: the notice is not a counted auto-reply.
  it('does not claim a reply slot or increment ai_reply_count for the notice', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toHaveLength(0) // claim_ai_reply_slot never called
    expect(h.state.updatePayload).not.toHaveProperty('ai_reply_count')
  })

  // Test #6 + #7: a failed notice send does not undo the handoff, and is
  // never retried within this dispatch.
  it('keeps the handoff persisted and logs (without retrying) when the notice send fails', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    h.engineSendText.mockRejectedValue(new Error('Meta API error: 500'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(dispatchInboundToAiReply(ARGS)).resolves.toBeUndefined()

    // Handoff state committed BEFORE the send attempt — unaffected by
    // its failure.
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
    })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    // Exactly one send attempt — no automatic retry.
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    // The failure was logged, not swallowed silently.
    expect(
      errorSpy.mock.calls.some((c) =>
        String(c[0]).includes('handoff notice failed to send'),
      ),
    ).toBe(true)
    errorSpy.mockRestore()
  })

  // Test #8: configured handoff agent still assigned.
  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })

  // Test #9: no configured agent → conversation stays unassigned (shared
  // queue), already asserted above via `not.toHaveProperty`, restated
  // explicitly for the requirement's own sake.
  it('leaves the conversation in the shared queue when no handoff agent is configured', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })
})

describe('dispatchInboundToAiReply — reply cap reached also hands off (not a silent no-op)', () => {
  function capConv(overrides: Record<string, unknown> = {}) {
    return {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
      ...overrides,
    }
  }

  // Test #10: no Gemini generation when the cap is already reached.
  it('never calls generateReply when the cap is already reached', async () => {
    h.state.conv = capConv()
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.retrieveKnowledge).not.toHaveBeenCalled()
  })

  // Test #11: handoff state written.
  it('writes the handoff state (disabled + a cap-specific summary)', async () => {
    h.state.conv = capConv()
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'reaching the 3-reply limit',
    )
  })

  // Test #12: the same customer notice is sent.
  it('sends the customer handoff notice', async () => {
    h.state.conv = capConv()
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Para ayudarte correctamente con esta consulta, voy a derivarte con uno de nuestros asesores. En breve continuarán la atención contigo por este medio.',
      }),
    )
  })

  // Test #13: reply count itself is never touched by the handoff path.
  it('never claims a slot or increments ai_reply_count', async () => {
    h.state.conv = capConv()
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).not.toHaveProperty('ai_reply_count')
  })

  // Test #14: idempotent — a conversation already disabled (e.g. a prior
  // inbound already ran the cap-handoff above) never gets a duplicate
  // notice; the top-of-function eligibility gate short-circuits first.
  it('does not send a duplicate notice when the conversation is already disabled', async () => {
    h.state.conv = capConv({ ai_autoreply_disabled: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toBeNull()
  })

  it('routes to the configured handoff agent on a cap handoff too', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.state.conv = capConv()
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({ assigned_agent_id: 'agent-7' })
  })

  it('never stomps an existing human assignment on a cap handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    // assigned_agent_id set → the top-level eligibility gate ("a human
    // owns this thread") returns before the cap is even evaluated.
    h.state.conv = capConv({ assigned_agent_id: 'agent-existing' })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// handOffConversation() fail-safe: Supabase can resolve `{ error }` on the
// handoff UPDATE WITHOUT throwing — the code must never assume persistence
// just because the `await` settled. The mock below simulates exactly that
// shape (a resolved `{ error: { message } }`, never a rejection), on BOTH
// handoff entry points (model handoff and cap-reached handoff), so this
// isn't a superficial check of one code path.
// ---------------------------------------------------------------------------
describe('handOffConversation — the handoff UPDATE can fail without throwing (Supabase { error } shape)', () => {
  function capConv(overrides: Record<string, unknown> = {}) {
    return {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
      ...overrides,
    }
  }

  // Test #1: success → the notice IS attempted. (Also proves the happy
  // path still works with the new error-checked update.)
  it('on the model-handoff path: a successful UPDATE still sends the customer notice', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updateCalls).toHaveLength(1)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Para ayudarte correctamente con esta consulta, voy a derivarte con uno de nuestros asesores. En breve continuarán la atención contigo por este medio.',
      }),
    )
  })

  it('on the cap-reached path: a successful UPDATE still sends the customer notice', async () => {
    h.state.conv = capConv()
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updateCalls).toHaveLength(1)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Para ayudarte correctamente con esta consulta, voy a derivarte con uno de nuestros asesores. En breve continuarán la atención contigo por este medio.',
      }),
    )
  })

  // Test #2: a real UPDATE failure → the notice is NEVER sent, on either
  // handoff entry point.
  it('on the model-handoff path: a failed UPDATE never sends the customer notice', async () => {
    h.state.handoffUpdateError = { message: 'permission denied for table conversations' }
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(dispatchInboundToAiReply(ARGS)).resolves.toBeUndefined()

    expect(h.state.updateCalls).toHaveLength(1) // the UPDATE was attempted
    expect(h.engineSendText).not.toHaveBeenCalled() // but never the notice
    errorSpy.mockRestore()
  })

  it('on the cap-reached path: a failed UPDATE never sends the customer notice', async () => {
    h.state.handoffUpdateError = { message: 'permission denied for table conversations' }
    h.state.conv = capConv()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(dispatchInboundToAiReply(ARGS)).resolves.toBeUndefined()

    expect(h.state.updateCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  // Test #3: a failed UPDATE never claims a reply slot either — the
  // dispatch must abort entirely, not fall through to a normal reply.
  it('a failed handoff UPDATE never calls claim_ai_reply_slot', async () => {
    h.state.handoffUpdateError = { message: 'permission denied for table conversations' }
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await dispatchInboundToAiReply(ARGS)

    expect(h.state.rpcCalls).toHaveLength(0)
  })

  // Test #4: the failure is logged once, with a safe message (no raw
  // Supabase error object, no secrets) — and doesn't trigger a second
  // attempt within this same dispatch.
  it('logs a safe message exactly once and never retries within the same dispatch', async () => {
    h.state.handoffUpdateError = { message: 'permission denied for table conversations' }
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await dispatchInboundToAiReply(ARGS)

    expect(h.state.updateCalls).toHaveLength(1) // exactly one attempt — no retry
    const handoffLogs = errorSpy.mock.calls.filter((c) =>
      String(c[0]).includes('failed to persist handoff'),
    )
    expect(handoffLogs).toHaveLength(1)
    // Safe: the human-readable reason may appear, but nothing beyond
    // what the fixed log call itself passes — no leaked request body,
    // no stray secrets.
    const loggedText = handoffLogs[0].map(String).join(' ')
    expect(loggedText).toContain('[ai auto-reply] failed to persist handoff:')
    errorSpy.mockRestore()
  })

  // Test #5: the ALREADY-COVERED "notice fails after a successful
  // persist" behavior stays green under the new error-checked update —
  // proving this fix didn't regress the previously-approved fail-safe
  // path (handoff persisted, notice failed, no retry, no rollback).
  it('notice failure AFTER a successful persist: handoff stays persisted, no retry, existing behavior unchanged', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    h.engineSendText.mockRejectedValue(new Error('Meta API error: 500'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(dispatchInboundToAiReply(ARGS)).resolves.toBeUndefined()

    // The UPDATE succeeded (no handoffUpdateError set) and was attempted
    // exactly once — the handoff itself is persisted.
    expect(h.state.updateCalls).toHaveLength(1)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    // Exactly one send attempt — no automatic retry.
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(
      errorSpy.mock.calls.some((c) =>
        String(c[0]).includes('handoff notice failed to send'),
      ),
    ).toBe(true)
    // And the new persistence-failure log path was NOT hit — this is a
    // notice failure, not a persist failure.
    expect(
      errorSpy.mock.calls.some((c) => String(c[0]).includes('failed to persist handoff')),
    ).toBe(false)
    errorSpy.mockRestore()
  })
})

// Test #16: ManyChat transport behavior is unchanged — `handOffConversation`
// sends the notice through the exact same `sendAiTextToConversation` the
// normal reply already uses, and `src/lib/ai/send.ts` (the module owning
// all ManyChat-vs-Meta branching) is untouched by this feature. The full
// ManyChat-transport contract (mapping lookup, no-fallback-to-Meta,
// persist-only-after-confirm, sender_type='bot', never touching
// flow_runs) is exhaustively covered by send.test.ts, which is unaffected
// by these changes and still passes unchanged.
