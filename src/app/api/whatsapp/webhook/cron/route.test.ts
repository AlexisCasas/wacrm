import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  drain: vi.fn(),
  rpc: vi.fn(),
}))

vi.mock('next/server', () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number; headers?: Record<string,string> }) => ({
    status: init?.status ?? 200, body, headers: init?.headers ?? {},
  }) },
}))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ rpc: h.rpc }),
}))
vi.mock('@/lib/whatsapp/webhook-inbox', () => ({ drainWebhookInbox: h.drain }))
vi.mock('@/lib/whatsapp/webhook-processor', () => ({ processWebhook: vi.fn() }))

import { GET, POST } from './route'

function req(secret: string, body?: string): Request {
  return { headers: { get: (name: string) => name === 'x-cron-secret' ? secret : null },
    json: async () => body ? JSON.parse(body) : {} } as unknown as Request
}

beforeEach(() => {
  process.env.AUTOMATION_CRON_SECRET = 'qa-secret-at-least-24-characters'
  h.drain.mockReset().mockResolvedValue({ claimed: 2, processed: 2, failed: 0 })
  h.rpc.mockReset().mockResolvedValue({ data: 3, error: null })
})

describe('POST-only protected webhook recovery cron', () => {
  it('GET never processes an event', () => {
    const res = GET()
    expect(res.status).toBe(405)
    expect(h.drain).not.toHaveBeenCalled()
  })

  it('refuses unauthenticated requests before touching the queue', async () => {
    const res = await POST(req('wrong'))
    expect(res.status).toBe(401)
    expect(h.drain).not.toHaveBeenCalled()
  })

  it('fails closed when no strong cron secret is configured', async () => {
    process.env.AUTOMATION_CRON_SECRET = 'short'
    expect((await POST(req('short'))).status).toBe(503)
    expect(h.drain).not.toHaveBeenCalled()
  })

  it('processes a bounded batch and prunes completed events', async () => {
    const res = await POST(req('qa-secret-at-least-24-characters','{"limit":500}'))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ claimed: 2, processed: 2, failed: 0, pruned: 3 })
    expect(h.drain).toHaveBeenCalledTimes(1)
    expect(h.drain.mock.calls[0][2]).toMatchObject({ limit: 20 })
    expect(h.rpc).toHaveBeenCalledWith('whatsapp_webhook_inbox_prune',{ p_limit: 200 })
  })

  it('returns 503 when claiming the queue fails', async () => {
    h.drain.mockRejectedValueOnce(new Error('database unavailable'))
    expect((await POST(req('qa-secret-at-least-24-characters'))).status).toBe(503)
  })
})
