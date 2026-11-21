import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const run = vi.fn()
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ admin: true }) }))
vi.mock('@/lib/conversations/finalized-return', async (orig) => ({ ...(await orig<typeof import('@/lib/conversations/finalized-return')>()), runFinalizedReturn: (...a: unknown[]) => run(...a) }))

import { GET } from './route'

const ENV = { ...process.env }
const call = (secret?: string) => GET(new Request('http://x', { headers: secret ? { 'x-cron-secret': secret } : {} }))

beforeEach(() => {
  run.mockReset().mockResolvedValue({ returned: 2, skipped: 1, errors: 0 })
  process.env.AUTOMATION_CRON_SECRET = 'cron-secret-value'
  delete process.env.ORDER_FINALIZED_GRACE_MINUTES
})
afterEach(() => {
  process.env = { ...ENV }
})

describe('GET /api/conversations/routing/cron', () => {
  it('same protection as the other crons: not configured -> 503; missing / wrong secret -> 401; nothing runs', async () => {
    delete process.env.AUTOMATION_CRON_SECRET
    expect((await call('x')).status).toBe(503)
    process.env.AUTOMATION_CRON_SECRET = 'cron-secret-value'
    expect((await call()).status).toBe(401)
    expect((await call('wrong-secret-valueX')).status).toBe(401)
    expect(run).not.toHaveBeenCalled()
  })

  it('a good secret applies what is due with the default 10-minute grace (independent of any Shalom switch) and reports counters only', async () => {
    delete process.env.SHALOM_TRACKING_ENABLED
    const r = await call('cron-secret-value')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ graceMinutes: 10, returned: 2, skipped: 1, errors: 0 })
    expect(run).toHaveBeenCalledWith({ admin: true }, { graceMinutes: 10 })
  })

  it('ORDER_FINALIZED_GRACE_MINUTES tunes QA only when valid; garbage falls back to 10', async () => {
    process.env.ORDER_FINALIZED_GRACE_MINUTES = '3'
    expect(await (await call('cron-secret-value')).json()).toMatchObject({ graceMinutes: 3 })
    process.env.ORDER_FINALIZED_GRACE_MINUTES = '-5'
    expect(await (await call('cron-secret-value')).json()).toMatchObject({ graceMinutes: 10 })
    process.env.ORDER_FINALIZED_GRACE_MINUTES = 'abc'
    expect(await (await call('cron-secret-value')).json()).toMatchObject({ graceMinutes: 10 })
  })

  it('a database failure is a 500 that leaks nothing', async () => {
    run.mockResolvedValueOnce({ returned: 0, skipped: 0, errors: 1 })
    expect((await call('cron-secret-value')).status).toBe(500)
    run.mockRejectedValueOnce(new Error('boom secret detail'))
    const r = await call('cron-secret-value')
    expect(r.status).toBe(500)
    expect(JSON.stringify(await r.json())).not.toContain('boom')
  })
})
