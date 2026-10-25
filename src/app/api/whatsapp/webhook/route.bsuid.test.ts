import { beforeEach, describe, expect, it, vi } from 'vitest'

// End-to-end through the REAL route, contact/conversation resolution and message insert, on an in-memory database
// (src/test/in-memory-db.ts). Only the network-ish edges are mocked. Fixtures follow Meta's documented contract with
// fake ids; nothing here is a real person or number.
const h = vi.hoisted(() => ({
  db: null as unknown as import('@/test/in-memory-db').InMemoryDb,
  after: [] as (() => Promise<void> | void)[],
  dispatchInboundToFlows: vi.fn(),
  dispatchInboundToAiReply: vi.fn(),
  runAutomationsForTrigger: vi.fn(),
  dispatchWebhookEvent: vi.fn(),
}))

vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => { h.after.push(cb) },
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, init }) },
}))
// The route caches its admin client, so hand it a stable proxy that always forwards to the CURRENT test database.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => {
    const cur = () => h.db.client as { from: (t: string) => unknown; rpc: (n: string, a: unknown) => unknown; storage: unknown }
    return { from: (t: string) => cur().from(t), rpc: (n: string, a: unknown) => cur().rpc(n, a), get storage() { return cur().storage } }
  },
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'plain-token', encrypt: (v: string) => v, isLegacyFormat: () => false }))
vi.mock('@/lib/whatsapp/meta-api', () => ({ getMediaUrl: vi.fn(), downloadMedia: vi.fn() }))
vi.mock('@/lib/whatsapp/webhook-signature', () => ({ verifyMetaWebhookSignature: () => true }))
vi.mock('@/lib/whatsapp/webhook-tenant-secret', () => ({ resolveWebhookSignatureSecrets: async () => ['stub-secret'] }))
vi.mock('@/lib/whatsapp/template-webhook', () => ({ isTemplateWebhookField: () => false, handleTemplateWebhookChange: vi.fn() }))
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: h.runAutomationsForTrigger }))
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: h.dispatchInboundToFlows }))
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: h.dispatchInboundToAiReply }))
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: h.dispatchWebhookEvent }))

import { POST } from './route'
import { createInMemoryDb } from '@/test/in-memory-db'

const ACC_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const ACC_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const BSUID = 'PE.QA0000000000001'
const BSUID2 = 'PE.QA0000000000002'
const PN_A = 'pn-a'
const PN_B = 'pn-b'
let seq = 0

function setup() {
  h.db = createInMemoryDb({
    whatsapp_config: [
      { id: 'cfg-a', account_id: ACC_A, user_id: 'owner-a', phone_number_id: PN_A, access_token: 'enc', mirror_inbound_media: true },
      { id: 'cfg-b', account_id: ACC_B, user_id: 'owner-b', phone_number_id: PN_B, access_token: 'enc', mirror_inbound_media: true },
    ],
  })
  h.after.length = 0
  h.dispatchInboundToFlows.mockReset().mockResolvedValue({ consumed: false })
  h.dispatchInboundToAiReply.mockReset().mockResolvedValue(undefined)
  h.runAutomationsForTrigger.mockReset().mockResolvedValue(undefined)
  h.dispatchWebhookEvent.mockReset().mockResolvedValue(undefined)
}

function deliver(messages: Record<string, unknown>[], contacts: Record<string, unknown>[], pn = PN_A, extraValue: Record<string, unknown> = {}) {
  const body = { entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: pn }, contacts, messages, ...extraValue } }] }] }
  return { text: async () => JSON.stringify(body), headers: { get: () => 'sha256=stub' } } as unknown as Request
}
async function run(req: Request) {
  const res = await POST(req)
  for (const cb of h.after.splice(0)) await cb()
  return res
}
const text = (extra: Record<string, unknown>, body = 'hola') => ({ id: `wamid.QA${++seq}`, timestamp: '1700000000', type: 'text', text: { body }, ...extra })

beforeEach(() => { vi.restoreAllMocks(); setup() })

describe('webhook: sender without a phone number (BSUID)', () => {
  it('stores the message, creates the contact and the conversation, and offers it to Flows', async () => {
    await run(deliver([text({ from_user_id: BSUID })], [{ user_id: BSUID, profile: { name: 'Ana', username: 'ana_01' } }]))
    const [contact] = h.db.tables.contacts
    expect(contact).toMatchObject({ account_id: ACC_A, phone: '', phone_optional: true, name: 'Ana', wa_username: 'ana_01' })
    expect(h.db.tables.conversations).toHaveLength(1)
    expect(h.db.tables.conversations[0]).toMatchObject({ account_id: ACC_A, contact_id: contact.id })
    expect(h.db.tables.messages).toHaveLength(1)
    expect(h.db.tables.messages[0]).toMatchObject({ conversation_id: h.db.tables.conversations[0].id, sender_type: 'customer', content_text: 'hola' })
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(h.dispatchInboundToFlows.mock.calls[0])).toContain(contact.id as string)
  })

  it('a second message from the same user lands in the SAME conversation, no new contact', async () => {
    await run(deliver([text({ from_user_id: BSUID })], [{ user_id: BSUID, profile: { name: 'Ana' } }]))
    await run(deliver([text({ from_user_id: BSUID }, 'otra vez')], [{ user_id: BSUID, profile: { name: 'Ana' } }]))
    expect(h.db.tables.contacts).toHaveLength(1)
    expect(h.db.tables.conversations).toHaveLength(1)
    expect(h.db.tables.messages.map((m) => m.content_text)).toEqual(['hola', 'otra vez'])
  })

  it('a replayed delivery is ignored (idempotent): one message, Flows run once', async () => {
    const m = text({ from_user_id: BSUID })
    await run(deliver([m], [{ user_id: BSUID }]))
    await run(deliver([m], [{ user_id: BSUID }]))
    expect(h.db.tables.messages).toHaveLength(1)
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
  })

  it('works with no profile at all and no username', async () => {
    await run(deliver([text({ from_user_id: BSUID })], [{ user_id: BSUID }]))
    expect(h.db.tables.contacts[0].name).toBe('WhatsApp user')
    expect(h.db.tables.messages).toHaveLength(1)
  })

  it('works when the contacts array is missing entirely but the message carries from_user_id', async () => {
    await run(deliver([text({ from_user_id: BSUID })], undefined as never))
    expect(h.db.tables.messages).toHaveLength(1)
  })

  it('the traditional phone payload behaves exactly as before', async () => {
    await run(deliver([text({ from: '51900000001' })], [{ wa_id: '51900000001', profile: { name: 'Luis' } }]))
    expect(h.db.tables.contacts[0]).toMatchObject({ phone: '51900000001', name: 'Luis', phone_optional: false })
    expect(h.db.tables.contact_identities).toHaveLength(0)
    expect(h.db.tables.messages).toHaveLength(1)
  })

  it('phone + BSUID in one event: one contact holding both; later phone-less messages reach it', async () => {
    await run(deliver([text({ from: '51900000001', from_user_id: BSUID })], [{ wa_id: '51900000001', user_id: BSUID, profile: { name: 'Ana' } }]))
    await run(deliver([text({ from_user_id: BSUID }, 'sin numero')], [{ user_id: BSUID }]))
    expect(h.db.tables.contacts).toHaveLength(1)
    expect(h.db.tables.conversations).toHaveLength(1)
    expect(h.db.tables.messages).toHaveLength(2)
  })

  it('two accounts never mix: the same BSUID on another business number is another contact and conversation', async () => {
    await run(deliver([text({ from_user_id: BSUID })], [{ user_id: BSUID }], PN_A))
    await run(deliver([text({ from_user_id: BSUID })], [{ user_id: BSUID }], PN_B))
    expect(h.db.tables.contacts.map((c) => c.account_id).sort()).toEqual([ACC_A, ACC_B])
    expect(new Set(h.db.tables.conversations.map((c) => c.contact_id)).size).toBe(2)
  })

  it('a batch with several senders keeps each message with its own contact', async () => {
    await run(deliver(
      [text({ from_user_id: BSUID }, 'soy A'), text({ from: '51900000001' }, 'soy B'), text({ from_user_id: BSUID2 }, 'soy C')],
      // contacts deliberately in a different order than the messages
      [{ wa_id: '51900000001', profile: { name: 'Bea' } }, { user_id: BSUID2, profile: { name: 'Cris' } }, { user_id: BSUID, profile: { name: 'Ana' } }],
    ))
    const byText = (t: string) => {
      const msg = h.db.tables.messages.find((m) => m.content_text === t)!
      const conv = h.db.tables.conversations.find((c) => c.id === msg.conversation_id)!
      return h.db.tables.contacts.find((c) => c.id === conv.contact_id)!
    }
    expect(byText('soy A').name).toBe('Ana')
    expect(byText('soy B').name).toBe('Bea')
    expect(byText('soy C').name).toBe('Cris')
  })

  it('a blocked BSUID contact is a hard stop: counted, nothing stored, no Flow', async () => {
    await run(deliver([text({ from_user_id: BSUID })], [{ user_id: BSUID }]))
    h.db.tables.contacts[0].blocked = true
    h.dispatchInboundToFlows.mockClear()
    await run(deliver([text({ from_user_id: BSUID }, 'bloqueado')], [{ user_id: BSUID }]))
    expect(h.db.tables.messages).toHaveLength(1)
    expect(h.db.rpcCalls.some((c) => c.name === 'record_blocked_inbound')).toBe(true)
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
  })

  it('a system notice about a replaced id updates the link and is not stored as a customer message', async () => {
    await run(deliver([text({ from_user_id: BSUID })], [{ user_id: BSUID, profile: { name: 'Ana' } }]))
    h.dispatchInboundToFlows.mockClear()
    await run(deliver([{ id: 'wamid.SYS1', timestamp: '1700000001', type: 'system', from_user_id: BSUID2, system: { type: 'user_changed_user_id', previous_user_id: BSUID, body: 'x' } }], [{ user_id: BSUID2 }]))
    expect(h.db.tables.contacts).toHaveLength(1)
    expect(h.db.tables.contact_identities.find((i) => i.value === BSUID2 && !i.superseded_at)).toBeTruthy()
    expect(h.db.tables.messages).toHaveLength(1)
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    await run(deliver([text({ from_user_id: BSUID2 }, 'nuevo id')], [{ user_id: BSUID2 }]))
    expect(h.db.tables.contacts).toHaveLength(1)
    expect(h.db.tables.conversations).toHaveLength(1)
  })
})

describe('webhook: events without a usable identity', () => {
  it('drops them safely, creates nothing, and logs presence flags only (no ids, phones or text)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await run(deliver([text({}, 'texto privado')], [{ profile: { name: 'Ana', username: 'ana_01' } }]))
    expect(h.db.tables.contacts).toHaveLength(0)
    expect(h.db.tables.conversations).toHaveLength(0)
    expect(h.db.tables.messages).toHaveLength(0)
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toContain('missing_sender_identity')
    expect(logged).toContain('has_from_user_id')
    for (const secret of ['texto privado', 'ana_01', 'Ana']) expect(logged).not.toContain(secret)
  })

  it('a malformed id is reported as invalid_sender_identity (not missing) and nothing is created', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await run(deliver([text({ from_user_id: 'not an id!' })], [{ user_id: 'not an id!' }]))
    expect(JSON.stringify(warn.mock.calls)).toContain('invalid_sender_identity')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('not an id')
    expect(h.db.tables.contacts).toHaveLength(0)
  })

  it('a database error while resolving the contact drops the message instead of creating a duplicate', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    h.db.failReads.add('contact_identities')
    await run(deliver([text({ from_user_id: BSUID })], [{ user_id: BSUID }]))
    expect(h.db.tables.contacts).toHaveLength(0)
    expect(h.db.tables.messages).toHaveLength(0)
  })
})

describe('webhook: status events for a BSUID recipient', () => {
  it('are accepted without recipient_id and update the message by its id only', async () => {
    h.db.tables.messages.push({ id: 'm1', conversation_id: 'c1', message_id: 'wamid.OUT1', status: 'sent', sender_type: 'bot' })
    const body = { entry: [{ id: 'waba', changes: [{ field: 'messages', value: { metadata: { phone_number_id: PN_A }, statuses: [{ id: 'wamid.OUT1', status: 'delivered', timestamp: '1700000002', recipient_user_id: BSUID }], contacts: [{ user_id: BSUID }] } }] }] }
    await run({ text: async () => JSON.stringify(body), headers: { get: () => 'sha256=stub' } } as unknown as Request)
    expect(h.db.tables.messages.find((m) => m.id === 'm1')?.status).toBe('delivered')
  })
})
