import { beforeEach, describe, expect, it, vi } from 'vitest'

// End-to-end through the REAL route, contact/conversation resolution and message insert, on an in-memory database
// (src/test/in-memory-db.ts). Only the network-ish edges are mocked. Fixtures follow Meta's documented contract with
// fake ids; nothing here is a real person or number.
const h = vi.hoisted(() => ({
  db: null as unknown as import('@/test/in-memory-db').InMemoryDb,
  inboxPayload: null as unknown,

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

vi.mock('@/lib/whatsapp/webhook-inbox', () => ({
  // Existing route tests focus on downstream processing. The queue/RPC
  // contract, lease fencing and failure handling have their own tests.
  enqueueVerifiedWebhook: async (_db: unknown, _raw: string, payload: unknown) => {
    h.inboxPayload = payload
    return 'qa-event'
  },
  drainWebhookInbox: async (_db: unknown, handler: (payload: unknown) => Promise<void>) => {
    // Real worker records errors for retry rather than propagating them
    // beyond Next after(); the route still returned 200 after enqueue.
    try {
      await handler(h.inboxPayload)
      return { claimed: 1, processed: 1, failed: 0 }
    } catch {
      return { claimed: 1, processed: 0, failed: 1 }
    }
  },
}))

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

beforeEach(async () => { vi.restoreAllMocks(); setup(); (await import('@/lib/whatsapp/bsuid-flow-auth')).resetBsuidScopeCache() })


const PHONE = '51900000001'
const phoneEvent = (name: string, body = 'hola') => deliver([text({ from: PHONE }, body)], [{ wa_id: PHONE, profile: { name } }])
const bsuidEvent = (name: string, username: string, body = 'hola') => deliver([text({ from_user_id: BSUID }, body)], [{ user_id: BSUID, profile: { name, username } }])

describe('webhook: contact names and the manual-edit lock (FIX 03)', () => {
  it('1. a new contact gets its WhatsApp name, is not locked, and the message is stored', async () => {
    await run(phoneEvent('Luis WA'))
    expect(h.db.tables.contacts).toHaveLength(1)
    expect(h.db.tables.contacts[0]).toMatchObject({ phone: PHONE, name: 'Luis WA' })
    expect(h.db.tables.contacts[0].name_locked).not.toBe(true)
    expect(h.db.tables.messages).toHaveLength(1)
  })

  it('2. an automatic contact follows a profile change; same contact, same conversation', async () => {
    await run(phoneEvent('Luis WA'))
    await run(phoneEvent('Luis Nuevo', 'segundo'))
    expect(h.db.tables.contacts).toHaveLength(1)
    expect(h.db.tables.contacts[0].name).toBe('Luis Nuevo')
    expect(h.db.tables.conversations).toHaveLength(1)
    expect(h.db.tables.messages.map((m) => m.content_text)).toEqual(['hola', 'segundo'])
  })

  it('3. a manually edited (locked) name survives new messages; reception and linking are unchanged', async () => {
    await run(phoneEvent('Luis WA'))
    const contactId = h.db.tables.contacts[0].id
    h.db.tables.contacts[0].name = 'Luis Cliente Keyler'
    h.db.tables.contacts[0].name_locked = true
    await run(phoneEvent('Luis Otro Perfil', 'mensaje 2'))
    await run(phoneEvent('Luis Mas Cambios', 'mensaje 3'))
    expect(h.db.tables.contacts).toHaveLength(1)
    expect(h.db.tables.contacts[0]).toMatchObject({ id: contactId, name: 'Luis Cliente Keyler', phone: PHONE, name_locked: true })
    expect(h.db.tables.conversations).toHaveLength(1)
    expect(h.db.tables.conversations[0].contact_id).toBe(contactId)
    expect(h.db.tables.messages.map((m) => m.content_text)).toEqual(['hola', 'mensaje 2', 'mensaje 3'])
  })

  it('4. BSUID-only contact: a locked name survives, the username keeps syncing, identity rows and conversation untouched', async () => {
    await run(bsuidEvent('Ana', 'ana_01'))
    const contactId = h.db.tables.contacts[0].id
    const identities = JSON.stringify(h.db.tables.contact_identities)
    h.db.tables.contacts[0].name = 'Ana Cliente'
    h.db.tables.contacts[0].name_locked = true
    await run(bsuidEvent('Ana P.', 'ana_02', 'otra vez'))
    expect(h.db.tables.contacts).toHaveLength(1)
    expect(h.db.tables.contacts[0]).toMatchObject({ id: contactId, name: 'Ana Cliente', wa_username: 'ana_02', phone: '', phone_optional: true })
    expect(JSON.stringify(h.db.tables.contact_identities)).toBe(identities)
    expect(h.db.tables.conversations).toHaveLength(1)
    expect(h.db.tables.messages).toHaveLength(2)
  })

  it('5. a blocked contact: name never changes and the message is not stored (unchanged behaviour)', async () => {
    await run(phoneEvent('Luis WA'))
    h.db.tables.contacts[0].blocked = true
    await run(phoneEvent('Renombrado', 'bloqueado'))
    expect(h.db.tables.contacts[0].name).toBe('Luis WA')
    expect(h.db.tables.messages).toHaveLength(1)
  })

  it('6. an error while updating the name never stops the message from being processed', async () => {
    await run(phoneEvent('Luis WA'))
    const dbClient = h.db.client as unknown as { from: (t: string) => Record<string, unknown> }
    const realFrom = dbClient.from.bind(dbClient)
    ;(dbClient as { from: unknown }).from = (t: string) => {
      const b = realFrom(t)
      if (t !== 'contacts') return b
      return new Proxy(b, {
        get(target, prop) {
          if (prop !== 'update') return (target as never)[prop]
          return () => {
            const failed = { data: null, error: { code: 'XX000', message: 'simulated' } }
            const f: Record<string, unknown> = { eq: () => f, select: () => Promise.resolve(failed), then: (r: (v: unknown) => unknown) => Promise.resolve(failed).then(r) }
            return f
          }
        },
      })
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await run(phoneEvent('Luis Nuevo', 'sigue llegando'))
    expect((res as { init?: { status?: number } }).init?.status ?? 200).toBe(200)
    expect(h.db.tables.contacts[0].name).toBe('Luis WA')
    expect(h.db.tables.messages.map((m) => m.content_text)).toEqual(['hola', 'sigue llegando'])
  })

  it('7. the same name and phone in two accounts stay two separate contacts (isolation)', async () => {
    process.env[PILOT] = `${ACC_A}:${PN_A}:${WABA_A},${ACC_B}:${PN_B}:${WABA_B}`
    await run(phoneEvent('Luis WA'))
    await run(deliver([text({ from: PHONE }, 'b')], [{ wa_id: PHONE, profile: { name: 'Luis B' } }], PN_B))
    h.db.tables.contacts.find((c) => c.account_id === ACC_A)!.name_locked = true
    await run(deliver([text({ from: PHONE }, 'b2')], [{ wa_id: PHONE, profile: { name: 'Luis B2' } }], PN_B))
    expect(h.db.tables.contacts.find((c) => c.account_id === ACC_A)!.name).toBe('Luis WA')
    expect(h.db.tables.contacts.find((c) => c.account_id === ACC_B)!.name).toBe('Luis B2')
  })
})
