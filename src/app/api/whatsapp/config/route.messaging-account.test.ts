import { beforeEach, describe, expect, it, vi } from 'vitest'

// /api/whatsapp/config — Meta's new account model. What this proves:
//   * `prepare_only` saves VERIFIED credentials without touching Meta's account state: no /register, no subscribed_apps (so the cut-over stays
//     a separate, authorised step), and it never rewrites what an earlier real save recorded;
//   * `messaging_account_id` is validated (digits only), stored only when sent, cleared by null, and left alone when absent;
//   * the normal save path (register with a PIN + subscribe) behaves exactly as before.

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const MA = '1111111111111111'

const h = vi.hoisted(() => ({
  verifyPhoneNumber: vi.fn(),
  registerPhoneNumber: vi.fn(),
  subscribeWabaToApp: vi.fn(),
  existing: vi.fn(),
  claimed: vi.fn(),
  writes: [] as Array<{ op: 'insert' | 'update'; row: Record<string, unknown> }>,
  selectCols: [] as string[],
}))

vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  verifyPhoneNumber: (...a: unknown[]) => h.verifyPhoneNumber(...a),
  registerPhoneNumber: (...a: unknown[]) => h.registerPhoneNumber(...a),
  subscribeWabaToApp: (...a: unknown[]) => h.subscribeWabaToApp(...a),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc(${v})`,
  decrypt: (v: string) => v.replace(/^enc\(|\)$/g, ''),
}))
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ neq: () => ({ maybeSingle: () => h.claimed() }) }) }) }),
  }),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = (cols: string) => { if (table === 'whatsapp_config') h.selectCols.push(cols); return b }
      b.eq = () => b
      b.maybeSingle = async () => (table === 'profiles' ? { data: { account_id: ACCOUNT }, error: null } : h.existing())
      b.update = (row: Record<string, unknown>) => { h.writes.push({ op: 'update', row }); return b }
      b.insert = async (row: Record<string, unknown>) => { h.writes.push({ op: 'insert', row }); return { error: null } }
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(res)
      return b
    },
  }),
}))

import { GET, POST } from './route'

const post = (body: Record<string, unknown>) =>
  POST(new Request('http://x/api/whatsapp/config', { method: 'POST', body: JSON.stringify(body) }))
const BASE = { phone_number_id: '2222222222222222', waba_id: MA, access_token: 'TOKEN' }

beforeEach(() => {
  for (const f of [h.verifyPhoneNumber, h.registerPhoneNumber, h.subscribeWabaToApp, h.existing, h.claimed]) f.mockReset()
  h.writes.length = 0
  h.selectCols.length = 0
  h.verifyPhoneNumber.mockResolvedValue({ display_phone_number: '+51 900 000 000' })
  h.registerPhoneNumber.mockResolvedValue(undefined)
  h.subscribeWabaToApp.mockResolvedValue(undefined)
  h.existing.mockResolvedValue({ data: null })
  h.claimed.mockResolvedValue({ data: null, error: null })
})

describe('POST /api/whatsapp/config — prepare_only', () => {
  it('verifies the credentials (read-only) and saves them, but never registers the number nor subscribes the app', async () => {
    const res = await post({ ...BASE, messaging_account_id: MA, prepare_only: true })
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toMatchObject({ success: true, saved: true, prepared_only: true, registered: false, registration_skipped: true, receiving_enabled: false })
    expect(h.verifyPhoneNumber).toHaveBeenCalledTimes(1)
    expect(h.registerPhoneNumber).not.toHaveBeenCalled()
    expect(h.subscribeWabaToApp).not.toHaveBeenCalled()
    expect(h.writes).toHaveLength(1)
    const row = h.writes[0].row
    expect(row).toMatchObject({ phone_number_id: BASE.phone_number_id, waba_id: MA, messaging_account_id: MA, registered_at: null, access_token: 'enc(TOKEN)' })
    expect(row).not.toHaveProperty('subscribed_apps_at')
  })

  it('a NEW prepared row is saved as disconnected (not receiving): valid credentials never read as a fully operational account', async () => {
    await post({ ...BASE, prepare_only: true })
    expect(h.writes[0].op).toBe('insert')
    expect(h.writes[0].row).toMatchObject({ status: 'disconnected', connected_at: null })
  })

  it('an EXISTING live row keeps its status and connected_at: preparing credentials never switches a working account off', async () => {
    h.existing.mockResolvedValue({ data: { id: 'cfg', registered_at: '2026-09-07T00:00:00Z', phone_number_id: BASE.phone_number_id } })
    await post({ ...BASE, prepare_only: true })
    expect(h.writes[0].op).toBe('update')
    expect(h.writes[0].row).not.toHaveProperty('status')
    expect(h.writes[0].row).not.toHaveProperty('connected_at')
  })

  it('a real save afterwards is the activation: status connected, subscription recorded, receiving_enabled true', async () => {
    const res = await post({ ...BASE })
    expect(h.writes[0].row).toMatchObject({ status: 'connected' })
    expect(h.writes[0].row.connected_at).not.toBeNull()
    expect((await res.json()).receiving_enabled).toBe(true)
  })

  it('never stores the token in clear and never echoes it', async () => {
    const res = await post({ ...BASE, prepare_only: true })
    expect(JSON.stringify(h.writes)).not.toContain('"TOKEN"')
    expect(await res.text()).not.toContain('TOKEN')
  })

  it('on an existing, already-subscribed row it does not rewrite registered_at or subscribed_apps_at', async () => {
    h.existing.mockResolvedValue({ data: { id: 'cfg', registered_at: '2026-09-07T00:00:00Z', phone_number_id: BASE.phone_number_id } })
    await post({ ...BASE, prepare_only: true })
    expect(h.writes[0].op).toBe('update')
    expect(h.writes[0].row).not.toHaveProperty('subscribed_apps_at')
    expect(h.writes[0].row.registered_at).toBe('2026-09-07T00:00:00Z')
    expect(h.registerPhoneNumber).not.toHaveBeenCalled()
  })

  it('cannot be combined with a PIN (nothing is registered, so a PIN would be silently ignored)', async () => {
    const res = await post({ ...BASE, prepare_only: true, pin: '123456' })
    expect(res.status).toBe(400)
    expect(h.verifyPhoneNumber).not.toHaveBeenCalled()
    expect(h.writes).toEqual([])
  })

  it('only the literal true counts: "true" keeps the normal behaviour', async () => {
    await post({ ...BASE, prepare_only: 'true' })
    expect(h.subscribeWabaToApp).toHaveBeenCalledTimes(1)
  })

  it('an invalid token is still refused before anything is saved', async () => {
    h.verifyPhoneNumber.mockRejectedValue(new Error('bad token'))
    const res = await post({ ...BASE, prepare_only: true })
    expect(res.status).toBe(400)
    expect(h.writes).toEqual([])
  })

  it('a number claimed by another account is still refused (isolation between accounts)', async () => {
    h.claimed.mockResolvedValue({ data: { account_id: 'other' }, error: null })
    const res = await post({ ...BASE, prepare_only: true })
    expect(res.status).toBe(409)
    expect(h.writes).toEqual([])
  })
})

describe('POST /api/whatsapp/config — messaging_account_id', () => {
  it.each(['abc', '1234', '12345678901234567890123456', '110 074', '1111111111111111;x', 42, {}, ['1111111111111111']])(
    'rejects %j before touching Meta or the database',
    async (bad) => {
      const res = await post({ ...BASE, messaging_account_id: bad as never })
      expect(res.status).toBe(400)
      expect(h.verifyPhoneNumber).not.toHaveBeenCalled()
      expect(h.writes).toEqual([])
    },
  )

  it('is trimmed and stored', async () => {
    await post({ ...BASE, messaging_account_id: `  ${MA} ` })
    expect(h.writes[0].row.messaging_account_id).toBe(MA)
  })

  it('absent -> the column is not written at all (an update cannot wipe a stored value)', async () => {
    await post({ ...BASE })
    expect(h.writes[0].row).not.toHaveProperty('messaging_account_id')
  })

  it.each([null, ''])('%j clears it explicitly', async (v) => {
    await post({ ...BASE, messaging_account_id: v })
    expect(h.writes[0].row.messaging_account_id).toBeNull()
  })
})

describe('POST /api/whatsapp/config — the normal save is unchanged', () => {
  it('registers with a PIN and subscribes the app, as before', async () => {
    const res = await post({ ...BASE, pin: '123456' })
    expect(res.status).toBe(200)
    expect(h.registerPhoneNumber).toHaveBeenCalledTimes(1)
    expect(h.subscribeWabaToApp).toHaveBeenCalledWith({ wabaId: MA, accessToken: 'TOKEN' })
    expect(h.writes[0].row).toHaveProperty('subscribed_apps_at')
    expect(h.writes[0].row.subscribed_apps_at).not.toBeNull()
    expect((await res.json()).prepared_only).toBe(false)
  })
})

describe('GET /api/whatsapp/config', () => {
  it('reads messaging_account_id (not a secret) and exposes it with the connection status', async () => {
    h.existing.mockResolvedValue({ data: { phone_number_id: BASE.phone_number_id, access_token: 'enc(TOKEN)', status: 'connected', app_secret: null, messaging_account_id: MA } })
    const json = await (await GET()).json()
    expect(h.selectCols.join('|')).toContain('messaging_account_id')
    expect(json).toMatchObject({ connected: true, messaging_account_id: MA, receiving_enabled: true })
    expect(JSON.stringify(json)).not.toContain('TOKEN')
  })
  it('a prepared (disconnected) row: credentials valid but receiving_enabled=false', async () => {
    h.existing.mockResolvedValue({ data: { phone_number_id: BASE.phone_number_id, access_token: 'enc(TOKEN)', status: 'disconnected', app_secret: null, messaging_account_id: MA } })
    expect(await (await GET()).json()).toMatchObject({ connected: true, receiving_enabled: false })
  })
  it('an operating account (status connected) reads exactly as before, plus receiving_enabled=true', async () => {
    h.existing.mockResolvedValue({ data: { phone_number_id: BASE.phone_number_id, access_token: 'enc(TOKEN)', status: 'connected', app_secret: null, messaging_account_id: null } })
    const json = await (await GET()).json()
    expect(json).toMatchObject({ connected: true, app_secret_configured: false, receiving_enabled: true, messaging_account_id: null })
  })
  it('null when the account has none', async () => {
    h.existing.mockResolvedValue({ data: { phone_number_id: BASE.phone_number_id, access_token: 'enc(TOKEN)', status: 'connected', app_secret: null, messaging_account_id: null } })
    expect((await (await GET()).json()).messaging_account_id).toBeNull()
  })
})
