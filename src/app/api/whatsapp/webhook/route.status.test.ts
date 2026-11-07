import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// PR-A: STATUS webhooks are attributed to the account that owns the business number named in the (signed) payload, applied through ONE
// scoped, forward-only database call, and notified only for rows that really changed. The semantics of the write (monotonic, atomic) are
// proven against real Postgres in route.status.integration.test.ts / message-status.integration.test.ts; this file pins the route's contract
// without Docker so it runs in the normal suite.

const h = vi.hoisted(() => ({
  afterCallbacks: [] as (() => Promise<void> | void)[],
  configsByPhone: {} as Record<string, { account_id: string }[]>,
  configLookups: [] as [string, string][],
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  rpcResult: { data: [] as unknown[], error: null as null | { code: string; message: string; details?: string } },
  /** Per-function override of rpcResult (e.g. a failing pricing write next to a working status write). */
  rpcByName: {} as Record<string, { data: unknown; error: null | { code: string; message: string } }>,
  unexpectedTables: [] as string[],
  dispatch: vi.fn(),
  heldFor: new Set<string>(),
  audit: vi.fn(),
}))

vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => { h.afterCallbacks.push(cb) },
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) },
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      if (table === 'whatsapp_config') {
        return {
          select: () => ({
            eq: (col: string, val: string) => {
              h.configLookups.push([col, val])
              return Promise.resolve({ data: h.configsByPhone[val] ?? [], error: null })
            },
          }),
        }
      }
      // Any other table touched while handling a status event (an unscoped `messages` / `broadcast_recipients` update, a stray select) is a bug.
      h.unexpectedTables.push(table)
      throw new Error('unexpected table access: ' + table)
    },
    rpc(name: string, args: Record<string, unknown>) {
      h.rpcCalls.push({ name, args })
      return Promise.resolve(h.rpcByName[name] ?? h.rpcResult)
    },
  }),
}))

// Signature verification has its own suite (route.signature.test.ts): here the request is already authentic.
vi.mock('@/lib/whatsapp/webhook-tenant-secret', () => ({ resolveWebhookSignatureSecrets: async () => ['secret'] }))
vi.mock('@/lib/whatsapp/webhook-signature', () => ({ verifyMetaWebhookSignature: () => true }))
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: h.dispatch }))
vi.mock('@/lib/webhooks/pilot-hold', () => ({
  externalEventsHeldForContact: async (_db: unknown, _account: string, contact: string | undefined) => (contact ? h.heldFor.has(contact) : true),
  auditExternalEventHeld: h.audit,
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({ getMediaUrl: vi.fn(), downloadMedia: vi.fn() }))
vi.mock('@/lib/whatsapp/mirror-inbound-media', () => ({ mirrorInboundMedia: vi.fn() }))
vi.mock('@/lib/conversations/find-or-create', () => ({ findOrCreateConversation: vi.fn() }))
vi.mock('@/lib/conversations/reopen', () => ({ reopenClosedConversation: vi.fn() }))
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: vi.fn() }))
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: vi.fn() }))
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: vi.fn() }))
vi.mock('@/lib/whatsapp/template-webhook', () => ({ isTemplateWebhookField: () => false, handleTemplateWebhookChange: vi.fn() }))

import { POST } from './route'

const WAMID = 'wamid.HBgMNTE5MDAwMDAwMDAxFQIAERgSQTFCMkMzRDRFNUY2QTdCOA=='
const PHONE_A = '111111111111111'
const PHONE_B = '222222222222222'

type St = { id?: string; status: string; timestamp?: string; pricing?: Record<string, unknown>; conversation?: Record<string, unknown> }
function body(phone: string | undefined, statuses: St[]) {
  return JSON.stringify({
    entry: [{
      id: '999',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: phone === undefined ? {} : { display_phone_number: '51900000000', phone_number_id: phone },
          statuses: statuses.map((s) => ({ id: s.id ?? WAMID, status: s.status, timestamp: s.timestamp ?? '1793970000', recipient_id: '51900000001', ...(s.pricing ? { pricing: s.pricing } : {}), ...(s.conversation ? { conversation: s.conversation } : {}) })),
        },
      }],
    }],
  })
}
async function deliver(raw: string) {
  h.afterCallbacks.length = 0
  const res = await POST(new Request('http://x/api/whatsapp/webhook', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': 'sha256=ok' } }))
  for (const cb of h.afterCallbacks.splice(0)) await cb()
  return res.status
}
const applied = (conv = 'conv-1', contact: string | null = 'contact-1', next = 'delivered') => ({
  r_message_id: 'msg-1', r_conversation_id: conv, r_contact_id: contact, r_previous_status: 'sent', r_new_status: next,
})

type LogSpy = { mock: { calls: unknown[][] }; mockRestore: () => void }
let errors: LogSpy
let warns: LogSpy

describe('status webhook: tenant attribution and scoped, forward-only write (PR-A)', () => {
  beforeEach(() => {
    h.configsByPhone = { [PHONE_A]: [{ account_id: 'acc-A' }], [PHONE_B]: [{ account_id: 'acc-B' }] }
    h.configLookups = []; h.rpcCalls = []; h.unexpectedTables = []; h.heldFor = new Set()
    h.rpcResult = { data: [], error: null }
    h.dispatch.mockReset(); h.audit.mockReset()
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    warns = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => { errors.mockRestore(); warns.mockRestore() })

  it('derives the account from the payload phone_number_id and passes ONLY that account to the write', async () => {
    h.rpcResult = { data: [applied()], error: null }
    expect(await deliver(body(PHONE_A, [{ status: 'delivered', timestamp: '1793970000' }]))).toBe(200)
    expect(h.configLookups).toContainEqual(['phone_number_id', PHONE_A])
    expect(h.rpcCalls).toEqual([{ name: 'apply_whatsapp_message_status', args: { p_account_id: 'acc-A', p_wamid: WAMID, p_status: 'delivered', p_event_at: new Date(1793970000 * 1000).toISOString() } }])
    expect(h.unexpectedTables).toEqual([])                                   // never an unscoped messages / broadcast_recipients write from the route
  })

  it('notifies once per row that really changed, on the config account, with the stored (new) status', async () => {
    h.rpcResult = { data: [applied('conv-1', 'c1', 'delivered'), applied('conv-2', 'c2', 'delivered')], error: null }
    await deliver(body(PHONE_B, [{ status: 'delivered' }]))
    expect(h.dispatch).toHaveBeenCalledTimes(2)
    for (const [i, conv] of ['conv-1', 'conv-2'].entries()) {
      expect(h.dispatch.mock.calls[i].slice(1)).toEqual(['acc-B', 'message.status_updated', { whatsapp_message_id: WAMID, conversation_id: conv, status: 'delivered' }])
    }
  })

  it('a stale / replayed / refused event (the write changed nothing) sends NO notification', async () => {
    h.rpcResult = { data: [], error: null }
    await deliver(body(PHONE_A, [{ status: 'sent' }]))
    expect(h.rpcCalls).toHaveLength(1); expect(h.dispatch).not.toHaveBeenCalled(); expect(h.audit).not.toHaveBeenCalled()
  })

  it('a number that belongs to no account applies and notifies nothing (and says why, without any customer identifier)', async () => {
    h.configsByPhone = {}
    await deliver(body(PHONE_A, [{ status: 'read' }]))
    expect(h.rpcCalls).toHaveLength(0); expect(h.dispatch).not.toHaveBeenCalled()
    expect(errors.mock.calls.some((c) => String(c[0]).includes('status event not applied: no whatsapp_config'))).toBe(true)
  })

  it('a number claimed by more than one account is ambiguous: applies and notifies nothing', async () => {
    h.configsByPhone = { [PHONE_A]: [{ account_id: 'acc-A' }, { account_id: 'acc-B' }] }
    await deliver(body(PHONE_A, [{ status: 'read' }]))
    expect(h.rpcCalls).toHaveLength(0); expect(h.dispatch).not.toHaveBeenCalled()
    expect(errors.mock.calls.some((c) => String(c[0]).includes('claimed by more than one account'))).toBe(true)
  })

  it('a payload without phone_number_id applies nothing', async () => {
    await deliver(body(undefined, [{ status: 'read' }]))
    expect(h.configLookups).toEqual([]); expect(h.rpcCalls).toHaveLength(0); expect(h.dispatch).not.toHaveBeenCalled()
  })

  it("maps Meta's `played` (voice note) to `read` instead of a value the column cannot store", async () => {
    h.rpcResult = { data: [applied('conv-1', 'c1', 'read')], error: null }
    await deliver(body(PHONE_A, [{ status: 'played' }]))
    expect(h.rpcCalls[0].args.p_status).toBe('read')
    expect(h.dispatch.mock.calls[0][3]).toMatchObject({ status: 'read' })
  })

  it('ignores a status value the app does not store, with a capped, printable-only log and no write', async () => {
    await deliver(body(PHONE_A, [{ status: 'deleted' }, { status: 'x'.repeat(200) + '\n<script>' }]))
    expect(h.rpcCalls).toHaveLength(0); expect(h.dispatch).not.toHaveBeenCalled()
    const logged = warns.mock.calls.map((c) => JSON.stringify(c))
    expect(logged.length).toBe(2); expect(logged.every((l) => l.length < 200 && !l.includes('<script>') && !l.includes('\\n'))).toBe(true)
  })

  it('a database error is logged without echoing the row or the raw message id, and never throws or notifies', async () => {
    h.rpcResult = { data: null as never, error: { code: 'PGRST202', message: 'Could not find the function', details: 'Failing row contains (secret text, https://private/url)' } }
    expect(await deliver(body(PHONE_A, [{ status: 'delivered' }]))).toBe(200)
    expect(h.dispatch).not.toHaveBeenCalled()
    const logged = JSON.stringify(errors.mock.calls)
    expect(logged).toContain('PGRST202'); expect(logged).not.toContain('secret text'); expect(logged).not.toContain('private/url'); expect(logged).not.toContain(WAMID)
  })

  it('an external-events hold on the contact audits instead of notifying', async () => {
    h.heldFor = new Set(['held-contact'])
    h.rpcResult = { data: [applied('conv-1', 'held-contact'), applied('conv-2', 'free-contact')], error: null }
    await deliver(body(PHONE_A, [{ status: 'delivered' }]))
    expect(h.audit).toHaveBeenCalledTimes(1); expect(h.audit.mock.calls[0].slice(1)).toEqual(['acc-A', 'held-contact', 'message.status_updated'])
    expect(h.dispatch).toHaveBeenCalledTimes(1); expect(h.dispatch.mock.calls[0][3]).toMatchObject({ conversation_id: 'conv-2' })
  })

  it('a malformed or absurd timestamp never breaks the write: it is sent as null (the database uses now())', async () => {
    for (const ts of ['', 'abc', '-5', '99999999999999999999', '0']) {
      h.rpcCalls = []
      await deliver(body(PHONE_A, [{ status: 'sent', timestamp: ts }]))
      expect(h.rpcCalls[0].args.p_event_at, `timestamp "${ts}"`).toBeNull()
    }
  })

  it('several events in one delivery are applied in order, each scoped to the account of ITS number', async () => {
    const raw = JSON.stringify({
      entry: [
        { id: '9', changes: [{ field: 'messages', value: { metadata: { phone_number_id: PHONE_A }, statuses: [{ id: 'wamid.1', status: 'sent', timestamp: '1793970001' }, { id: 'wamid.2', status: 'read', timestamp: '1793970002' }] } }] },
        { id: '8', changes: [{ field: 'messages', value: { metadata: { phone_number_id: PHONE_B }, statuses: [{ id: 'wamid.3', status: 'delivered', timestamp: '1793970003' }] } }] },
      ],
    })
    await deliver(raw)
    expect(h.rpcCalls.map((c) => [c.args.p_account_id, c.args.p_wamid, c.args.p_status])).toEqual([['acc-A', 'wamid.1', 'sent'], ['acc-A', 'wamid.2', 'read'], ['acc-B', 'wamid.3', 'delivered']])
  })
})

describe('status webhook: free entry point evidence (additive, best effort)', () => {
  const FEP = { billable: false, pricing_model: 'PMP', type: 'free_entry_point', category: 'service' }
  const AD_CONVERSATION = { id: 'c', expiration_timestamp: '1794000000', origin: { type: 'referral_conversion' } }
  const pricingCalls = () => h.rpcCalls.filter((c) => c.name === 'record_whatsapp_message_pricing')
  const statusCalls = () => h.rpcCalls.filter((c) => c.name === 'apply_whatsapp_message_status')

  beforeEach(() => {
    h.configsByPhone = { [PHONE_A]: [{ account_id: 'acc-A' }], [PHONE_B]: [{ account_id: 'acc-B' }] }
    h.configLookups = []; h.rpcCalls = []; h.unexpectedTables = []; h.heldFor = new Set(); h.rpcByName = {}
    h.rpcResult = { data: [], error: null }
    h.dispatch.mockReset(); h.audit.mockReset()
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    warns = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => { errors.mockRestore(); warns.mockRestore() })

  it('free_entry_point + Meta expiration: stores both for the account of the payload and still applies the normal status', async () => {
    h.rpcByName.apply_whatsapp_message_status = { data: [applied()], error: null }
    expect(await deliver(body(PHONE_A, [{ status: 'sent', pricing: FEP, conversation: AD_CONVERSATION }]))).toBe(200)
    expect(pricingCalls()).toEqual([{ name: 'record_whatsapp_message_pricing', args: { p_account_id: 'acc-A', p_wamid: WAMID, p_type: 'free_entry_point', p_category: 'service', p_expiration: new Date(1794000000 * 1000).toISOString() } }])
    expect(statusCalls()).toHaveLength(1)
    expect(statusCalls()[0].args).toMatchObject({ p_account_id: 'acc-A', p_status: 'sent' })
    expect(h.dispatch).toHaveBeenCalledTimes(1)
    expect(h.unexpectedTables).toEqual([])
  })

  it('free_entry_point without an expiration: stores the type only (no end is invented)', async () => {
    await deliver(body(PHONE_A, [{ status: 'delivered', pricing: FEP }]))
    expect(pricingCalls()[0].args).toMatchObject({ p_type: 'free_entry_point', p_expiration: null })
  })

  it('free_entry_point next to an ordinary 24 h conversation never takes that conversation\'s expiration as the window end', async () => {
    await deliver(body(PHONE_A, [{ status: 'sent', pricing: FEP, conversation: { id: 'c', expiration_timestamp: '1794000000', origin: { type: 'service' } } }]))
    expect(pricingCalls()[0].args).toMatchObject({ p_type: 'free_entry_point', p_expiration: null })
  })

  it('regular, free_customer_service and no pricing at all store nothing and change nothing else', async () => {
    await deliver(body(PHONE_A, [
      { status: 'delivered', pricing: { billable: true, type: 'regular', category: 'marketing' } },
      { status: 'delivered', id: 'wamid.2', pricing: { billable: false, type: 'free_customer_service', category: 'service' } },
      { status: 'read', id: 'wamid.3' },
    ]))
    expect(pricingCalls()).toHaveLength(0)
    expect(statusCalls()).toHaveLength(3)
  })

  it('each event of one message carries its half (sent: conversation, delivered: pricing): both reach the database, which merges them', async () => {
    await deliver(body(PHONE_A, [{ status: 'sent', conversation: AD_CONVERSATION }, { status: 'delivered', pricing: FEP }]))
    expect(pricingCalls().map((c) => [c.args.p_type, c.args.p_expiration])).toEqual([[null, new Date(1794000000 * 1000).toISOString()], ['free_entry_point', null]])
  })

  it('a failing or throwing pricing write never prevents the normal status from being applied and notified', async () => {
    h.rpcByName.record_whatsapp_message_pricing = { data: null, error: { code: '42501', message: 'row says secret text' } }
    h.rpcByName.apply_whatsapp_message_status = { data: [applied()], error: null }
    expect(await deliver(body(PHONE_A, [{ status: 'delivered', pricing: FEP }]))).toBe(200)
    expect(statusCalls()).toHaveLength(1)
    expect(h.dispatch).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(errors.mock.calls)).not.toContain('secret text')
  })

  it('a replay sends the same upsert again (the database makes it idempotent) and changes nothing else', async () => {
    const raw = body(PHONE_A, [{ status: 'delivered', pricing: FEP }])
    await deliver(raw); await deliver(raw)
    expect(pricingCalls()).toHaveLength(2)
    expect(pricingCalls()[0].args).toEqual(pricingCalls()[1].args)
  })

  it('the account always comes from the signed payload number: another account\'s number is scoped to ITS account', async () => {
    await deliver(body(PHONE_B, [{ status: 'delivered', pricing: FEP }]))
    expect(pricingCalls()[0].args.p_account_id).toBe('acc-B')
  })

  it('an unknown number stores nothing', async () => {
    h.configsByPhone = {}
    await deliver(body(PHONE_A, [{ status: 'delivered', pricing: FEP }]))
    expect(h.rpcCalls).toHaveLength(0)
  })
})
