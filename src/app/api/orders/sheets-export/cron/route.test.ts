import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET } from './route'

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => { throw new Error('db must not be touched') } }))
const req = (secret?: string, q = '') => new Request(`http://x/api/orders/sheets-export/cron${q}`, { headers: secret ? { 'x-cron-secret': secret } : {} })
afterEach(() => vi.unstubAllEnvs())

describe('sheets export cron route', () => {
  it('is closed without the cron secret configured or supplied', async () => {
    vi.stubEnv('AUTOMATION_CRON_SECRET', '')
    expect((await GET(req('x'))).status).toBe(503)
    vi.stubEnv('AUTOMATION_CRON_SECRET', 'right')
    expect((await GET(req())).status).toBe(401)
    expect((await GET(req('wrong'))).status).toBe(401)
    expect((await GET(req('right', '?mode=drop'))).status).toBe(400)
  })
  it('global switch off: answers enabled:false and never touches the database', async () => {
    vi.stubEnv('AUTOMATION_CRON_SECRET', 'right'); vi.stubEnv('ORDERS_SHEETS_EXPORT_ENABLED', 'false')
    const r = await GET(req('right')); expect(r.status).toBe(200); expect(await r.json()).toEqual({ enabled: false })
  })
})
