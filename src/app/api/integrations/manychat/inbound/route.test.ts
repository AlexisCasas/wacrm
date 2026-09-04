import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const h = vi.hoisted(() => ({
  findOrCreateContact: vi.fn(),
  findOrCreateConversation: vi.fn(),
  reopenClosedConversation: vi.fn(),
  dispatchInboundToAiReply: vi.fn(),
  state: {
    configRow: { account_id: 'acc-1', user_id: 'user-1' } as
      | { account_id: string; user_id: string }
      | null,
    configError: null as { message: string } | null,
    /** Result the message upsert's .select() resolves to. */
    messageUpsertResult: [{ id: 'msg-1' }] as { id: string }[],
    messageUpsertError: null as { message: string } | null,
    upsertCalls: [] as { row: Record<string, unknown>; options: unknown }[],
    rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
    linkUpsertCalls: [] as { row: Record<string, unknown>; options: unknown }[],
    linkUpsertError: null as { message: string } | null,
    /** Callbacks registered via after() — drain explicitly in a test to simulate post-response work. */
    afterCallbacks: [] as (() => Promise<void> | void)[],
  },
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    }),
  },
  after: (cb: () => Promise<void> | void) => {
    h.state.afterCallbacks.push(cb)
  },
}))

vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: h.dispatchInboundToAiReply,
}))

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      switch (table) {
        case 'whatsapp_config':
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: h.state.configRow,
                    error: h.state.configError,
                  }),
              }),
            }),
          }
        case 'messages':
          return {
            upsert: (row: Record<string, unknown>, options: unknown) => {
              h.state.upsertCalls.push({ row, options })
              return {
                select: () =>
                  Promise.resolve({
                    data: h.state.messageUpsertError ? null : h.state.messageUpsertResult,
                    error: h.state.messageUpsertError,
                  }),
              }
            },
          }
        case 'manychat_contact_links':
          return {
            upsert: (row: Record<string, unknown>, options: unknown) => {
              h.state.linkUpsertCalls.push({ row, options })
              return Promise.resolve({ data: null, error: h.state.linkUpsertError })
            },
          }
        default:
          throw new Error(`unexpected table: ${table}`)
      }
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: null, error: null })
    },
  }),
}))

vi.mock('@/lib/contacts/find-or-create', () => ({
  findOrCreateContact: h.findOrCreateContact,
}))
vi.mock('@/lib/conversations/find-or-create', () => ({
  findOrCreateConversation: h.findOrCreateConversation,
}))
vi.mock('@/lib/conversations/reopen', () => ({
  reopenClosedConversation: h.reopenClosedConversation,
}))

import { POST } from './route'

const VALID_SECRET = 'test-manychat-secret'
const VALID_ACCOUNT_ID = 'acc-1'

function inboundRequest(
  body: unknown,
  opts: { auth?: string | null; rawText?: string } = {},
): Request {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (opts.auth !== null) {
    headers.set('authorization', opts.auth ?? `Bearer ${VALID_SECRET}`)
  }
  return new Request('https://crm.example.com/api/integrations/manychat/inbound', {
    method: 'POST',
    headers,
    body: opts.rawText ?? JSON.stringify(body),
  })
}

const VALID_PAYLOAD = {
  contact_id: 'mc-contact-1',
  whatsapp_id: '+1 (555) 123-0000',
  full_name: 'Ada Lovelace',
  text: 'Hola, tengo una pregunta',
  last_interaction: '2026-01-01T12:00:00.000Z',
}

/** Runs every after() callback registered so far, exactly as the runtime would post-response. */
async function drainAfterCallbacks() {
  for (const cb of h.state.afterCallbacks) await cb()
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.MANYCHAT_INGEST_SECRET = VALID_SECRET
  process.env.MANYCHAT_INGEST_ACCOUNT_ID = VALID_ACCOUNT_ID
  h.state.configRow = { account_id: 'acc-1', user_id: 'user-1' }
  h.state.configError = null
  h.state.messageUpsertResult = [{ id: 'msg-1' }]
  h.state.messageUpsertError = null
  h.state.upsertCalls = []
  h.state.rpcCalls = []
  h.state.linkUpsertCalls = []
  h.state.linkUpsertError = null
  h.state.afterCallbacks = []
  h.findOrCreateContact.mockResolvedValue({
    contact: { id: 'contact-1', name: 'Ada Lovelace', phone: '15551230000' },
    wasCreated: false,
  })
  h.findOrCreateConversation.mockResolvedValue({
    conversation: { id: 'conv-1', status: 'open', account_id: 'acc-1' },
    created: false,
  })
  h.reopenClosedConversation.mockResolvedValue(false)
  h.dispatchInboundToAiReply.mockResolvedValue(undefined)
})

afterEach(() => {
  delete process.env.MANYCHAT_INGEST_SECRET
  delete process.env.MANYCHAT_INGEST_ACCOUNT_ID
  delete process.env.MANYCHAT_AI_AUTOREPLY_ENABLED
})

describe('auth', () => {
  it('503s when the bridge has no secret configured', async () => {
    delete process.env.MANYCHAT_INGEST_SECRET
    const res = await POST(inboundRequest(VALID_PAYLOAD))
    expect(res.status).toBe(503)
    expect(h.findOrCreateContact).not.toHaveBeenCalled()
  })

  it('503s when the bridge has no account id configured', async () => {
    delete process.env.MANYCHAT_INGEST_ACCOUNT_ID
    const res = await POST(inboundRequest(VALID_PAYLOAD))
    expect(res.status).toBe(503)
  })

  it('401s when the Authorization header is missing', async () => {
    const res = await POST(inboundRequest(VALID_PAYLOAD, { auth: null }))
    expect(res.status).toBe(401)
    expect(h.findOrCreateContact).not.toHaveBeenCalled()
  })

  it('401s when the bearer secret is wrong', async () => {
    const res = await POST(inboundRequest(VALID_PAYLOAD, { auth: 'Bearer wrong-secret' }))
    expect(res.status).toBe(401)
  })

  it('401s on a non-Bearer Authorization header', async () => {
    const res = await POST(inboundRequest(VALID_PAYLOAD, { auth: `Basic ${VALID_SECRET}` }))
    expect(res.status).toBe(401)
  })

  it('accepts the request with no user session / cookies at all', async () => {
    const res = await POST(inboundRequest(VALID_PAYLOAD))
    expect(res.status).toBe(201)
  })

  // timingSafeEqual (node:crypto) throws RangeError on a buffer-length
  // mismatch rather than returning false — the route must never let a
  // supplied secret of a different length than MANYCHAT_INGEST_SECRET
  // reach it directly. Exercise both directions so a regression that
  // removes the length pre-check surfaces as an unhandled rejection
  // here instead of a 500 in production.
  it('does not throw when the supplied secret is shorter than the configured one', async () => {
    await expect(
      POST(inboundRequest(VALID_PAYLOAD, { auth: 'Bearer x' })),
    ).resolves.toMatchObject({ status: 401 })
  })

  it('does not throw when the supplied secret is longer than the configured one', async () => {
    await expect(
      POST(inboundRequest(VALID_PAYLOAD, { auth: `Bearer ${VALID_SECRET}${'x'.repeat(500)}` })),
    ).resolves.toMatchObject({ status: 401 })
  })

  it('does not throw on an empty bearer token', async () => {
    await expect(
      POST(inboundRequest(VALID_PAYLOAD, { auth: 'Bearer ' })),
    ).resolves.toMatchObject({ status: 401 })
  })
})

describe('payload validation', () => {
  it('400s on invalid JSON', async () => {
    const res = await POST(
      inboundRequest(null, { rawText: '{not json' }),
    )
    expect(res.status).toBe(400)
  })

  it.each([
    ['missing contact_id', { ...VALID_PAYLOAD, contact_id: undefined }],
    ['empty contact_id', { ...VALID_PAYLOAD, contact_id: '   ' }],
    ['missing whatsapp_id', { ...VALID_PAYLOAD, whatsapp_id: undefined }],
    ['missing text', { ...VALID_PAYLOAD, text: undefined }],
    ['empty text', { ...VALID_PAYLOAD, text: '' }],
    ['wrong type for text', { ...VALID_PAYLOAD, text: 12345 }],
    ['text over the size limit', { ...VALID_PAYLOAD, text: 'x'.repeat(8001) }],
    ['full_name wrong type', { ...VALID_PAYLOAD, full_name: 42 }],
    ['whatsapp_id has no digits', { ...VALID_PAYLOAD, whatsapp_id: 'abc' }],
  ])('400s on %s', async (_label, payload) => {
    const res = await POST(inboundRequest(payload))
    expect(res.status).toBe(400)
    expect(h.findOrCreateContact).not.toHaveBeenCalled()
  })

  it('allows an empty full_name', async () => {
    const res = await POST(inboundRequest({ ...VALID_PAYLOAD, full_name: '' }))
    expect(res.status).toBe(201)
  })
})

describe('account resolution', () => {
  it('404s when MANYCHAT_INGEST_ACCOUNT_ID has no whatsapp_config row', async () => {
    h.state.configRow = null
    const res = await POST(inboundRequest(VALID_PAYLOAD))
    expect(res.status).toBe(404)
    expect(h.findOrCreateContact).not.toHaveBeenCalled()
  })

  it('500s when the whatsapp_config lookup errors', async () => {
    h.state.configError = { message: 'db down' }
    const res = await POST(inboundRequest(VALID_PAYLOAD))
    expect(res.status).toBe(500)
  })

  it('never trusts an account_id/user_id from the request body', async () => {
    await POST(
      inboundRequest({
        ...VALID_PAYLOAD,
        account_id: 'attacker-acc',
        user_id: 'attacker-user',
      }),
    )
    expect(h.findOrCreateContact).toHaveBeenCalledWith(
      expect.anything(),
      'acc-1',
      'user-1',
      expect.any(String),
      expect.any(String),
    )
  })
})

describe('new message', () => {
  it('inserts exactly once via the idempotent upsert and returns 201', async () => {
    const res = await POST(inboundRequest(VALID_PAYLOAD))

    expect(res.status).toBe(201)
    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.upsertCalls[0].options).toMatchObject({
      onConflict: 'conversation_id,message_id',
      ignoreDuplicates: true,
    })
    expect(h.state.upsertCalls[0].row).toMatchObject({
      conversation_id: 'conv-1',
      sender_type: 'customer',
      content_type: 'text',
      content_text: VALID_PAYLOAD.text,
      status: 'delivered',
      created_at: '2026-01-01T12:00:00.000Z',
    })
    expect(String(h.state.upsertCalls[0].row.message_id)).toMatch(/^manychat:/)
  })

  it('bumps the conversation via the same RPC the Meta webhook uses', async () => {
    await POST(inboundRequest(VALID_PAYLOAD))
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.state.rpcCalls[0]).toMatchObject({
      name: 'bump_conversation_on_inbound',
      args: { p_conversation_id: 'conv-1', p_last_message_text: VALID_PAYLOAD.text },
    })
  })

  it('reopens a closed conversation', async () => {
    h.findOrCreateConversation.mockResolvedValue({
      conversation: { id: 'conv-1', status: 'closed', account_id: 'acc-1' },
      created: false,
    })
    await POST(inboundRequest(VALID_PAYLOAD))
    expect(h.reopenClosedConversation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'conv-1', status: 'closed' }),
    )
  })

  it('uses `manychat:<external_id>` as the message_id when external_id is provided', async () => {
    await POST(inboundRequest({ ...VALID_PAYLOAD, external_id: 'mc-evt-42' }))
    expect(h.state.upsertCalls[0].row.message_id).toBe('manychat:mc-evt-42')
  })

  it('derives a deterministic hash id from contact_id + last_interaction + text when external_id is absent', async () => {
    await POST(inboundRequest(VALID_PAYLOAD))
    const firstId = h.state.upsertCalls[0].row.message_id

    h.state.upsertCalls = []
    await POST(inboundRequest(VALID_PAYLOAD))
    const secondId = h.state.upsertCalls[0].row.message_id

    expect(firstId).toBe(secondId)
  })

  it('falls back to new Date() for an unparseable timestamp', async () => {
    const before = Date.now()
    await POST(inboundRequest({ ...VALID_PAYLOAD, last_interaction: 'not-a-date' }))
    const after = Date.now()

    const createdAt = new Date(
      h.state.upsertCalls[0].row.created_at as string,
    ).getTime()
    expect(createdAt).toBeGreaterThanOrEqual(before)
    expect(createdAt).toBeLessThanOrEqual(after)
  })
})

describe('manychat_contact_links mapping', () => {
  it('upserts the ManyChat↔CRM contact mapping on a new message', async () => {
    await POST(inboundRequest(VALID_PAYLOAD))

    expect(h.state.linkUpsertCalls).toHaveLength(1)
    expect(h.state.linkUpsertCalls[0].options).toMatchObject({
      onConflict: 'account_id,contact_id',
    })
    expect(h.state.linkUpsertCalls[0].row).toMatchObject({
      account_id: 'acc-1',
      contact_id: 'contact-1',
      manychat_contact_id: VALID_PAYLOAD.contact_id,
      whatsapp_id: VALID_PAYLOAD.whatsapp_id,
    })
    expect(typeof h.state.linkUpsertCalls[0].row.updated_at).toBe('string')
  })

  it('also upserts the mapping on a retry/duplicate delivery', async () => {
    await POST(inboundRequest({ ...VALID_PAYLOAD, external_id: 'mc-evt-link' }))
    expect(h.state.linkUpsertCalls).toHaveLength(1)

    // Simulate the retry: the message upsert conflicts and returns zero rows.
    h.state.messageUpsertResult = []
    const res = await POST(
      inboundRequest({ ...VALID_PAYLOAD, external_id: 'mc-evt-link' }),
    )

    expect(res.status).toBe(200)
    // The mapping write still ran a second time — it's independent of
    // message idempotency.
    expect(h.state.linkUpsertCalls).toHaveLength(2)
  })

  it('still mirrors the message into the Inbox even if the mapping write fails', async () => {
    h.state.linkUpsertError = { message: 'constraint violation' }
    const res = await POST(inboundRequest(VALID_PAYLOAD))

    expect(res.status).toBe(201)
    expect(h.state.upsertCalls).toHaveLength(1)
  })

  it('never trusts a manychat_contact_id other than payload.contact_id', async () => {
    await POST(
      inboundRequest({
        ...VALID_PAYLOAD,
        manychat_contact_id: 'attacker-controlled',
      }),
    )
    expect(h.state.linkUpsertCalls[0].row.manychat_contact_id).toBe(
      VALID_PAYLOAD.contact_id,
    )
  })
})

describe('retry / duplicate delivery', () => {
  it('does not duplicate the message and returns 200, not 201', async () => {
    await POST(inboundRequest({ ...VALID_PAYLOAD, external_id: 'mc-evt-99' }))
    expect(h.state.rpcCalls).toHaveLength(1)

    // Simulate the DB's unique-index conflict on the retry: the upsert
    // resolves with zero rows.
    h.state.messageUpsertResult = []
    const res = await POST(inboundRequest({ ...VALID_PAYLOAD, external_id: 'mc-evt-99' }))

    expect(res.status).toBe(200)
    expect(h.state.upsertCalls).toHaveLength(2)
    // Unread must NOT be bumped a second time.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.reopenClosedConversation).toHaveBeenCalledTimes(1)
  })

  it('500s if the message upsert itself errors', async () => {
    h.state.messageUpsertError = { message: 'constraint violation' }
    const res = await POST(inboundRequest(VALID_PAYLOAD))
    expect(res.status).toBe(500)
    expect(h.state.rpcCalls).toHaveLength(0)
  })
})

describe('never dispatches Flows / Automations / public webhooks / direct WhatsApp sends', () => {
  it('imports dispatchInboundToAiReply (feature-flagged), but never Flows, Automations, public webhook fan-out, or any WhatsApp send path', () => {
    const source = readFileSync(join(__dirname, 'route.ts'), 'utf8')
    // AI is intentionally wired in as of this change — locked in as a
    // positive assertion so a future edit can't silently rip it back
    // out along with something else.
    expect(source).toMatch(/dispatchInboundToAiReply/)
    expect(source).toMatch(/@\/lib\/ai\/auto-reply/)
    // Everything else stays forbidden — this route is still a mirror
    // for everything except AI.
    expect(source).not.toMatch(/dispatchInboundToFlows/)
    expect(source).not.toMatch(/runAutomationsForTrigger/)
    expect(source).not.toMatch(/dispatchWebhookEvent/)
    expect(source).not.toMatch(/@\/lib\/whatsapp\/meta-api/)
    expect(source).not.toMatch(/@\/lib\/flows\//)
    expect(source).not.toMatch(/@\/lib\/automations\/engine/)
  })
})

describe('AI auto-reply dispatch (MANYCHAT_AI_AUTOREPLY_ENABLED)', () => {
  it('feature flag absent → does not schedule AI', async () => {
    delete process.env.MANYCHAT_AI_AUTOREPLY_ENABLED
    const res = await POST(inboundRequest(VALID_PAYLOAD))
    expect(res.status).toBe(201)
    expect(h.state.afterCallbacks).toHaveLength(0)
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
  })

  it('feature flag "false" → does not schedule AI', async () => {
    process.env.MANYCHAT_AI_AUTOREPLY_ENABLED = 'false'
    await POST(inboundRequest(VALID_PAYLOAD))
    expect(h.state.afterCallbacks).toHaveLength(0)
  })

  it('feature flag any value other than the exact string "true" → does not schedule AI', async () => {
    process.env.MANYCHAT_AI_AUTOREPLY_ENABLED = 'TRUE'
    await POST(inboundRequest(VALID_PAYLOAD))
    expect(h.state.afterCallbacks).toHaveLength(0)
  })

  it('flag=true + a genuine new message → schedules AI exactly once, via after()', async () => {
    process.env.MANYCHAT_AI_AUTOREPLY_ENABLED = 'true'
    const res = await POST(inboundRequest(VALID_PAYLOAD))

    expect(res.status).toBe(201)
    // The response resolved WITHOUT the after() callback having run —
    // proves the HTTP response never waited on the LLM call.
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
    expect(h.state.afterCallbacks).toHaveLength(1)

    await drainAfterCallbacks()
    expect(h.dispatchInboundToAiReply).toHaveBeenCalledTimes(1)
  })

  it('duplicate/retry → does not schedule AI a second time', async () => {
    process.env.MANYCHAT_AI_AUTOREPLY_ENABLED = 'true'
    await POST(inboundRequest({ ...VALID_PAYLOAD, external_id: 'mc-evt-ai' }))
    expect(h.state.afterCallbacks).toHaveLength(1)

    // Simulate the retry: the message upsert conflicts and returns zero rows.
    h.state.afterCallbacks = []
    h.state.messageUpsertResult = []
    const res = await POST(inboundRequest({ ...VALID_PAYLOAD, external_id: 'mc-evt-ai' }))

    expect(res.status).toBe(200)
    expect(h.state.afterCallbacks).toHaveLength(0)
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
  })

  it('invalid payload → does not schedule AI', async () => {
    process.env.MANYCHAT_AI_AUTOREPLY_ENABLED = 'true'
    const res = await POST(inboundRequest({ ...VALID_PAYLOAD, text: '' }))
    expect(res.status).toBe(400)
    expect(h.state.afterCallbacks).toHaveLength(0)
  })

  it('the ManyChat↔CRM mapping upsert still runs exactly as before', async () => {
    process.env.MANYCHAT_AI_AUTOREPLY_ENABLED = 'true'
    await POST(inboundRequest(VALID_PAYLOAD))
    expect(h.state.linkUpsertCalls).toHaveLength(1)
  })

  it('the unread bump (RPC) still runs exactly once', async () => {
    process.env.MANYCHAT_AI_AUTOREPLY_ENABLED = 'true'
    await POST(inboundRequest(VALID_PAYLOAD))
    expect(h.state.rpcCalls).toHaveLength(1)
  })

  it('reopen still runs for a closed conversation', async () => {
    process.env.MANYCHAT_AI_AUTOREPLY_ENABLED = 'true'
    h.findOrCreateConversation.mockResolvedValue({
      conversation: { id: 'conv-1', status: 'closed', account_id: 'acc-1' },
      created: false,
    })
    await POST(inboundRequest(VALID_PAYLOAD))
    expect(h.reopenClosedConversation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'conv-1', status: 'closed' }),
    )
  })

  it('AI receives exactly the server-resolved accountId/conversationId/contactId/configOwnerUserId — never client-supplied ids', async () => {
    process.env.MANYCHAT_AI_AUTOREPLY_ENABLED = 'true'
    h.findOrCreateContact.mockResolvedValue({
      contact: { id: 'contact-xyz', name: 'Ada', phone: '15551230000' },
      wasCreated: false,
    })
    h.findOrCreateConversation.mockResolvedValue({
      conversation: { id: 'conv-xyz', status: 'open', account_id: 'acc-1' },
      created: false,
    })

    await POST(
      inboundRequest({
        ...VALID_PAYLOAD,
        account_id: 'attacker-acc',
        user_id: 'attacker-user',
        conversation_id: 'attacker-conv',
      }),
    )
    await drainAfterCallbacks()

    expect(h.dispatchInboundToAiReply).toHaveBeenCalledWith({
      accountId: 'acc-1',
      conversationId: 'conv-xyz',
      contactId: 'contact-xyz',
      configOwnerUserId: 'user-1',
      suppressWhenAutomationsActive: false,
    })
  })
})

describe('AI auto-reply allowlist (MANYCHAT_AI_AUTOREPLY_CONTACT_IDS)', () => {
  afterEach(() => {
    delete process.env.MANYCHAT_AI_AUTOREPLY_CONTACT_IDS
  })

  it('enabled + allowlist contains the current contact_id → schedules AI', async () => {
    process.env.MANYCHAT_AI_AUTOREPLY_ENABLED = 'true'
    process.env.MANYCHAT_AI_AUTOREPLY_CONTACT_IDS = 'mc-contact-1'
    const res = await POST(inboundRequest(VALID_PAYLOAD))
    expect(res.status).toBe(201)
    expect(h.state.afterCallbacks).toHaveLength(1)
  })

  it('enabled + allowlist does NOT contain the current contact_id → does not schedule AI', async () => {
    process.env.MANYCHAT_AI_AUTOREPLY_ENABLED = 'true'
    process.env.MANYCHAT_AI_AUTOREPLY_CONTACT_IDS = 'someone-else,another-one'
    const res = await POST(inboundRequest(VALID_PAYLOAD))
    // The message itself still mirrors into the Inbox fine — only the
    // AI dispatch is withheld.
    expect(res.status).toBe(201)
    expect(h.state.afterCallbacks).toHaveLength(0)
    expect(h.state.upsertCalls).toHaveLength(1)
  })

  it('parses whitespace/comma-separated ids correctly (trim + exact match)', async () => {
    process.env.MANYCHAT_AI_AUTOREPLY_ENABLED = 'true'
    process.env.MANYCHAT_AI_AUTOREPLY_CONTACT_IDS = '  someone-else , mc-contact-1 ,, another '
    await POST(inboundRequest(VALID_PAYLOAD))
    expect(h.state.afterCallbacks).toHaveLength(1)
  })

  it('an empty allowlist string ("") falls back to normal (all eligible contacts) behavior', async () => {
    process.env.MANYCHAT_AI_AUTOREPLY_ENABLED = 'true'
    process.env.MANYCHAT_AI_AUTOREPLY_CONTACT_IDS = ''
    await POST(inboundRequest(VALID_PAYLOAD))
    expect(h.state.afterCallbacks).toHaveLength(1)
  })

  it('an allowlist that trims to nothing (only commas/whitespace) falls back to normal behavior', async () => {
    process.env.MANYCHAT_AI_AUTOREPLY_ENABLED = 'true'
    process.env.MANYCHAT_AI_AUTOREPLY_CONTACT_IDS = ' , , '
    await POST(inboundRequest(VALID_PAYLOAD))
    expect(h.state.afterCallbacks).toHaveLength(1)
  })

  it('variable absent → normal (all eligible contacts) behavior', async () => {
    process.env.MANYCHAT_AI_AUTOREPLY_ENABLED = 'true'
    delete process.env.MANYCHAT_AI_AUTOREPLY_CONTACT_IDS
    await POST(inboundRequest(VALID_PAYLOAD))
    expect(h.state.afterCallbacks).toHaveLength(1)
  })

  it('a retry/duplicate never schedules AI, even for an allowlisted contact', async () => {
    process.env.MANYCHAT_AI_AUTOREPLY_ENABLED = 'true'
    process.env.MANYCHAT_AI_AUTOREPLY_CONTACT_IDS = 'mc-contact-1'
    await POST(inboundRequest({ ...VALID_PAYLOAD, external_id: 'mc-evt-allow' }))
    expect(h.state.afterCallbacks).toHaveLength(1)

    // Simulate the retry: the message upsert conflicts and returns zero rows.
    h.state.afterCallbacks = []
    h.state.messageUpsertResult = []
    const res = await POST(inboundRequest({ ...VALID_PAYLOAD, external_id: 'mc-evt-allow' }))

    expect(res.status).toBe(200)
    expect(h.state.afterCallbacks).toHaveLength(0)
  })

  it('an invalid payload never schedules AI, even for an allowlisted contact', async () => {
    process.env.MANYCHAT_AI_AUTOREPLY_ENABLED = 'true'
    process.env.MANYCHAT_AI_AUTOREPLY_CONTACT_IDS = 'mc-contact-1'
    const res = await POST(inboundRequest({ ...VALID_PAYLOAD, text: '' }))
    expect(res.status).toBe(400)
    expect(h.state.afterCallbacks).toHaveLength(0)
  })

  it('only payload.contact_id is checked against the allowlist — other body fields cannot spoof a match', async () => {
    process.env.MANYCHAT_AI_AUTOREPLY_ENABLED = 'true'
    process.env.MANYCHAT_AI_AUTOREPLY_CONTACT_IDS = 'mc-contact-1'
    // The real contact_id ('mc-other') is NOT allowlisted; smuggling
    // 'mc-contact-1' under unrelated field names must not count.
    const res = await POST(
      inboundRequest({
        ...VALID_PAYLOAD,
        contact_id: 'mc-other',
        manychat_contact_id: 'mc-contact-1',
        account_id: 'mc-contact-1',
      }),
    )
    expect(res.status).toBe(201)
    expect(h.state.afterCallbacks).toHaveLength(0)
  })
})

describe('never logs the bearer secret', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
    warnSpy.mockRestore()
    logSpy.mockRestore()
  })

  /** Every argument logged across all three console methods, flattened to strings. */
  function loggedText(): string {
    const calls = [...errorSpy.mock.calls, ...warnSpy.mock.calls, ...logSpy.mock.calls]
    return calls
      .flat()
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join('\n')
  }

  it('does not log the secret on a wrong-secret 401', async () => {
    await POST(inboundRequest(VALID_PAYLOAD, { auth: 'Bearer wrong-secret' }))
    const text = loggedText()
    expect(text).not.toContain(VALID_SECRET)
    expect(text).not.toContain('wrong-secret')
  })

  it('does not log the secret when the whatsapp_config lookup errors', async () => {
    h.state.configError = { message: 'db down' }
    await POST(inboundRequest(VALID_PAYLOAD))
    expect(loggedText()).not.toContain(VALID_SECRET)
  })

  it('does not log the secret when the message insert errors', async () => {
    h.state.messageUpsertError = { message: 'constraint violation' }
    await POST(inboundRequest(VALID_PAYLOAD))
    expect(loggedText()).not.toContain(VALID_SECRET)
  })

  it('does not log the secret on a genuine successful insert', async () => {
    await POST(inboundRequest(VALID_PAYLOAD))
    expect(loggedText()).not.toContain(VALID_SECRET)
  })
})
