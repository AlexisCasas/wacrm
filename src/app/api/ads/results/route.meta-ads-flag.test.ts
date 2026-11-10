import { beforeEach, describe, expect, it, vi } from 'vitest'

const requireRole = vi.fn()
const rpc = vi.fn()
const jobs = vi.fn()
vi.mock('@/lib/auth/account', () => ({ requireRole: (...a: unknown[]) => requireRole(...a), toErrorResponse: () => new Response('{}', { status: 500 }) }))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (t: string) => ({
      // capi / catalog sync-state lookups: maybeSingle; jobs listing: the awaited eq() itself
      select: () => ({ eq: () => ({
        // lazy thenable: the jobs lookup only runs (and may reject) when the route awaits it
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(() => jobs(t)).then(res, rej),
        ...{ maybeSingle: async () => ({ data: null, error: null }), eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) },
      }) }),
    }),
  }),
}))
import { GET } from './route'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const norm = (b: Record<string, unknown>) => JSON.stringify({ ...b, period: undefined })
beforeEach(() => {
  for (const f of [requireRole, rpc, jobs]) f.mockReset()
  requireRole.mockResolvedValue({ supabase: { rpc }, accountId: A, userId: 'u' })
  rpc.mockResolvedValue({ data: [], error: null })
})

describe('GET /api/ads/results — Meta Ads section flag', () => {
  it('flags the section only when the insights sync exists for the session account; every other field is identical', async () => {
    jobs.mockResolvedValue({ data: [], error: null })
    const base = await (await GET(new Request('http://x/api/ads/results'))).json()
    expect(base.meta_ads).toBeUndefined()
    jobs.mockResolvedValue({ data: [{ job: 'catalog' }], error: null })
    expect((await (await GET(new Request('http://x/api/ads/results'))).json()).meta_ads).toBeUndefined()
    jobs.mockResolvedValue({ data: [{ job: 'catalog' }, { job: 'insights' }], error: null })
    const flagged = await (await GET(new Request('http://x/api/ads/results'))).json()
    expect(flagged.meta_ads).toEqual({ configured: true })
    expect(norm({ ...flagged, meta_ads: undefined })).toBe(norm(base))
  })
  it('FALLBACK: a failing lookup leaves the report exactly as it was (200)', async () => {
    jobs.mockResolvedValue({ data: [], error: null })
    const base = norm(await (await GET(new Request('http://x/api/ads/results'))).json())
    jobs.mockRejectedValue(new Error('relation does not exist'))
    const res = await GET(new Request('http://x/api/ads/results'))
    expect(res.status).toBe(200)
    expect(norm(await res.json())).toBe(base)
  })
})
