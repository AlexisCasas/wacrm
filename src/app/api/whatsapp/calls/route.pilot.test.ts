import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const BUSINESS_ID = '740434745820831'
const TEST_CUSTOMER = '51911122233'
const CUSTOMER_ID = 'a3000000-0000-4000-8000-000000000003'
const h = vi.hoisted(() => ({
  configPhone: '740434745820831',
  configStatus: 'connected',
  contactPhone: '51911122233' as string | null,
  contactBsuid: null as string | null,
  contactParentBsuid: null as string | null,
  contactFound: true,
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({ accountId: 'keyler-account', userId: 'pilot-agent' })),
  toErrorResponse: vi.fn(() => Response.json({ error: 'server error' }, { status: 500 })),
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {}
      const q = {
        select: () => q,
        eq: (key: string, value: unknown) => { filters[key] = value; return q },
        maybeSingle: async () => {
          if (table === 'whatsapp_config') {
            return {
              data: filters.account_id === 'keyler-account'
                ? { phone_number_id: h.configPhone, status: h.configStatus, access_token: 'not-used', messaging_account_id: null }
                : null,
              error: null,
            }
          }
          if (table === 'contacts') {
            return {
              data: h.contactFound && filters.account_id === 'keyler-account' && filters.id === CUSTOMER_ID
                ? { id: CUSTOMER_ID, phone: h.contactPhone } : null,
              error: null,
            }
          }
          throw new Error('unexpected maybeSingle table ' + table)
        },
        limit: async () => {
          if (table !== 'contact_identities') throw new Error('unexpected limit table')
          const value = filters.kind === 'bsuid' ? h.contactBsuid
            : filters.kind === 'parent_bsuid' ? h.contactParentBsuid : null
          return { data: value ? [{ value }] : [], error: null }
        },
      }
      return q
    },
  }),
}))

import { GET } from './route'

const url = () => new Request('https://wacrm.test/api/whatsapp/calls?pilot_contact_id=' + CUSTOMER_ID)
const old = {
  flag: process.env.WHATSAPP_CALLING_ENABLED,
  business: process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS,
  customer: process.env.WHATSAPP_CALLING_PILOT_CUSTOMER_PHONES,
  allContacts: process.env.WHATSAPP_CALLING_KEYLER_ALL_CONTACTS,
}

beforeEach(() => {
  h.configPhone = BUSINESS_ID
  h.configStatus = 'connected'
  h.contactPhone = TEST_CUSTOMER
  h.contactBsuid = null
  h.contactParentBsuid = null
  h.contactFound = true
  delete process.env.WHATSAPP_CALLING_KEYLER_ALL_CONTACTS
  process.env.WHATSAPP_CALLING_ENABLED = 'true'
  process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS = BUSINESS_ID
  process.env.WHATSAPP_CALLING_PILOT_CUSTOMER_PHONES = TEST_CUSTOMER
})

afterEach(() => {
  for (const [key, name] of [
    ['WHATSAPP_CALLING_ENABLED', old.flag],
    ['WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS', old.business],
    ['WHATSAPP_CALLING_PILOT_CUSTOMER_PHONES', old.customer],
    ['WHATSAPP_CALLING_KEYLER_ALL_CONTACTS', old.allContacts],
  ] as const) {
    if (name === undefined) delete process.env[key]
    else process.env[key] = name
  }
})

describe('GET /api/whatsapp/calls?pilot_contact_id — read-only eligibility', () => {
  it('allows only the approved real-format customer of the Keyler business', async () => {
    const response = await GET(url())
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({ pilot_allowed: true })
  })

  it('is OFF when either server-side switch is missing', async () => {
    delete process.env.WHATSAPP_CALLING_ENABLED
    expect(await (await GET(url())).json()).toEqual({ pilot_allowed: false })
    process.env.WHATSAPP_CALLING_ENABLED = 'true'
    delete process.env.WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS
    expect(await (await GET(url())).json()).toEqual({ pilot_allowed: false })
  })

  it('rejects self-calls, other customers and wrong business phone IDs', async () => {
    h.contactPhone = '51980942247'
    expect(await (await GET(url())).json()).toEqual({ pilot_allowed: false })
    h.contactPhone = '51900000000'
    expect(await (await GET(url())).json()).toEqual({ pilot_allowed: false })
    h.contactPhone = TEST_CUSTOMER
    h.configPhone = '999999999999999'
    expect(await (await GET(url())).json()).toEqual({ pilot_allowed: false })
  })

  it('does not expose any other tenant contact or an unavailable business number', async () => {
    h.contactFound = false
    expect(await (await GET(url())).json()).toEqual({ pilot_allowed: false })
    h.contactFound = true
    h.configStatus = 'disconnected'
    expect(await (await GET(url())).json()).toEqual({ pilot_allowed: false })
  })

  it('rejects invalid identifiers without looking up data', async () => {
    const response = await GET(new Request('https://wacrm.test/api/whatsapp/calls?pilot_contact_id=invalid'))
    expect(response.status).toBe(400)
  })
  it('allows different Keyler contacts including BSUID-only identity in all-contacts mode', async () => {
    process.env.WHATSAPP_CALLING_KEYLER_ALL_CONTACTS = 'true'
    delete process.env.WHATSAPP_CALLING_PILOT_CUSTOMER_PHONES
    h.contactPhone = '51955544433'
    expect(await (await GET(url())).json()).toEqual({ pilot_allowed: true })
    h.contactPhone = null
    h.contactBsuid = 'bsuid_test_2'
    expect(await (await GET(url())).json()).toEqual({ pilot_allowed: true })
  })

  it('still rejects other businesses, self-calls, and identity-less contacts', async () => {
    process.env.WHATSAPP_CALLING_KEYLER_ALL_CONTACTS = 'true'
    h.configPhone = '999999999999999'
    expect(await (await GET(url())).json()).toEqual({ pilot_allowed: false })
    h.configPhone = BUSINESS_ID
    h.contactPhone = '51980942247'
    h.contactBsuid = 'bsuid_test_2'
    expect(await (await GET(url())).json()).toEqual({ pilot_allowed: false })
    h.contactPhone = null
    h.contactBsuid = null
    expect(await (await GET(url())).json()).toEqual({ pilot_allowed: false })
  })

})
