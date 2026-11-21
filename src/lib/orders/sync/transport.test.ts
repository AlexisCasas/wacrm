import { describe, expect, it, vi } from 'vitest'

import { deliverSyncEvent, readOrderSyncConfig, type ClaimedSyncEvent } from './transport'

const row: ClaimedSyncEvent = {
  event_id: '11111111-1111-4111-8111-111111111111',
  origin_system: 'wacrm',
  origin_event_id: '22222222-2222-4222-8222-222222222222',
  canonical_order_id: '33333333-3333-4333-8333-333333333333',
  event_type: 'payment.snapshot',
  event_version: 1,
  idempotency_key: 'payment.snapshot:test',
  occurred_at: '2026-11-21T23:00:00Z',
  payload: { total: 135, paid: 30, balance: 105 },
  attempts: 1,
  claim_token: '44444444-4444-4444-8444-444444444444',
}

describe('order sync transport', () => {
  it('is globally off unless enabled, URL and token are all present', () => {
    expect(readOrderSyncConfig({ ORDER_SYNC_ENABLED: 'false' } as NodeJS.ProcessEnv)).toBeNull()
    expect(readOrderSyncConfig({
      ORDER_SYNC_ENABLED: 'true',
      INKACLICK_SYNC_EVENTS_URL: 'https://example.invalid/sync',
      ORDER_SYNC_TOKEN: 'secret',
    } as NodeJS.ProcessEnv)).toEqual({ url: 'https://example.invalid/sync', token: 'secret' })
  })

  it('sends only the event envelope and uses origin_event_id as idempotency key', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      expect(body.canonical_order_id).toBe(row.canonical_order_id)
      expect(body.payload).toEqual(row.payload)
      expect((init?.headers as Record<string, string>)['idempotency-key']).toBe(row.origin_event_id)
      return new Response(JSON.stringify({ status: 'applied' }), { status: 200 })
    }) as unknown as typeof fetch
    await expect(deliverSyncEvent(row, { url: 'https://example.invalid', token: 'secret' }, fetchImpl)).resolves.toEqual({ outcome: 'applied', code: null })
  })

  it('classifies conflict, retry and permanent rejection', async () => {
    const response = (status: number, code: string) => vi.fn(async () => new Response(JSON.stringify({ code }), { status })) as unknown as typeof fetch
    await expect(deliverSyncEvent(row, { url: 'https://x.invalid', token: 'x' }, response(409, 'wacrm_ahead'))).resolves.toEqual({ outcome: 'conflict', code: 'wacrm_ahead' })
    await expect(deliverSyncEvent(row, { url: 'https://x.invalid', token: 'x' }, response(503, 'busy'))).resolves.toEqual({ outcome: 'retry', code: 'busy' })
    await expect(deliverSyncEvent(row, { url: 'https://x.invalid', token: 'x' }, response(422, 'unsupported_event_type'))).resolves.toEqual({ outcome: 'dead_letter', code: 'unsupported_event_type' })
  })
})
