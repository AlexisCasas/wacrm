import { describe, expect, it } from 'vitest'
import { isRegistrationLive, registrationSource } from './registration-state'

const REG = '2026-09-07T06:28:26.687Z'
const SUB = '2026-11-01T19:30:00.000Z'

describe('registrationSource', () => {
  it('registered by WACRM (registered_at set) is "wacrm" whatever Meta says now — Lorteg / Alexis Test keep their behaviour', () => {
    for (const metaPhoneStatus of ['CONNECTED', 'PENDING', undefined]) {
      expect(registrationSource({ registeredAt: REG, status: 'connected', subscribedAppsAt: SUB, metaPhoneStatus })).toBe('wacrm')
    }
    expect(registrationSource({ registeredAt: REG, status: 'disconnected', subscribedAppsAt: null, metaPhoneStatus: undefined })).toBe('wacrm')
  })

  it('not registered by WACRM, but Meta confirms CONNECTED, the app is subscribed and the account is activated: "meta_prior"', () => {
    expect(registrationSource({ registeredAt: null, status: 'connected', subscribedAppsAt: SUB, metaPhoneStatus: 'CONNECTED' })).toBe('meta_prior')
    expect(registrationSource({ registeredAt: undefined, status: 'connected', subscribedAppsAt: SUB, metaPhoneStatus: 'CONNECTED' })).toBe('meta_prior')
  })

  it.each([
    ['Meta does not say CONNECTED', { status: 'connected', subscribedAppsAt: SUB, metaPhoneStatus: 'PENDING' }],
    ['Meta status unreadable', { status: 'connected', subscribedAppsAt: SUB, metaPhoneStatus: undefined }],
    ['Meta status in another case', { status: 'connected', subscribedAppsAt: SUB, metaPhoneStatus: 'connected' }],
    ['account not activated (prepared / disconnected)', { status: 'disconnected', subscribedAppsAt: null, metaPhoneStatus: 'CONNECTED' }],
    ['activated flag but no recorded subscription', { status: 'connected', subscribedAppsAt: null, metaPhoneStatus: 'CONNECTED' }],
    ['subscription recorded but status not connected', { status: 'disconnected', subscribedAppsAt: SUB, metaPhoneStatus: 'CONNECTED' }],
  ])('"none" when %s', (_n, f) => {
    expect(registrationSource({ registeredAt: null, ...f })).toBe('none')
  })
})

describe('isRegistrationLive', () => {
  it('needs Meta metadata, a subscribed app AND a registration proof (wacrm or meta_prior)', () => {
    expect(isRegistrationLive({ phoneMetadataOk: true, wabaSubscribed: true, source: 'wacrm' })).toBe(true)
    expect(isRegistrationLive({ phoneMetadataOk: true, wabaSubscribed: true, source: 'meta_prior' })).toBe(true)
    expect(isRegistrationLive({ phoneMetadataOk: true, wabaSubscribed: true, source: 'none' })).toBe(false)
    expect(isRegistrationLive({ phoneMetadataOk: false, wabaSubscribed: true, source: 'meta_prior' })).toBe(false)
    expect(isRegistrationLive({ phoneMetadataOk: true, wabaSubscribed: false, source: 'meta_prior' })).toBe(false)
    expect(isRegistrationLive({ phoneMetadataOk: true, wabaSubscribed: null, source: 'wacrm' })).toBe(false)
  })
})
