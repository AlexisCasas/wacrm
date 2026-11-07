import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { runSheetsExport, accounts, reconcileAccount, publishControl, loadDestination } = vi.hoisted(() => ({
  runSheetsExport: vi.fn(), accounts: ['acct-1', 'acct-2'], reconcileAccount: vi.fn(), publishControl: vi.fn(), loadDestination: vi.fn(),
}))
vi.mock('@/lib/orders/sheets/exporter', async (orig) => ({ ...(await orig<object>()), runSheetsExport, loadDestination }))
vi.mock('@/lib/orders/sheets/reconcile', () => ({ reconcileAccount }))
vi.mock('@/lib/orders/sheets/control', () => ({ publishControl }))
vi.mock('@/lib/orders/sheets/reconcile-run', async (orig) => ({ ...(await orig<object>()), DEFAULT_RETRY: { retries: 2, delayMs: 0 } }))
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
afterEach(() => { vi.unstubAllEnvs(); for (const m of [runSheetsExport, reconcileAccount, publishControl, loadDestination]) m.mockReset() })
const callReconcile = (q = '') => GET(new Request(`http://x/api/orders/sheets-export/cron?mode=reconcile${q}`, { headers: { 'x-cron-secret': 'right' } }))

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

describe('reconcile mode publishes to the control tab (server-written figures)', () => {
  const clean = { differences: 0, missingKeys: [], extraKeys: [], duplicateKeys: [], lineMismatches: [], contentMismatches: [], orderAmountMismatches: [], projectionErrors: [], jobsByStatus: {} }
  const lag = { ...clean, missingKeys: ['o:1'], differences: 4 }
  const prep = () => { runSheetsExport.mockResolvedValue(emptyResult(true)); loadDestination.mockResolvedValue({ spreadsheet_id: 'S'.repeat(30) }); publishControl.mockResolvedValue(undefined) }
  it('publishes one pass per account and answers 200 when there are no differences', async () => {
    env(); prep(); reconcileAccount.mockResolvedValue(clean)
    const res = await callReconcile(); expect(res.status).toBe(200); expect(publishControl).toHaveBeenCalledTimes(2)
  })
  it('differences -> 500 attention (but the figures are still published so the sheet shows them)', async () => {
    env(); prep(); reconcileAccount.mockResolvedValue({ ...clean, duplicateKeys: ['k'], differences: 2 })
    const res = await callReconcile(); expect(res.status).toBe(500); expect(publishControl).toHaveBeenCalled()
  })
  it('a failed publish is attention, not success', async () => {
    env(); prep(); publishControl.mockRejectedValue(new Error('boom')); reconcileAccount.mockResolvedValue(clean)
    expect((await callReconcile()).status).toBe(500)
  })
  it('sync runs before every comparison; lag that clears on the retry answers 200 and is published once, from the FINAL comparison', async () => {
    env(); prep(); reconcileAccount.mockResolvedValueOnce(lag).mockResolvedValue(clean)
    const res = await callReconcile(); const body = await res.json()
    expect(res.status).toBe(200); expect(body.status).toBe('ok'); expect(body.attempts).toBe(2)
    expect(body.accounts['acct-1']).toMatchObject({ attempts: 2, recoveredAfterRetry: true })
    expect(runSheetsExport.mock.invocationCallOrder[0]).toBeLessThan(reconcileAccount.mock.invocationCallOrder[0])
    expect(publishControl).toHaveBeenCalledTimes(2)             // one per account, never the transient lag
    expect(publishControl.mock.calls.every((c) => c[2].differences === 0)).toBe(true)
  })
  it('lag that never clears is 500 persistent_lag after exactly 3 comparisons per account, and the sheet is told', async () => {
    env(); prep(); reconcileAccount.mockResolvedValue(lag)
    const res = await callReconcile(); const body = await res.json()
    expect(res.status).toBe(500); expect(body.attention[0].reasons).toEqual(['persistent_lag']); expect(reconcileAccount).toHaveBeenCalledTimes(6)
    expect(publishControl.mock.calls.every((c) => c[2].differences === 4)).toBe(true)
  })
  it('presync=0 compares without exporting and without retries', async () => {
    env(); prep(); reconcileAccount.mockResolvedValue(lag)
    expect((await callReconcile('&presync=0&publish=0')).status).toBe(500); expect(runSheetsExport).not.toHaveBeenCalled(); expect(reconcileAccount).toHaveBeenCalledTimes(2)
  })
  it('publish=0 keeps the pass strictly read-only', async () => {
    env(); prep(); reconcileAccount.mockResolvedValue(clean)
    expect((await callReconcile('&publish=0')).status).toBe(200); expect(publishControl).not.toHaveBeenCalled()
  })
})
