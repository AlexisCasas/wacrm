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
const PN_A = '1000000000000001'
const PN_B = '2000000000000002'
const WABA_A = '3000000000000001'
const WABA_B = '3000000000000002'
const PILOT = 'WHATSAPP_BSUID_PILOT'
let seq = 0

function setup() {
  h.db = createInMemoryDb({
    whatsapp_config: [
      { id: 'cfg-a', account_id: ACC_A, user_id: 'owner-a', phone_number_id: PN_A, waba_id: WABA_A, access_token: 'enc', mirror_inbound_media: true },
      { id: 'cfg-b', account_id: ACC_B, user_id: 'owner-b', phone_number_id: PN_B, waba_id: WABA_B, access_token: 'enc', mirror_inbound_media: true },
    ],
  })
  h.after.length = 0
  // The pilot switch is ON for account A only (the pilot account); B plays the part of every other account.
  process.env[PILOT] = `${ACC_A}:${PN_A}:${WABA_A}`
  h.dispatchInboundToFlows.mockReset().mockResolvedValue({ consumed: false })
  h.dispatchInboundToAiReply.mockReset().mockResolvedValue(undefined)
  h.runAutomationsForTrigger.mockReset().mockResolvedValue(undefined)
  h.dispatchWebhookEvent.mockReset().mockResolvedValue(undefined)
}

function deliver(messages: Record<string, unknown>[], contacts: Record<string, unknown>[], pn = PN_A, extraValue: Record<string, unknown> = {}, envelopeId?: string) {
  const body = { entry: [{ id: envelopeId ?? (pn === PN_B ? WABA_B : WABA_A), changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: pn }, contacts, messages, ...extraValue } }] }] }
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
  it('stores the message and creates the contact and the conversation (held back from automation during the pilot)', async () => {
    await run(deliver([text({ from_user_id: BSUID })], [{ user_id: BSUID, profile: { name: 'Ana', username: 'ana_01' } }]))
    const [contact] = h.db.tables.contacts
    expect(contact).toMatchObject({ account_id: ACC_A, phone: '', phone_optional: true, name: 'Ana', wa_username: 'ana_01' })
    expect(h.db.tables.conversations).toHaveLength(1)
    expect(h.db.tables.conversations[0]).toMatchObject({ account_id: ACC_A, contact_id: contact.id })
    expect(h.db.tables.messages).toHaveLength(1)
    expect(h.db.tables.messages[0]).toMatchObject({ conversation_id: h.db.tables.conversations[0].id, sender_type: 'customer', content_text: 'hola' })
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    // pilot hold: stored and visible, but not offered to Flows / automations / AI
  })

  it('a second message from the same user lands in the SAME conversation, no new contact', async () => {
    await run(deliver([text({ from_user_id: BSUID })], [{ user_id: BSUID, profile: { name: 'Ana' } }]))
    await run(deliver([text({ from_user_id: BSUID }, 'otra vez')], [{ user_id: BSUID, profile: { name: 'Ana' } }]))
    expect(h.db.tables.contacts).toHaveLength(1)
    expect(h.db.tables.conversations).toHaveLength(1)
    expect(h.db.tables.messages.map((m) => m.content_text)).toEqual(['hola', 'otra vez'])
  })

  it('a replayed delivery is ignored (idempotent): one message, one audit entry', async () => {
    const m = text({ from_user_id: BSUID })
    await run(deliver([m], [{ user_id: BSUID }]))
    await run(deliver([m], [{ user_id: BSUID }]))
    expect(h.db.tables.messages).toHaveLength(1)
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
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
    process.env[PILOT] = `${ACC_A}:${PN_A}:${WABA_A},${ACC_B}:${PN_B}:${WABA_B}`
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

describe('BSUID switch: scope and pilot hold', () => {
  const phoneEvent = (extra: Record<string, unknown> = {}, body = 'hola') => deliver([text({ from: '51900000001', ...extra }, body)], [{ wa_id: '51900000001', profile: { name: 'Luis' }, ...(extra.from_user_id ? { user_id: extra.from_user_id } : {}) }])

  it('switch OFF = previous behaviour: a BSUID-only sender is dropped with the legacy reason, nothing is created', async () => {
    delete process.env[PILOT]
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await run(deliver([text({ from_user_id: BSUID })], [{ user_id: BSUID, profile: { name: 'Ana' } }]))
    expect(h.db.tables.contacts).toHaveLength(0)
    expect(h.db.tables.messages).toHaveLength(0)
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toContain('missing_sender_identity')
    expect(logged).toContain('"bsuid_pilot":"off"')
    expect(logged).not.toContain(BSUID)
  })

  it('switch OFF: a phone sender whose event also carries a BSUID behaves exactly as before (no identity stored, no username)', async () => {
    delete process.env[PILOT]
    await run(deliver([text({ from: '51900000001', from_user_id: BSUID })], [{ wa_id: '51900000001', user_id: BSUID, profile: { name: 'Luis', username: 'luis_01' } }]))
    expect(h.db.tables.contacts).toHaveLength(1)
    expect(h.db.tables.contacts[0]).toMatchObject({ phone: '51900000001', name: 'Luis', wa_username: null, phone_optional: false })
    expect(h.db.tables.contact_identities).toHaveLength(0)
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
  })

  it('an account outside the pilot (switch off for its number): a BSUID event starts no Flow and sends nothing; phone events work', async () => {
    await run(deliver([text({ from_user_id: BSUID })], [{ user_id: BSUID }], PN_B))
    expect(h.db.tables.contacts).toHaveLength(0)
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    await run(deliver([text({ from: '51900000002' }, 'hola B')], [{ wa_id: '51900000002', profile: { name: 'Beto' } }], PN_B))
    expect(h.db.tables.contacts).toHaveLength(1)
    expect(h.db.tables.contacts[0].account_id).toBe(ACC_B)
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
  })

  it('the pilot account (switch on): phone events still run Flows, automations and external events', async () => {
    await run(phoneEvent())
    expect(h.db.tables.contacts[0]).toMatchObject({ account_id: ACC_A, phone: '51900000001' })
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
    expect(h.runAutomationsForTrigger).toHaveBeenCalled()
  })

  it('a phone contact that also carries a BSUID is NOT held back (it has a phone)', async () => {
    await run(phoneEvent({ from_user_id: BSUID }))
    expect(h.db.tables.contact_identities).toHaveLength(1)
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
  })

  it('pilot hold: a phone-less contact triggers no Flow, automation, AI or external webhook, and every skipped step is audited', async () => {
    await run(deliver([text({ from_user_id: BSUID })], [{ user_id: BSUID, profile: { name: 'Ana' } }]))
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled()
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
    expect(h.db.tables.contact_identity_audit.map((a) => a.event).sort()).toEqual(['automation_skipped', 'external_webhook_skipped', 'external_webhook_skipped'])
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()
  })

  it('an authorized pilot contact is still held back from automation (authorization only concerns one manual reply)', async () => {
    await run(deliver([text({ from_user_id: BSUID })], [{ user_id: BSUID }]))
    h.db.tables.contact_identities[0].send_authorized_remaining = 1
    await run(deliver([text({ from_user_id: BSUID }, 'otra')], [{ user_id: BSUID }]))
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
  })

  it('two different BSUID contacts never share a conversation', async () => {
    await run(deliver([text({ from_user_id: BSUID }, 'uno'), text({ from_user_id: BSUID2 }, 'dos')], [{ user_id: BSUID }, { user_id: BSUID2 }]))
    expect(h.db.tables.contacts).toHaveLength(2)
    expect(h.db.tables.conversations).toHaveLength(2)
    expect(new Set(h.db.tables.messages.map((m) => m.conversation_id)).size).toBe(2)
  })

  it('the envelope WABA must match the number\'s config: a mismatch fails safe (dropped)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await run(deliver([text({ from_user_id: BSUID })], [{ user_id: BSUID }], PN_A, {}, WABA_B))
    expect(h.db.tables.contacts).toHaveLength(0)
  })

  it('invalid or incomplete configuration fails safe: config row without WABA, malformed or generic values', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.db.tables.whatsapp_config[0].waba_id = null
    await run(deliver([text({ from_user_id: BSUID })], [{ user_id: BSUID }]))
    expect(h.db.tables.contacts).toHaveLength(0)
    h.db.tables.whatsapp_config[0].waba_id = WABA_A
    for (const bad of ['*', 'all', `${ACC_A}`, `${ACC_A}:${PN_A}`, `not-a-uuid:${PN_A}:${WABA_A}`, `${ACC_B}:${PN_A}:${WABA_A}`]) {
      process.env[PILOT] = bad
      await run(deliver([text({ from_user_id: BSUID })], [{ user_id: BSUID }]))
    }
    expect(h.db.tables.contacts).toHaveLength(0)
  })
})

describe('outbound webhooks (webhook_endpoints) during the pilot', () => {
  const events = () => h.dispatchWebhookEvent.mock.calls.map((c) => c[2])
  const statusRequest = (id: string, status = 'delivered') => ({
    text: async () => JSON.stringify({ entry: [{ id: WABA_A, changes: [{ field: 'messages', value: { metadata: { phone_number_id: PN_A }, statuses: [{ id, status, timestamp: '1700000002', recipient_user_id: BSUID }] } }] }] }),
    headers: { get: () => 'sha256=stub' },
  } as unknown as Request)

  it('a phone-less contact: no message.received and no conversation.created leave WACRM; the reception is recorded internally', async () => {
    await run(deliver([text({ from_user_id: BSUID }, 'texto privado')], [{ user_id: BSUID, profile: { name: 'Ana' } }]))
    expect(events()).toEqual([])
    expect(h.db.tables.messages).toHaveLength(1)
    const held = h.db.tables.contact_identity_audit.filter((a) => a.event === 'external_webhook_skipped').map((a) => (a.detail as { event: string }).event).sort()
    expect(held).toEqual(['conversation.created', 'message.received'])
    expect(JSON.stringify(h.db.tables.contact_identity_audit)).not.toContain('texto privado')
    expect(JSON.stringify(h.db.tables.contact_identity_audit)).not.toContain(BSUID)
  })

  it('a phone contact in the pilot account still emits both events', async () => {
    await run(deliver([text({ from: '51900000001' })], [{ wa_id: '51900000001', profile: { name: 'Luis' } }]))
    expect(events().sort()).toEqual(['conversation.created', 'message.received'])
  })

  it('an account outside the pilot emits exactly as before', async () => {
    await run(deliver([text({ from: '51900000002' })], [{ wa_id: '51900000002' }], PN_B))
    expect(events().sort()).toEqual(['conversation.created', 'message.received'])
  })

  it('a delivery status for a phone-less contact in the pilot is held (and audited); for a phone contact it goes out', async () => {
    await run(deliver([text({ from_user_id: BSUID })], [{ user_id: BSUID }]))
    await run(deliver([text({ from: '51900000001' })], [{ wa_id: '51900000001' }]))
    const [bsuidConv, phoneConv] = h.db.tables.conversations
    h.db.tables.messages.push({ id: 'o1', conversation_id: bsuidConv.id, message_id: 'wamid.OUT-B', sender_type: 'agent', status: 'sent' })
    h.db.tables.messages.push({ id: 'o2', conversation_id: phoneConv.id, message_id: 'wamid.OUT-P', sender_type: 'agent', status: 'sent' })
    h.dispatchWebhookEvent.mockClear()
    await run(statusRequest('wamid.OUT-B'))
    expect(events()).toEqual([])
    await run(statusRequest('wamid.OUT-P'))
    expect(events()).toEqual(['message.status_updated'])
    expect(h.db.tables.contact_identity_audit.some((a) => a.event === 'external_webhook_skipped' && (a.detail as { event: string }).event === 'message.status_updated')).toBe(true)
  })

  it('status events of accounts outside the pilot never query contacts (no cost, no behaviour change)', async () => {
    h.db.tables.conversations.push({ id: 'cv-b', account_id: ACC_B, contact_id: 'ct-b' })
    h.db.tables.messages.push({ id: 'o3', conversation_id: 'cv-b', message_id: 'wamid.OUT-OTHER', sender_type: 'agent', status: 'sent' })
    h.db.failReads.add('contacts') // any contacts read would fail closed and hold
    await run({ text: async () => JSON.stringify({ entry: [{ id: WABA_B, changes: [{ field: 'messages', value: { metadata: { phone_number_id: PN_B }, statuses: [{ id: 'wamid.OUT-OTHER', status: 'read', timestamp: '1700000003' }] } }] }] }), headers: { get: () => 'sha256=stub' } } as unknown as Request)
    expect(events()).toEqual(['message.status_updated'])
  })

  it('a read error for a pilot-account status event holds it (fails closed)', async () => {
    await run(deliver([text({ from: '51900000001' })], [{ wa_id: '51900000001' }]))
    h.db.tables.messages.push({ id: 'o4', conversation_id: h.db.tables.conversations[0].id, message_id: 'wamid.OUT-ERR', sender_type: 'agent', status: 'sent' })
    h.dispatchWebhookEvent.mockClear()
    h.db.failReads.add('contacts')
    await run(statusRequest('wamid.OUT-ERR'))
    expect(events()).toEqual([])
  })
})

describe('log hygiene and diagnostic expiry', () => {
  const MSG_ID = 'wamid.QAFAKE000000000000000099'
  const SECRETS = [BSUID, BSUID2, 'ana_01', 'Ana Perez', 'texto muy privado', MSG_ID, '51900000001']
  function spyAll() {
    return ['log', 'info', 'warn', 'error'].map((m) => vi.spyOn(console, m as 'log').mockImplementation(() => {}))
  }
  const logged = (spies: ReturnType<typeof spyAll>) => JSON.stringify(spies.flatMap((s) => s.mock.calls))

  it('with the diagnostic ON, a BSUID event logs shapes only: no ids, username, name, text, phone or message id', async () => {
    process.env.WEBHOOK_SHAPE_LOG_PHONE_NUMBER_IDS = PN_A
    process.env.WEBHOOK_SHAPE_LOG_UNTIL = new Date(Date.now() + 3600_000).toISOString()
    const spies = spyAll()
    const m = { id: MSG_ID, timestamp: '1700000000', type: 'text', text: { body: 'texto muy privado' }, from_user_id: BSUID }
    await run(deliver([m], [{ user_id: BSUID, profile: { name: 'Ana Perez', username: 'ana_01' } }]))
    await run(deliver([m], [{ user_id: BSUID, profile: { name: 'Ana Perez', username: 'ana_01' } }])) // replay -> duplicate log
    const out = logged(spies)
    expect(out).toContain('payload shape')
    for (const secret of SECRETS) expect(out).not.toContain(secret)
  })

  it('an unresolved or switched-off BSUID event logs presence flags and a digest, never the id or the raw message id', async () => {
    delete process.env[PILOT]
    const spies = spyAll()
    await run(deliver([{ id: MSG_ID, timestamp: '1700000000', type: 'text', text: { body: 'texto muy privado' }, from_user_id: BSUID }], [{ user_id: BSUID, profile: { name: 'Ana Perez', username: 'ana_01' } }]))
    const out = logged(spies)
    expect(out).toContain('missing_sender_identity')
    expect(out).toMatch(/ref:[0-9a-f]{12}/)
    for (const secret of SECRETS) expect(out).not.toContain(secret)
  })

  it('a phone-less identity conflict or warning logs no identifier either', async () => {
    const spies = spyAll()
    await run(deliver([text({ from_user_id: BSUID, from: '51900000001' }, 'texto muy privado')], [{ wa_id: '51900000001', user_id: BSUID2, profile: { name: 'Ana Perez', username: 'ana_01' } }]))
    const out = logged(spies)
    for (const secret of SECRETS) expect(out).not.toContain(secret)
  })

  it('the diagnostic EXPIRES by itself: same environment, no restart, it falls silent once the time has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-10-26T01:00:00Z'))
      process.env.WEBHOOK_SHAPE_LOG_PHONE_NUMBER_IDS = PN_A
      process.env.WEBHOOK_SHAPE_LOG_UNTIL = '2026-10-26T03:00:00Z'
      let spies = spyAll()
      await run(deliver([text({ from_user_id: BSUID })], [{ user_id: BSUID }]))
      expect(logged(spies)).toContain('payload shape')
      vi.restoreAllMocks(); spies = spyAll()
      vi.setSystemTime(new Date('2026-10-26T03:00:01Z')) // one second after expiry; variables untouched
      expect(process.env.WEBHOOK_SHAPE_LOG_UNTIL).toBe('2026-10-26T03:00:00Z')
      await run(deliver([text({ from_user_id: BSUID }, 'despues')], [{ user_id: BSUID }]))
      expect(logged(spies)).not.toContain('payload shape')
      expect(h.db.tables.messages).toHaveLength(2) // the webhook itself keeps working
    } finally {
      vi.useRealTimers()
      delete process.env.WEBHOOK_SHAPE_LOG_PHONE_NUMBER_IDS
      delete process.env.WEBHOOK_SHAPE_LOG_UNTIL
    }
  })

  it('the diagnostic never fires for another number even before it expires', async () => {
    process.env.WEBHOOK_SHAPE_LOG_PHONE_NUMBER_IDS = PN_A
    process.env.WEBHOOK_SHAPE_LOG_UNTIL = new Date(Date.now() + 3600_000).toISOString()
    const spies = spyAll()
    await run(deliver([text({ from: '51900000002' })], [{ wa_id: '51900000002' }], PN_B))
    expect(logged(spies)).not.toContain('payload shape')
    delete process.env.WEBHOOK_SHAPE_LOG_PHONE_NUMBER_IDS; delete process.env.WEBHOOK_SHAPE_LOG_UNTIL
  })
})
