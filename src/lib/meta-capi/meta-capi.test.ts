import { describe, expect, it, vi } from 'vitest'
import { buildCapiBody, capiUrl, sendCapiEvent, type CapiRow } from './client'
import { capiGloballyEnabled, capiRetryDelayMs, runCapiWorker } from './worker'
import { buildAdsReport } from './report'
import { recordAdClick } from '../whatsapp/ad-click-history'

const TOKEN = 'EAAB-secret-token-xyz'
const row = (over: Partial<CapiRow & { id: string; account_id: string; attempts: number; access_token_enc: string }> = {}) => ({
  id: 'e1', account_id: 'acc-A', attempts: 1, access_token_enc: 'enc', event_name: 'OrderCreated', event_id: 'wacrm:acc-A:o1:OrderCreated',
  ctwa_clid: 'CLID-SYNTH-1', event_time: '2026-11-07T10:00:00.000Z', value: '199.80', currency: 'PEN', dataset_id: '123456789', waba_id: '987654321',
  api_version: 'v27.0', partner_agent: 'wacrm', ...over,
})
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers })

// A fetch that fails the test if anything ever reaches a real URL.
const noNetwork = () => vi.fn(async () => { throw new Error('REAL NETWORK CALL') })

function fakeAdmin(due: unknown[], finish: string | ((a: Record<string, unknown>) => string) = 'sent') {
  const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    if (name === 'meta_capi_enqueue') return { data: 2, error: null }
    if (name === 'meta_capi_claim') return { data: due, error: null }
    if (name === 'meta_capi_finish') return { data: typeof finish === 'function' ? finish(args ?? {}) : finish, error: null }
    return { data: null, error: null }
  })
  return { admin: { rpc } as never, rpc }
}

describe('payload (official Business Messaging shape)', () => {
  it('uses business_messaging/whatsapp with ctwa_clid + WABA and order value', () => {
    const b = buildCapiBody(row())
    expect(b.partner_agent).toBe('wacrm')
    expect(b.data[0]).toEqual({
      event_name: 'OrderCreated', event_time: 1794045600, action_source: 'business_messaging', messaging_channel: 'whatsapp',
      user_data: { whatsapp_business_account_id: '987654321', ctwa_clid: 'CLID-SYNTH-1' }, custom_data: { currency: 'PEN', value: 199.8 },
    })
    expect(capiUrl(row())).toBe('https://graph.facebook.com/v27.0/123456789/events')
  })
  it('omits custom_data without a value and never carries phone/name/email', () => {
    const b = buildCapiBody(row({ value: null, currency: null }))
    expect(b.data[0]).not.toHaveProperty('custom_data')
    expect(JSON.stringify(b)).not.toMatch(/phone|customer_name|email|"em"|"ph"|"fn"|"ln"/)
  })
})

describe('test_event_code (test mode)', () => {
  it('is added to the body only when set, so production traffic never carries it', () => {
    expect(buildCapiBody(row({ test_event_code: 'TEST12345' })).test_event_code).toBe('TEST12345')
    expect(buildCapiBody(row({ test_event_code: null }))).not.toHaveProperty('test_event_code')
    expect(buildCapiBody(row())).not.toHaveProperty('test_event_code')
  })
  it('the worker forwards the account\'s code from the claimed row (mocked fetch)', async () => {
    const { admin } = fakeAdmin([row({ test_event_code: 'TEST999' })])
    const f = vi.fn().mockResolvedValue(json(200, {}))
    await runCapiWorker(admin, { enabled: true, fetchImpl: f, decryptToken: () => TOKEN })
    expect(JSON.parse((f.mock.calls[0][1] as RequestInit).body as string).test_event_code).toBe('TEST999')
  })
})

describe('sendCapiEvent classification (mocked fetch)', () => {
  it('sends the token in the Authorization header, never in the URL', async () => {
    const f = vi.fn().mockResolvedValue(json(200, { events_received: 1 }))
    expect(await sendCapiEvent(row(), TOKEN, f)).toEqual({ kind: 'sent', httpStatus: 200 })
    const [url, init] = f.mock.calls[0]
    expect(String(url)).not.toContain(TOKEN)
    expect((init as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` })
  })
  it('Meta outage / 5xx / 429 / network error are retried', async () => {
    expect(await sendCapiEvent(row(), TOKEN, vi.fn().mockResolvedValue(json(503, {})))).toMatchObject({ kind: 'retry', code: 'http_503' })
    expect(await sendCapiEvent(row(), TOKEN, vi.fn().mockResolvedValue(json(429, {}, { 'retry-after': '30' })))).toMatchObject({ kind: 'retry', retryAfterMs: 30000 })
    expect(await sendCapiEvent(row(), TOKEN, vi.fn().mockResolvedValue(json(400, { error: { code: 4 } })))).toMatchObject({ kind: 'retry', code: 'meta_4' })
    expect(await sendCapiEvent(row(), TOKEN, vi.fn().mockRejectedValue(new Error('ECONNRESET')))).toMatchObject({ kind: 'retry', code: 'network' })
  })
  it('token/permission errors trip the breaker; other 4xx are rejected', async () => {
    expect(await sendCapiEvent(row(), TOKEN, vi.fn().mockResolvedValue(json(401, { error: { code: 190 } })))).toMatchObject({ kind: 'auth', code: 'meta_190' })
    expect(await sendCapiEvent(row(), TOKEN, vi.fn().mockResolvedValue(json(400, { error: { code: 200 } })))).toMatchObject({ kind: 'auth' })
    expect(await sendCapiEvent(row(), TOKEN, vi.fn().mockResolvedValue(json(400, { error: { code: 100, error_subcode: 33 } })))).toMatchObject({ kind: 'rejected', detail: 'http 400 code 100 sub 33' })
  })
  it('sanitized detail never echoes Meta free text, the token or the click id', async () => {
    const o = await sendCapiEvent(row(), TOKEN, vi.fn().mockResolvedValue(json(400, { error: { code: 100, message: `bad ${TOKEN} CLID-SYNTH-1 51900000001` } })))
    expect(JSON.stringify(o)).not.toMatch(/EAAB|CLID-SYNTH|5190/)
  })
})

describe('runCapiWorker', () => {
  it('integration disabled (global switch): no RPC, no network', async () => {
    const { admin, rpc } = fakeAdmin([row()])
    const f = noNetwork()
    expect(await runCapiWorker(admin, { enabled: false, fetchImpl: f })).toMatchObject({ enabled: false, enqueued: 0, claimed: 0 })
    expect(rpc).not.toHaveBeenCalled()
    expect(f).not.toHaveBeenCalled()
    expect(capiGloballyEnabled({} as never)).toBe(false)
    expect(capiGloballyEnabled({ META_CAPI_ENABLED: '1' } as never)).toBe(false)
    expect(capiGloballyEnabled({ META_CAPI_ENABLED: 'true' } as never)).toBe(true)
  })
  it('no accounts enabled/with credentials: claim returns nothing, nothing is sent', async () => {
    const { admin } = fakeAdmin([])
    const f = noNetwork()
    expect(await runCapiWorker(admin, { enabled: true, fetchImpl: f })).toMatchObject({ enqueued: 2, claimed: 0, sent: 0 })
    expect(f).not.toHaveBeenCalled()
  })
  it('sends a claimed event with the account\'s own dataset/WABA/token and reports success', async () => {
    const { admin, rpc } = fakeAdmin([row()])
    const f = vi.fn().mockResolvedValue(json(200, {}))
    const r = await runCapiWorker(admin, { enabled: true, fetchImpl: f, decryptToken: () => TOKEN })
    expect(r).toMatchObject({ claimed: 1, sent: 1 })
    expect(f).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('meta_capi_finish', expect.objectContaining({ p_event: 'e1', p_attempt: 1, p_outcome: 'sent', p_retry_at: null }))
  })
  it('two accounts in one tick use their own credentials (isolation)', async () => {
    const { admin } = fakeAdmin([row({ id: 'a', account_id: 'A', dataset_id: '111111', access_token_enc: 'encA' }), row({ id: 'b', account_id: 'B', dataset_id: '222222', access_token_enc: 'encB' })])
    const f = vi.fn().mockResolvedValue(json(200, {}))
    await runCapiWorker(admin, { enabled: true, fetchImpl: f, decryptToken: (e) => `tok-${e}` })
    expect(String(f.mock.calls[0][0])).toContain('/111111/events')
    expect((f.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok-encA' })
    expect(String(f.mock.calls[1][0])).toContain('/222222/events')
    expect((f.mock.calls[1][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok-encB' })
  })
  it('Meta error is retried with backoff and does not throw; attempts exhausted -> dead', async () => {
    const now = Date.parse('2026-11-07T00:00:00Z')
    const { admin, rpc } = fakeAdmin([row({ attempts: 3 })], 'pending')
    const r = await runCapiWorker(admin, { enabled: true, fetchImpl: vi.fn().mockResolvedValue(json(500, {})), decryptToken: () => TOKEN, now: () => now, random: () => 0.5 })
    expect(r).toMatchObject({ retried: 1, sent: 0 })
    const call = rpc.mock.calls.find((c) => c[0] === 'meta_capi_finish')![1] as Record<string, unknown>
    expect(Date.parse(call.p_retry_at as string) - now).toBe(240_000)
    const d = fakeAdmin([row({ attempts: 6 })], 'dead')
    expect(await runCapiWorker(d.admin, { enabled: true, fetchImpl: vi.fn().mockResolvedValue(json(500, {})), decryptToken: () => TOKEN })).toMatchObject({ dead: 1 })
  })
  it('auth failure and unreadable token are reported as auth (SQL switches the account off)', async () => {
    const a = fakeAdmin([row()], 'pending')
    expect(await runCapiWorker(a.admin, { enabled: true, fetchImpl: vi.fn().mockResolvedValue(json(401, { error: { code: 190 } })), decryptToken: () => TOKEN })).toMatchObject({ disabledAccounts: 1 })
    const b = fakeAdmin([row()], 'pending')
    const f = noNetwork()
    await runCapiWorker(b.admin, { enabled: true, fetchImpl: f, decryptToken: () => { throw new Error('bad key') } })
    expect(f).not.toHaveBeenCalled()
    expect(b.rpc).toHaveBeenCalledWith('meta_capi_finish', expect.objectContaining({ p_outcome: 'auth', p_code: 'token_unreadable' }))
  })
  it('duplicate delivery of the same claim (stale lease) is not double counted', async () => {
    const { admin } = fakeAdmin([row()], 'stale')
    expect(await runCapiWorker(admin, { enabled: true, fetchImpl: vi.fn().mockResolvedValue(json(200, {})), decryptToken: () => TOKEN })).toMatchObject({ sent: 0, retried: 0, dead: 0 })
  })
  it('backoff grows and is capped', () => {
    expect(capiRetryDelayMs(1, undefined, () => 0.5)).toBe(60_000)
    expect(capiRetryDelayMs(20, undefined, () => 0.5)).toBe(6 * 3_600_000)
    expect(capiRetryDelayMs(1, 900_000, () => 0.5)).toBe(900_000)
  })
})

describe('recordAdClick (click history)', () => {
  const upsert = vi.fn()
  const db = { from: vi.fn(() => ({ upsert })) } as never
  const ref = { source_type: 'ad', source_id: '120000001', ctwa_clid: 'CLID-1', headline: 'Oferta' }
  it('stores a click with ctwa_clid, idempotent per (account, contact, clid) — BSUID contacts use the same contact id', async () => {
    upsert.mockResolvedValue({ error: null })
    expect(await recordAdClick(db, { accountId: 'A', contactId: 'C-bsuid', referral: ref })).toBe('stored')
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ account_id: 'A', contact_id: 'C-bsuid', ctwa_clid: 'CLID-1' }), { onConflict: 'account_id,contact_id,ctwa_clid', ignoreDuplicates: true })
  })
  it('ignores organic posts, missing referral and referrals without ctwa_clid; never throws', async () => {
    upsert.mockClear()
    expect(await recordAdClick(db, { accountId: 'A', contactId: 'C', referral: undefined })).toBe('ignored')
    expect(await recordAdClick(db, { accountId: 'A', contactId: 'C', referral: { source_type: 'post', ctwa_clid: 'x' } })).toBe('ignored')
    expect(await recordAdClick(db, { accountId: 'A', contactId: 'C', referral: { source_type: 'ad', source_id: '1' } })).toBe('ignored')
    expect(upsert).not.toHaveBeenCalled()
    upsert.mockRejectedValue(new Error('db down'))
    expect(await recordAdClick(db, { accountId: 'A', contactId: 'C', referral: ref })).toBe('error')
  })
})

describe('buildAdsReport', () => {
  it('separates unattributed orders, computes conversion, and marks verified sales / ROAS unavailable', () => {
    const rep = buildAdsReport([
      { source_id: 'AD1', headline: 'Oferta', contacts: 10, buyers: 2, orders: 3, order_amount: '300.50', units: 5, products: [{ name: 'Laser', units: 5 }] },
      { source_id: null, headline: null, contacts: 0, buyers: 0, orders: 4, order_amount: 100, units: 4, products: [] },
    ], 'f', 't')
    expect(rep.ads).toHaveLength(1)
    expect(rep.ads[0].conversion_pct).toBe(20)
    expect(rep.unattributed?.orders).toBe(4)
    expect(rep.totals).toMatchObject({ attributed_orders: 3, unattributed_orders: 4, orders: 7, order_amount: 400.5 })
    expect(rep.verified_sales.available).toBe(false)
    expect(rep.roas.available).toBe(false)
  })
  it('contacts without orders give 0% and ads with no contacts give no conversion', () => {
    const rep = buildAdsReport([{ source_id: 'A', contacts: 5, buyers: 0, orders: 0, order_amount: 0, units: 0 }, { source_id: 'B', contacts: 0, buyers: 0, orders: 1, order_amount: 9, units: 1 }], 'f', 't')
    expect(rep.ads.map((a) => a.conversion_pct)).toEqual([0, null])
  })
})
