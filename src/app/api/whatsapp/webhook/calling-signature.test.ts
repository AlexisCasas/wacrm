import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => Promise<void> | void>,
  resolvedSecrets: ['calling-tenant-secret'] as string[],
  enqueued: [] as Array<{ rawBody: string; payload: unknown }>,
  processed: [] as unknown[],
  queuedPayload: null as unknown,
}))

vi.mock('next/server', () => ({
  after: (callback: () => Promise<void> | void) => {
    h.afterCallbacks.push(callback)
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => new Response(JSON.stringify(body), {
      status: init?.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  },
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({}),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'verify-token',
  encrypt: (value: string) => value,
  isLegacyFormat: () => false,
}))

vi.mock('@/lib/whatsapp/webhook-tenant-secret', () => ({
  resolveWebhookSignatureSecrets: async () => h.resolvedSecrets,
}))

vi.mock('@/lib/whatsapp/webhook-inbox', () => ({
  enqueueVerifiedWebhook: async (_db: unknown, rawBody: string, payload: unknown) => {
    h.enqueued.push({ rawBody, payload })
    h.queuedPayload = payload
    return 'qa-calling-webhook-event'
  },
  drainWebhookInbox: async (
    _db: unknown,
    handler: (payload: unknown) => Promise<void>,
  ) => {
    await handler(h.queuedPayload)
    return { claimed: 1, processed: 1, failed: 0 }
  },
}))

vi.mock('@/lib/whatsapp/webhook-processor', () => ({
  processWebhook: async (payload: unknown) => {
    h.processed.push(payload)
  },
}))

import { POST } from './route'

const SECRET = 'calling-tenant-secret'

function callingPayload() {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: '1100749476063768',
      changes: [{
        field: 'calls',
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: '740434745820831' },
          calls: [{
            id: 'wacid.qa-signed-call',
            event: 'connect',
            timestamp: '1795120000',
            direction: 'USER_INITIATED',
            from: '51911111111',
          }],
        },
      }],
    }],
  }
}

function signedRequest(rawBody: string, signedBody = rawBody): Request {
  const signature = 'sha256=' + createHmac('sha256', SECRET).update(signedBody).digest('hex')
  return new Request('https://crm.example.test/api/whatsapp/webhook', {
    method: 'POST',
    headers: { 'x-hub-signature-256': signature },
    body: rawBody,
  })
}

beforeEach(() => {
  h.afterCallbacks = []
  h.resolvedSecrets = [SECRET]
  h.enqueued = []
  h.processed = []
  h.queuedPayload = null
})

describe('CALL-02 signed Calling webhook delivery', () => {
  it('accepts a valid Meta HMAC, durably queues the calls change, then drains it', async () => {
    const payload = callingPayload()
    const rawBody = JSON.stringify(payload)

    const response = await POST(signedRequest(rawBody))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'queued' })
    expect(h.enqueued).toHaveLength(1)
    expect(h.enqueued[0]).toEqual({ rawBody, payload })
    expect(h.afterCallbacks).toHaveLength(1)

    await h.afterCallbacks[0]!()

    expect(h.processed).toEqual([payload])
  })

  it('rejects a body changed after signing and does not enqueue or process it', async () => {
    const original = JSON.stringify(callingPayload())
    const tampered = original.replace('wacid.qa-signed-call', 'wacid.injected-call')

    const response = await POST(signedRequest(tampered, original))

    expect(response.status).toBe(401)
    expect(h.enqueued).toHaveLength(0)
    expect(h.afterCallbacks).toHaveLength(0)
    expect(h.processed).toHaveLength(0)
  })

  it('fails closed when no tenant secret can be resolved for the calls payload', async () => {
    h.resolvedSecrets = []
    const rawBody = JSON.stringify(callingPayload())

    const response = await POST(signedRequest(rawBody))

    expect(response.status).toBe(401)
    expect(h.enqueued).toHaveLength(0)
    expect(h.afterCallbacks).toHaveLength(0)
    expect(h.processed).toHaveLength(0)
  })

  it('rejects a signature made with another tenant app secret', async () => {
    const rawBody = JSON.stringify(callingPayload())
    const otherSecretSignature = 'sha256=' + createHmac('sha256', 'other-tenant-secret').update(rawBody).digest('hex')
    const request = new Request('https://crm.example.test/api/whatsapp/webhook', {
      method: 'POST',
      headers: { 'x-hub-signature-256': otherSecretSignature },
      body: rawBody,
    })

    const response = await POST(request)

    expect(response.status).toBe(401)
    expect(h.enqueued).toHaveLength(0)
    expect(h.processed).toHaveLength(0)
  })
})
