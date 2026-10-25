import { describe, expect, it } from 'vitest'
import { BSUID_PILOT_ENV, isBsuidPilotEnabled, parseBsuidPilot } from './bsuid-pilot'

const ACC = '4d04a2e0-62b8-4508-a046-4b125aa2e8db'
const OTHER = 'c35b393f-9492-4321-80f2-987766c224d0'
const PN = '1353857424470328'
const WABA = '1058892523729962'
const env = (v?: string) => ({ [BSUID_PILOT_ENV]: v })
const subject = { accountId: ACC, phoneNumberId: PN, wabaId: WABA }

describe('BSUID pilot switch', () => {
  it('is OFF by default: missing, empty or blank value', () => {
    for (const v of [undefined, '', '   ', ',', ':::']) expect(isBsuidPilotEnabled(subject, env(v))).toBe(false)
  })
  it('is ON only when account, phone_number_id and WABA all match the listed triple', () => {
    const on = env(`${ACC}:${PN}:${WABA}`)
    expect(isBsuidPilotEnabled(subject, on)).toBe(true)
    expect(isBsuidPilotEnabled({ ...subject, accountId: OTHER }, on)).toBe(false)
    expect(isBsuidPilotEnabled({ ...subject, phoneNumberId: '1349097678278530' }, on)).toBe(false)
    expect(isBsuidPilotEnabled({ ...subject, wabaId: '1066143465793163' }, on)).toBe(false)
  })
  it('the envelope WABA must agree with the config row when present', () => {
    const on = env(`${ACC}:${PN}:${WABA}`)
    expect(isBsuidPilotEnabled({ ...subject, envelopeWabaId: WABA }, on)).toBe(true)
    expect(isBsuidPilotEnabled({ ...subject, envelopeWabaId: '1066143465793163' }, on)).toBe(false)
  })
  it('missing pieces never match', () => {
    const on = env(`${ACC}:${PN}:${WABA}`)
    expect(isBsuidPilotEnabled({ ...subject, wabaId: null }, on)).toBe(false)
    expect(isBsuidPilotEnabled({ ...subject, phoneNumberId: undefined }, on)).toBe(false)
    expect(isBsuidPilotEnabled({ ...subject, accountId: '' }, on)).toBe(false)
  })
  it('there is no wildcard and no "all": generic values enable nothing', () => {
    for (const v of ['*', 'all', 'true', '1', 'yes', `${ACC}`, `${ACC}:*:*`, `*:${PN}:${WABA}`, `${ACC}:${PN}`, `${ACC}:${PN}:${WABA}:extra`]) {
      expect(isBsuidPilotEnabled(subject, env(v))).toBe(false)
    }
  })
  it('a malformed entry never widens the scope and does not break a valid one', () => {
    expect(parseBsuidPilot(`garbage,${ACC}:${PN}:${WABA},not-a-uuid:${PN}:${WABA}`)).toEqual([{ accountId: ACC, phoneNumberId: PN, wabaId: WABA }])
    expect(isBsuidPilotEnabled(subject, env(`not-a-uuid:${PN}:${WABA}`))).toBe(false)
  })
  it('is case-insensitive for the account id and supports several numbers', () => {
    const both = env(`${ACC.toUpperCase()}:${PN}:${WABA},${OTHER}:1349097678278530:1066143465793163`)
    expect(isBsuidPilotEnabled(subject, both)).toBe(true)
    expect(isBsuidPilotEnabled({ accountId: OTHER, phoneNumberId: '1349097678278530', wabaId: '1066143465793163' }, both)).toBe(true)
  })
  it('names, usernames and partial numbers play no part (the subject has no such fields)', () => {
    expect(Object.keys(subject).sort()).toEqual(['accountId', 'phoneNumberId', 'wabaId'])
    expect(isBsuidPilotEnabled({ accountId: ACC, phoneNumberId: PN.slice(-8), wabaId: WABA }, env(`${ACC}:${PN}:${WABA}`))).toBe(false)
  })
})
