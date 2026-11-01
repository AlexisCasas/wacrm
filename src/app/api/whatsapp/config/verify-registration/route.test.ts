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
  getTokenAppId: vi.fn(),
  writes: vi.fn(),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v }))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  verifyPhoneNumber: (...a: unknown[]) => h.verifyPhoneNumber(...a),
  getSubscribedApps: (...a: unknown[]) => h.getSubscribedApps(...a),
  getTokenAppId: (...a: unknown[]) => h.getTokenAppId(...a),
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
// Synthetic app ids. Accounts do NOT have to share one: WACRM's own app here, another provider's app, and a second account's own app.
const APP_WACRM = '1000000000000001'
const APP_MANYCHAT = '2000000000000002'
const APP_OTHER_ACCOUNT = '3000000000000003'
const sub = (id: string | undefined, name = 'app') => ({ whatsapp_business_api_data: { id, name } })
const row = (over: Record<string, unknown> = {}) => ({
  phone_number_id: '2222222222222222', waba_id: '1111111111111111', access_token: 'tok', status: 'connected',
  registered_at: null, subscribed_apps_at: SUB, last_registration_error: null, ...over,
})

beforeEach(() => {
  for (const f of [h.config, h.verifyPhoneNumber, h.getSubscribedApps, h.getTokenAppId, h.writes]) f.mockReset()
  h.verifyPhoneNumber.mockResolvedValue({ id: '2222222222222222', display_phone_number: '+51 900 000 000', status: 'CONNECTED' })
  h.getTokenAppId.mockResolvedValue(APP_WACRM)
  h.getSubscribedApps.mockResolvedValue([sub(APP_WACRM, 'WACRM')])
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

describe('verify-registration — the subscribed app must be THIS account\'s app', () => {
  const live = async () => (await GET()).json()

  it('only another provider (ManyChat) is subscribed: the subscription of WACRM is NOT confirmed, not live (whatever the registration)', async () => {
    h.getSubscribedApps.mockResolvedValue([sub(APP_MANYCHAT, 'Manychat')])
    for (const cfg of [row(), row({ registered_at: '2026-09-07T06:28:26.687Z' })]) {
      h.config.mockReturnValue(cfg)
      const json = await live()
      expect(json.live).toBe(false)
      expect(json.checks).toMatchObject({ waba_subscribed_to_app: false, app_identity_verified: true })
      expect(json.errors.join(' ')).toMatch(/Other apps are subscribed/)
    }
  })

  it('WACRM subscribed: PASS (registered by WACRM and registered beforehand in Meta)', async () => {
    for (const cfg of [row(), row({ registered_at: '2026-09-07T06:28:26.687Z' })]) {
      h.config.mockReturnValue(cfg)
      const json = await live()
      expect(json.live).toBe(true)
      expect(json.checks).toMatchObject({ waba_subscribed_to_app: true, app_identity_verified: true })
    }
  })

  it('both apps subscribed: PASS as long as WACRM is present, in any order', async () => {
    h.config.mockReturnValue(row())
    for (const list of [[sub(APP_MANYCHAT), sub(APP_WACRM)], [sub(APP_WACRM), sub(APP_MANYCHAT)]]) {
      h.getSubscribedApps.mockResolvedValue(list)
      expect(await live()).toMatchObject({ live: true, registration_source: 'meta_prior' })
    }
  })

  it('accounts do not have to share an App ID: each is judged by its OWN token\'s app (Lorteg-style account with a different app)', async () => {
    h.config.mockReturnValue(row({ registered_at: '2026-09-08T17:26:47.921Z' }))
    h.getTokenAppId.mockResolvedValue(APP_OTHER_ACCOUNT)
    h.getSubscribedApps.mockResolvedValue([sub(APP_OTHER_ACCOUNT, 'Their own bot')])
    expect(await live()).toMatchObject({ live: true, registration_source: 'wacrm' })
    // the same list judged for an account whose app is WACRM's: not its subscription
    h.getTokenAppId.mockResolvedValue(APP_WACRM)
    expect((await live()).live).toBe(false)
  })

  it.each([
    ['the token\'s app cannot be identified (null)', () => h.getTokenAppId.mockResolvedValue(null)],
    ['the identity lookup throws', () => h.getTokenAppId.mockRejectedValue(new Error('boom'))],
  ])('%s: never a false PASS, whichever apps are subscribed', async (_n, arrange) => {
    arrange()
    for (const cfg of [row(), row({ registered_at: '2026-09-07T06:28:26.687Z' })]) {
      h.config.mockReturnValue(cfg)
      h.getSubscribedApps.mockResolvedValue([sub(APP_WACRM), sub(APP_MANYCHAT)])
      const json = await live()
      expect(json.live).toBe(false)
      expect(json.checks.waba_subscribed_to_app).not.toBe(true)
      expect(json.checks.app_identity_verified).toBe(false)
      expect(json.errors.join(' ')).toMatch(/Could not identify/)
    }
  })

  it('subscribed entries without an id cannot prove anything: not live', async () => {
    h.config.mockReturnValue(row())
    h.getSubscribedApps.mockResolvedValue([sub(undefined, 'WACRM')])
    expect((await live()).live).toBe(false)
  })

  it('nobody subscribed keeps the original message', async () => {
    h.config.mockReturnValue(row())
    h.getSubscribedApps.mockResolvedValue([])
    const json = await live()
    expect(json.live).toBe(false)
    expect(json.errors.join(' ')).toMatch(/no subscribed apps/)
  })

  it('never leaks app ids or the token in the response', async () => {
    h.config.mockReturnValue(row())
    const text = JSON.stringify(await live())
    expect(text).not.toContain(APP_WACRM)
    expect(text).not.toContain(APP_MANYCHAT)
    expect(text).not.toContain('"tok"')
  })
})
