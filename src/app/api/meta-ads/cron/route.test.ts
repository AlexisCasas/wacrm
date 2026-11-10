import { describe, expect, it, vi } from 'vitest'

const run = vi.fn()
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({}) }))
vi.mock('@/lib/meta-ads/sync', () => ({ runMetaAdsSync: (...a: unknown[]) => run(...a) }))
vi.mock('@/lib/meta-ads/sync-store', () => ({ createSupabaseSyncStore: () => ({}) }))
import { GET } from './route'

const req = (secret?: string) => new Request('http://x/api/meta-ads/cron', { headers: secret ? { 'x-cron-secret': secret } : {} })

describe('GET /api/meta-ads/cron', () => {
  it('503 without configured secret, 401 with a wrong one; the sync never runs', async () => {
    delete process.env.AUTOMATION_CRON_SECRET
    expect((await GET(req('x'))).status).toBe(503)
    process.env.AUTOMATION_CRON_SECRET = 'right-secret'
    expect((await GET(req('wrong'))).status).toBe(401)
    expect((await GET(req())).status).toBe(401)
    expect(run).not.toHaveBeenCalled()
  })
  it('runs with the right secret and contains errors (500, no leak)', async () => {
    process.env.AUTOMATION_CRON_SECRET = 'right-secret'
    run.mockResolvedValueOnce({ enabled: false })
    expect(await (await GET(req('right-secret'))).json()).toEqual({ enabled: false })
    run.mockRejectedValueOnce(new Error('boom with EAAB-token'))
    const res = await GET(req('right-secret'))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('EAAB')
  })
})
