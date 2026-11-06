import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { runSheetsExport, accounts } = vi.hoisted(() => ({ runSheetsExport: vi.fn(), accounts: ['acct-1', 'acct-2'] }))
vi.mock('@/lib/orders/sheets/exporter', async (orig) => ({ ...(await orig<object>()), runSheetsExport }))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ from: () => ({ select: () => ({ eq: async () => ({ data: accounts.map((account_id) => ({ account_id })), error: null }) }) }) }),
}))
import { emptyResult } from '@/lib/orders/sheets/exporter'
import { GET } from './route'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
const call = () => GET(new Request('http://x/api/orders/sheets-export/cron', { headers: { 'x-cron-secret': 'right' } }))
function env() {
  vi.stubEnv('AUTOMATION_CRON_SECRET', 'right'); vi.stubEnv('ORDERS_SHEETS_EXPORT_ENABLED', 'true'); vi.stubEnv('GOOGLE_SHEETS_SA_EMAIL', 'sa@x.invalid')
  vi.stubEnv('GOOGLE_SHEETS_SA_KEY_B64', Buffer.from(privateKey).toString('base64'))
}
afterEach(() => { vi.unstubAllEnvs(); runSheetsExport.mockReset() })

describe('cron route observability (regression)', () => {
  it('all accounts fine -> 200 ok', async () => {
    env(); runSheetsExport.mockResolvedValue(emptyResult(true))
    const res = await call(); expect(res.status).toBe(200); expect((await res.json()).status).toBe('ok')
  })
  it('expected retry -> still 200, flagged retrying', async () => {
    env(); runSheetsExport.mockResolvedValue({ ...emptyResult(true), retried: 2, error: 'google_5xx' })
    const res = await call(); expect(res.status).toBe(200); expect((await res.json()).status).toBe('retrying')
  })
  it('one account throwing -> 500 and the other account still ran', async () => {
    env(); runSheetsExport.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(emptyResult(true))
    const res = await call(); const body = await res.json()
    expect(res.status).toBe(500); expect(body.status).toBe('attention'); expect(body.attention).toEqual([{ account: 'acct-1', reasons: ['account_failed'] }])
    expect(runSheetsExport).toHaveBeenCalledTimes(2); expect(JSON.stringify(body)).not.toContain('boom')
  })
  it('dead jobs outstanding -> 500', async () => {
    env(); runSheetsExport.mockResolvedValue({ ...emptyResult(true), deadOutstanding: 1 })
    expect((await call()).status).toBe(500)
  })
})
