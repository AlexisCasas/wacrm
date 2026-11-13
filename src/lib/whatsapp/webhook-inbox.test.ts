import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { drainWebhookInbox, enqueueVerifiedWebhook } from './webhook-inbox'

const h = vi.hoisted(() => ({
  call: vi.fn(),
}))

function db(): SupabaseClient {
  return { rpc: h.call } as unknown as SupabaseClient
}

beforeEach(() => {
  h.call.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
import { afterEach } from 'vitest'
afterEach(() => vi.restoreAllMocks())

describe('durable WhatsApp webhook queue', () => {
  it('enqueues authenticated payload by SHA-256 of the EXACT raw body', async () => {
    const raw = '{ "entry": [] }'
    const parsed = { entry: [] }
    h.call.mockResolvedValue({ data: 'event-1', error: null })
    const id = await enqueueVerifiedWebhook(db(), raw, parsed)
    expect(id).toBe('event-1')
    expect(h.call).toHaveBeenCalledWith('whatsapp_webhook_inbox_enqueue', {
      p_digest: createHash('sha256').update(raw).digest('hex'),
      p_payload: parsed,
    })
  })

  it('does NOT acknowledge persistence on a DB failure', async () => {
    h.call.mockResolvedValue({ data: null, error: { code: '503' } })
    await expect(enqueueVerifiedWebhook(db(), '{"entry":[]}', { entry: [] })).rejects.toThrow('webhook_enqueue_failed')
  })

  it('claims, processes and acknowledges a single event', async () => {
    const payload = { entry: [{ id: 'qa' }] }
    h.call.mockImplementation((name: string) => Promise.resolve(
      name === 'whatsapp_webhook_inbox_claim'
        ? { data: [{ id: 'event-1', token: 'lease-1', payload }], error: null }
        : { data: true, error: null },
    ))
    const handler = vi.fn(async () => {})
    const result = await drainWebhookInbox(db(), handler, { eventId: 'event-1' })
    expect(result).toEqual({ claimed: 1, processed: 1, failed: 0 })
    expect(handler).toHaveBeenCalledWith(payload)
    expect(h.call).toHaveBeenCalledWith('whatsapp_webhook_inbox_complete', { p_id: 'event-1', p_token: 'lease-1' })
    expect(h.call).not.toHaveBeenCalledWith('whatsapp_webhook_inbox_fail', expect.anything())
  })

  it('returns without dispatch when another worker holds the lease or the event is already done', async () => {
    h.call.mockResolvedValue({ data: [], error: null })
    const handler = vi.fn()
    expect(await drainWebhookInbox(db(), handler, { eventId: 'event-1' })).toEqual({ claimed: 0, processed: 0, failed: 0 })
    expect(handler).not.toHaveBeenCalled()
  })

  it('defers a failed handler and never logs message contents', async () => {
    h.call.mockImplementation((name: string) => Promise.resolve(
      name === 'whatsapp_webhook_inbox_claim'
        ? { data: [{ id: 'event-1', token: 'lease-1', payload: { entry: ['secreto privado'] } }], error: null }
        : { data: true, error: null },
    ))
    const handler = vi.fn(async () => { throw new Error('secreto privado') })
    const result = await drainWebhookInbox(db(), handler, { eventId: 'event-1' })
    expect(result).toEqual({ claimed: 1, processed: 0, failed: 1 })
    expect(h.call).toHaveBeenCalledWith('whatsapp_webhook_inbox_fail', {
      p_id: 'event-1', p_token: 'lease-1', p_error_code: 'processing_failed',
    })
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls)
    expect(logged).not.toContain('secreto privado')
  })

  it('fences a late completion and queues for retry rather than marking it processed', async () => {
    h.call.mockImplementation((name: string) => Promise.resolve(
      name === 'whatsapp_webhook_inbox_claim'
        ? { data: [{ id: 'event-1', token: 'lease-stale', payload: {} }], error: null }
        : name === 'whatsapp_webhook_inbox_complete'
          ? { data: false, error: null }
          : { data: true, error: null },
    ))
    const result = await drainWebhookInbox(db(), async () => {}, { eventId: 'event-1' })
    expect(result.failed).toBe(1)
    expect(h.call).toHaveBeenCalledWith('whatsapp_webhook_inbox_fail', expect.objectContaining({ p_id: 'event-1' }))
  })

  it('does not process anything when atomic claim fails', async () => {
    h.call.mockResolvedValue({ data: null, error: { code: 'PGRST503' } })
    const handler = vi.fn()
    await expect(drainWebhookInbox(db(), handler)).rejects.toThrow('webhook_claim_failed')
    expect(handler).not.toHaveBeenCalled()
  })
})
