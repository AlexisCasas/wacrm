import { beforeEach, describe, expect, it, vi } from 'vitest'

// GET /api/whatsapp/config/verify-registration — registration is reported as WHO did it:
//   'wacrm'      registered_at set (WACRM ran /register): exactly the behaviour Lorteg / Alexis Test always had;
//   'meta_prior' registered in Meta BEFORE WACRM (registered_at stays NULL, never invented): live only if Meta says CONNECTED, the app is
//                subscribed and the account is activated;
//   'none'       anything else.
// The route is read-only: it never writes the row.

const h = vi.hoisted(() => ({
  config: vi.fn(),
  verifyPhoneNumber: vi.fn(),
  getSubscribedApps: vi.fn(),
  writes: vi.fn(),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v }))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  verifyPhoneNumber: (...a: unknown[]) => h.verifyPhoneNumber(...a),
  getSubscribedApps: (...a: unknown[]) => h.getSubscribedApps(...a),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) },
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => (table === 'profiles' ? { data: { account_id: 'acct' } } : { data: h.config() })
      for (const m of ['insert', 'update', 'upsert', 'delete']) b[m] = (...a: unknown[]) => h.writes(m, ...a)
      return b
    },
  }),
}))

import { GET } from './route'

const SUB = '2026-11-01T19:30:00.000Z'
const row = (over: Record<string, unknown> = {}) => ({
  phone_number_id: '2222222222222222', waba_id: '1111111111111111', access_token: 'tok', status: 'connected',
  registered_at: null, subscribed_apps_at: SUB, last_registration_error: null, ...over,
})

beforeEach(() => {
  for (const f of [h.config, h.verifyPhoneNumber, h.getSubscribedApps, h.writes]) f.mockReset()
  h.verifyPhoneNumber.mockResolvedValue({ id: '2222222222222222', display_phone_number: '+51 900 000 000', status: 'CONNECTED' })
  h.getSubscribedApps.mockResolvedValue([{ whatsapp_business_api_data: { name: 'app' } }])
})

describe('verify-registration — registered by WACRM (unchanged)', () => {
  it('registered_at set + Meta metadata + subscribed app => live, source "wacrm", the real date is echoed', async () => {
    h.config.mockReturnValue(row({ registered_at: '2026-09-07T06:28:26.687Z' }))
    const json = await (await GET()).json()
    expect(json).toMatchObject({ live: true, registration_source: 'wacrm', registered_at: '2026-09-07T06:28:26.687Z' })
    expect(json.checks).toMatchObject({ locally_marked_registered: true, phone_metadata_ok: true, waba_subscribed_to_app: true })
  })

  it('registered_at set but no subscribed app => not live (as before)', async () => {
    h.config.mockReturnValue(row({ registered_at: '2026-09-07T06:28:26.687Z' }))
    h.getSubscribedApps.mockResolvedValue([])
    expect((await (await GET()).json()).live).toBe(false)
  })

  it('registered_at set stays "wacrm" even if the number status is not CONNECTED right now (live only needs metadata + subscription, as before)', async () => {
    h.config.mockReturnValue(row({ registered_at: '2026-09-07T06:28:26.687Z' }))
    h.verifyPhoneNumber.mockResolvedValue({ id: 'x', display_phone_number: 'x', status: 'PENDING' })
    expect(await (await GET()).json()).toMatchObject({ live: true, registration_source: 'wacrm' })
  })
})

describe('verify-registration — number already registered in Meta before WACRM', () => {
  it('Meta CONNECTED + app subscribed + account activated => live, source "meta_prior", and registered_at stays NULL (no invented date)', async () => {
    h.config.mockReturnValue(row())
    const json = await (await GET()).json()
    expect(json).toMatchObject({ live: true, registration_source: 'meta_prior', registered_at: null })
    expect(json.checks).toMatchObject({ locally_marked_registered: false, meta_confirms_connected: true })
  })

  it.each([
    ['Meta does not say CONNECTED', () => h.verifyPhoneNumber.mockResolvedValue({ id: 'x', display_phone_number: 'x', status: 'PENDING' })],
    ['Meta gives no status', () => h.verifyPhoneNumber.mockResolvedValue({ id: 'x', display_phone_number: 'x' })],
    ['no app subscribed', () => h.getSubscribedApps.mockResolvedValue([])],
    ['Meta metadata unreachable', () => h.verifyPhoneNumber.mockRejectedValue(new Error('boom'))],
  ])('not live when %s', async (_n, arrange) => {
    h.config.mockReturnValue(row())
    arrange()
    const json = await (await GET()).json()
    expect(json.live).toBe(false)
    expect(json.registration_source === 'meta_prior' && json.live).toBe(false)
  })

  it.each([
    ['prepared / not activated (status disconnected)', { status: 'disconnected', subscribed_apps_at: null }],
    ['no recorded subscription', { subscribed_apps_at: null }],
    ['status disconnected', { status: 'disconnected' }],
  ])('not live when the account is %s', async (_n, over) => {
    h.config.mockReturnValue(row(over))
    expect(await (await GET()).json()).toMatchObject({ live: false, registration_source: 'none' })
  })

  it('a registration failure recorded by WACRM does not make a prior registration look like WACRM registered it', async () => {
    h.config.mockReturnValue(row({ last_registration_error: 'PIN rejected' }))
    const json = await (await GET()).json()
    expect(json.registration_source).toBe('meta_prior')
    expect(json.last_registration_error).toBe('PIN rejected')
  })
})

describe('verify-registration — read-only and guarded', () => {
  it('never writes to the database', async () => {
    h.config.mockReturnValue(row())
    await GET()
    h.config.mockReturnValue(row({ registered_at: '2026-09-07T06:28:26.687Z' }))
    await GET()
    expect(h.writes).not.toHaveBeenCalled()
  })

  it('no configuration: not live, no Meta call', async () => {
    h.config.mockReturnValue(null)
    const json = await (await GET()).json()
    expect(json.live).toBe(false)
    expect(h.verifyPhoneNumber).not.toHaveBeenCalled()
  })

  it('never leaks the token', async () => {
    h.config.mockReturnValue(row())
    expect(JSON.stringify(await (await GET()).json())).not.toContain('"tok"')
  })
})
