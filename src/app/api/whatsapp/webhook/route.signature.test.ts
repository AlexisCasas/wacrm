import crypto from 'node:crypto'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// feat/per-account-meta-app-secret
//
// End-to-end coverage of the route's multi-tenant signature verification,
// using the REAL webhook-signature.ts and webhook-tenant-secret.ts modules
// (unlike route.test.ts, which stubs both to focus on inbound processing).
// Only the Supabase client is mocked, serving a small in-memory
// `whatsapp_config` table. `after()` callbacks are deliberately never
// drained here — these tests only assert the synchronous POST() response
// (200 vs 401), which is decided entirely before `after()` is scheduled.
// ---------------------------------------------------------------------------

interface ConfigRow {
  id: string
  account_id: string
  phone_number_id: string
  waba_id: string | null
  app_secret: string | null
}

const h = vi.hoisted(() => ({
  configs: [] as ConfigRow[],
}))

vi.mock('next/server', () => ({
  after: () => {},
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      body,
      init,
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table !== 'whatsapp_config') {
        // Only the signature-resolution query runs before the response is
        // returned; anything past that is inside the undrained after().
        return { select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }) }
      }
      return {
        select: () => ({
          in: (col: 'phone_number_id' | 'waba_id', values: string[]) =>
            Promise.resolve({
              data: h.configs.filter((c) => values.includes(c[col] as string)),
              error: null,
            }),
        }),
      }
    },
  }),
}))

// Downstream modules the route imports at the top level — never reached by
// these tests (they all live inside the undrained after() callback, or are
// simply unused before the signature gate), but must resolve so the module
// graph loads.
vi.mock('@/lib/whatsapp/meta-api', () => ({ getMediaUrl: vi.fn(), downloadMedia: vi.fn() }))
vi.mock('@/lib/whatsapp/mirror-inbound-media', () => ({ mirrorInboundMedia: vi.fn() }))
vi.mock('@/lib/contacts/find-or-create', () => ({ findOrCreateContact: vi.fn() }))
vi.mock('@/lib/conversations/find-or-create', () => ({ findOrCreateConversation: vi.fn() }))
vi.mock('@/lib/conversations/reopen', () => ({ reopenClosedConversation: vi.fn() }))
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: vi.fn() }))
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: vi.fn() }))
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: vi.fn() }))
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn() }))
vi.mock('@/lib/whatsapp/template-webhook', () => ({
  isTemplateWebhookField: () => false,
  handleTemplateWebhookChange: vi.fn(),
}))

import { POST } from './route'
import { encrypt } from '@/lib/whatsapp/encryption'

function sign(body: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
}

function messageBody(wabaId: string, phoneNumberId: string) {
  return JSON.stringify({
    entry: [
      {
        id: wabaId,
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: phoneNumberId },
              contacts: [],
              messages: [],
            },
          },
        ],
      },
    ],
  })
}

function templateBody(wabaId: string) {
  return JSON.stringify({
    entry: [
      {
        id: wabaId,
        changes: [
          {
            field: 'message_template_status_update',
            value: { message_template_id: '1', event: 'APPROVED' },
          },
        ],
      },
    ],
  })
}

function messageEntry(wabaId: string, phoneNumberId: string) {
  return {
    id: wabaId,
    changes: [
      {
        field: 'messages',
        value: { metadata: { phone_number_id: phoneNumberId }, contacts: [], messages: [] },
      },
    ],
  }
}

function templateEntry(wabaId: string) {
  return {
    id: wabaId,
    changes: [
      { field: 'message_template_status_update', value: { message_template_id: '1', event: 'APPROVED' } },
    ],
  }
}

/** A single delivery batching multiple entries — the cross-entry-intersection scenario. */
function multiEntryBody(...entries: Array<ReturnType<typeof messageEntry> | ReturnType<typeof templateEntry>>) {
  return JSON.stringify({ entry: entries })
}

function req(body: string, signature: string | null) {
  return {
    text: async () => body,
    headers: { get: (name: string) => (name === 'x-hub-signature-256' ? signature : null) },
  } as unknown as Request
}

beforeEach(() => {
  h.configs = []
})

describe('POST /api/whatsapp/webhook — multi-tenant signature verification', () => {
  it('tenant A signed with secret A verifies (200)', async () => {
    h.configs.push({
      id: 'cfg-a',
      account_id: 'acct-a',
      phone_number_id: 'pn-a',
      waba_id: 'waba-a',
      app_secret: encrypt('secret-a'),
    })
    const body = messageBody('waba-a', 'pn-a')
    const res = await POST(req(body, sign(body, 'secret-a')))
    expect(res.status).toBe(200)
  })

  it('tenant B signed with secret B verifies (200)', async () => {
    h.configs.push({
      id: 'cfg-b',
      account_id: 'acct-b',
      phone_number_id: 'pn-b',
      waba_id: 'waba-b',
      app_secret: encrypt('secret-b'),
    })
    const body = messageBody('waba-b', 'pn-b')
    const res = await POST(req(body, sign(body, 'secret-b')))
    expect(res.status).toBe(200)
  })

  it('tenant A signed with tenant B\'s secret is rejected (401)', async () => {
    h.configs.push(
      { id: 'cfg-a', account_id: 'acct-a', phone_number_id: 'pn-a', waba_id: 'waba-a', app_secret: encrypt('secret-a') },
      { id: 'cfg-b', account_id: 'acct-b', phone_number_id: 'pn-b', waba_id: 'waba-b', app_secret: encrypt('secret-b') },
    )
    const body = messageBody('waba-a', 'pn-a')
    const res = await POST(req(body, sign(body, 'secret-b')))
    expect(res.status).toBe(401)
  })

  it('a specific app_secret that is wrong does NOT fall back to the global META_APP_SECRET', async () => {
    h.configs.push({
      id: 'cfg-a',
      account_id: 'acct-a',
      phone_number_id: 'pn-a',
      waba_id: 'waba-a',
      app_secret: encrypt('secret-a'),
    })
    const body = messageBody('waba-a', 'pn-a')
    // Signed with the global secret instead of the tenant's own.
    const res = await POST(req(body, sign(body, process.env.META_APP_SECRET!)))
    expect(res.status).toBe(401)
  })

  it('a legacy config with no app_secret can still verify via the global META_APP_SECRET', async () => {
    h.configs.push({
      id: 'cfg-legacy',
      account_id: 'acct-legacy',
      phone_number_id: 'pn-legacy',
      waba_id: 'waba-legacy',
      app_secret: null,
    })
    const body = messageBody('waba-legacy', 'pn-legacy')
    const res = await POST(req(body, sign(body, process.env.META_APP_SECRET!)))
    expect(res.status).toBe(200)
  })

  it('resolves via phone_number_id for a standard message event', async () => {
    h.configs.push({
      id: 'cfg-a',
      account_id: 'acct-a',
      phone_number_id: 'pn-a',
      waba_id: 'waba-unrelated',
      app_secret: encrypt('secret-a'),
    })
    const body = messageBody('waba-different-from-config', 'pn-a')
    const res = await POST(req(body, sign(body, 'secret-a')))
    expect(res.status).toBe(200)
  })

  it('resolves via entry.id (waba_id) when there is no phone_number_id (template event)', async () => {
    h.configs.push({
      id: 'cfg-a',
      account_id: 'acct-a',
      phone_number_id: 'pn-a',
      waba_id: 'waba-a',
      app_secret: encrypt('secret-a'),
    })
    const body = templateBody('waba-a')
    const res = await POST(req(body, sign(body, 'secret-a')))
    expect(res.status).toBe(200)
  })

  it('a payload with no identifiable config is rejected (401), even with a validly-formed signature', async () => {
    const body = messageBody('waba-unknown', 'pn-unknown')
    const res = await POST(req(body, sign(body, process.env.META_APP_SECRET!)))
    expect(res.status).toBe(401)
  })

  it('rejects an invalid signature outright (401)', async () => {
    h.configs.push({
      id: 'cfg-a',
      account_id: 'acct-a',
      phone_number_id: 'pn-a',
      waba_id: 'waba-a',
      app_secret: encrypt('secret-a'),
    })
    const body = messageBody('waba-a', 'pn-a')
    const res = await POST(req(body, 'sha256=' + '0'.repeat(64)))
    expect(res.status).toBe(401)
  })
})

describe('POST /api/whatsapp/webhook — same-WABA precedence fix (Hallazgo 1)', () => {
  // WABA X: number A has its own app_secret; number B is legacy (no
  // app_secret, falls back to META_APP_SECRET). A webhook naming
  // phone_number_id=A must never be validatable via B's fallback.
  function seedSameWaba() {
    h.configs.push(
      { id: 'cfg-a', account_id: 'acct-a', phone_number_id: 'pn-a', waba_id: 'waba-x', app_secret: encrypt('secret-a') },
      { id: 'cfg-b', account_id: 'acct-b', phone_number_id: 'pn-b', waba_id: 'waba-x', app_secret: null },
    )
  }

  it('1. number A signed with the global META_APP_SECRET is rejected (401) — B\'s fallback must not leak in', async () => {
    seedSameWaba()
    const body = messageBody('waba-x', 'pn-a')
    const res = await POST(req(body, sign(body, process.env.META_APP_SECRET!)))
    expect(res.status).toBe(401)
  })

  it('2. the same payload signed with A\'s own app_secret verifies (200)', async () => {
    seedSameWaba()
    const body = messageBody('waba-x', 'pn-a')
    const res = await POST(req(body, sign(body, 'secret-a')))
    expect(res.status).toBe(200)
  })

  it('3. an event with no phone_number_id still resolves via the WABA (200), including B\'s legacy fallback', async () => {
    seedSameWaba()
    const body = templateBody('waba-x')
    const res = await POST(req(body, sign(body, process.env.META_APP_SECRET!)))
    expect(res.status).toBe(200)
  })
})

describe('POST /api/whatsapp/webhook — cross-entry intersection, not a global union (Hallazgo 3)', () => {
  it('1. entry A (secret A) + entry B (secret B), body signed with A -> 401', async () => {
    h.configs.push(
      { id: 'cfg-a', account_id: 'acct-a', phone_number_id: 'pn-a', waba_id: 'waba-a', app_secret: encrypt('secret-a') },
      { id: 'cfg-b', account_id: 'acct-b', phone_number_id: 'pn-b', waba_id: 'waba-b', app_secret: encrypt('secret-b') },
    )
    const body = multiEntryBody(messageEntry('waba-a', 'pn-a'), messageEntry('waba-b', 'pn-b'))
    const res = await POST(req(body, sign(body, 'secret-a')))
    expect(res.status).toBe(401)
  })

  it('2. entry A and entry B share the SAME app_secret X, body signed with X -> 200', async () => {
    h.configs.push(
      { id: 'cfg-a', account_id: 'acct-a', phone_number_id: 'pn-a', waba_id: 'waba-a', app_secret: encrypt('secret-x') },
      { id: 'cfg-b', account_id: 'acct-b', phone_number_id: 'pn-b', waba_id: 'waba-b', app_secret: encrypt('secret-x') },
    )
    const body = multiEntryBody(messageEntry('waba-a', 'pn-a'), messageEntry('waba-b', 'pn-b'))
    const res = await POST(req(body, sign(body, 'secret-x')))
    expect(res.status).toBe(200)
  })

  it('3. entry A (own secret A) + entry B (legacy, META_APP_SECRET) share no secret, body signed with A -> 401', async () => {
    h.configs.push(
      { id: 'cfg-a', account_id: 'acct-a', phone_number_id: 'pn-a', waba_id: 'waba-a', app_secret: encrypt('secret-a') },
      { id: 'cfg-b', account_id: 'acct-b', phone_number_id: 'pn-b', waba_id: 'waba-b', app_secret: null },
    )
    const body = multiEntryBody(messageEntry('waba-a', 'pn-a'), messageEntry('waba-b', 'pn-b'))
    const res = await POST(req(body, sign(body, 'secret-a')))
    expect(res.status).toBe(401)
  })

  it('4. entry message for number A ({A}) + entry template on the same WABA ({A, B}), signed with A -> 200', async () => {
    h.configs.push(
      { id: 'cfg-a', account_id: 'acct-a', phone_number_id: 'pn-a', waba_id: 'waba-x', app_secret: encrypt('secret-a') },
      { id: 'cfg-b', account_id: 'acct-b', phone_number_id: 'pn-b', waba_id: 'waba-x', app_secret: null },
    )
    const body = multiEntryBody(messageEntry('waba-x', 'pn-a'), templateEntry('waba-x'))
    const res = await POST(req(body, sign(body, 'secret-a')))
    expect(res.status).toBe(200)
  })

  it('5. a single-entry payload behaves exactly as before (no regression from the intersection change)', async () => {
    h.configs.push({ id: 'cfg-a', account_id: 'acct-a', phone_number_id: 'pn-a', waba_id: 'waba-a', app_secret: encrypt('secret-a') })
    const body = multiEntryBody(messageEntry('waba-a', 'pn-a'))
    const res = await POST(req(body, sign(body, 'secret-a')))
    expect(res.status).toBe(200)
  })
})
