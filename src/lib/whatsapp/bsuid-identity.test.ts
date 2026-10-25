import { describe, expect, it } from 'vitest'
import { resolveInboundIdentity } from './resolve-sender-identity'
import { cleanUsername, describeBsuid, isValidBsuid, isValidParentBsuid } from './bsuid'
import { pairContact } from './pair-contact'
import { recipientFields, targetAttempts } from './recipient'

// Fixtures follow the documented contract (Meta "Business-scoped user IDs"): fake ids only, no real people.
const BSUID = 'PE.QA0000000000001'
const PARENT = 'PE.ENT.QAP000000001'

describe('BSUID / parent BSUID shapes', () => {
  it('accepts the documented shapes and nothing else', () => {
    expect(isValidBsuid(BSUID)).toBe(true)
    expect(isValidBsuid('US.13491208655302741918')).toBe(true)
    expect(isValidParentBsuid(PARENT)).toBe(true)
    expect(isValidBsuid(PARENT)).toBe(false) // a parent id is not a BSUID
    for (const bad of ['', 'PE.', 'PE', '51900000001', 'wamid.QAFAKE0003', 'P1.abc', 'PE.a b c', 'PE.<script>', undefined, null, 5]) expect(isValidBsuid(bad)).toBe(false)
  })
  it('describeBsuid never reveals the id', () => {
    expect(describeBsuid(BSUID)).toBe('valid:PE')
    expect(describeBsuid(BSUID)).not.toContain('QA000')
    expect(describeBsuid('garbage!')).toBe('invalid-shape')
    expect(describeBsuid(undefined)).toBe('absent')
  })
  it('usernames are cleaned display text', () => {
    expect(cleanUsername('  ana_01\u0000\n ')).toBe('ana_01')
    expect(cleanUsername('x'.repeat(300))?.length).toBe(100)
    expect(cleanUsername('   ')).toBeUndefined()
    expect(cleanUsername(42)).toBeUndefined()
  })
})

describe('resolveInboundIdentity', () => {
  it('phone only (the traditional payload): same identity as before, no BSUID', () => {
    const r = resolveInboundIdentity({ from: '51900000001' }, { wa_id: '51900000001', profile: { name: 'Ana' } })
    expect(r).toMatchObject({ ok: true, phone: '51900000001', name: 'Ana', warnings: [] })
    expect(r.ok && r.bsuid).toBeUndefined()
  })

  it('BSUID only (user with a username): from and wa_id absent', () => {
    const r = resolveInboundIdentity({ from_user_id: BSUID }, { user_id: BSUID, profile: { name: 'Ana', username: 'ana_01' } })
    expect(r).toMatchObject({ ok: true, bsuid: BSUID, username: 'ana_01', name: 'Ana' })
    expect(r.ok && r.phone).toBeUndefined()
  })

  it('BSUID read from the contact entry when the message lacks from_user_id', () => {
    const r = resolveInboundIdentity({}, { user_id: BSUID })
    expect(r).toMatchObject({ ok: true, bsuid: BSUID })
  })

  it('phone and BSUID together: both are kept, the phone stays the primary identity', () => {
    const r = resolveInboundIdentity({ from: '51900000001', from_user_id: BSUID, from_parent_user_id: PARENT }, { wa_id: '51900000001', user_id: BSUID, parent_user_id: PARENT })
    expect(r).toMatchObject({ ok: true, phone: '51900000001', bsuid: BSUID, parentBsuid: PARENT, warnings: [] })
  })

  it('nothing at all is missing_sender_identity, reporting presence flags only', () => {
    const r = resolveInboundIdentity({}, { profile: { name: 'Ana' } })
    expect(r).toEqual({ ok: false, reason: 'missing_sender_identity', present: { from: false, wa_id: false, from_user_id: false, user_id: false } })
    expect(resolveInboundIdentity({}, undefined)).toMatchObject({ ok: false, reason: 'missing_sender_identity' })
  })

  it('a username without a technical id is NOT an identity', () => {
    const r = resolveInboundIdentity({}, { profile: { name: 'Ana', username: 'ana_01' } })
    expect(r).toMatchObject({ ok: false, reason: 'missing_sender_identity' })
  })

  it('a malformed id with no phone is invalid_sender_identity (distinct from missing)', () => {
    expect(resolveInboundIdentity({ from_user_id: 'not an id' }, {})).toMatchObject({ ok: false, reason: 'invalid_sender_identity', present: { from_user_id: true } })
    expect(resolveInboundIdentity({ from_user_id: 'wamid.QAFAKE000000000000000002' }, {})).toMatchObject({ ok: false, reason: 'invalid_sender_identity' })
  })

  it('the message id is never read as an identity', () => {
    const r = resolveInboundIdentity({ id: 'wamid.QAFAKE000000000000000001' } as never, { profile: { name: 'Ana' } })
    expect(r.ok).toBe(false)
  })

  it('a malformed id next to a valid phone does not block the message; it is ignored and reported', () => {
    const r = resolveInboundIdentity({ from: '51900000001', from_user_id: 'bad!' }, { wa_id: '51900000001' })
    expect(r).toMatchObject({ ok: true, phone: '51900000001', warnings: ['bsuid_ignored_invalid'] })
    expect(r.ok && r.bsuid).toBeUndefined()
  })

  it('profile and profile.name are optional; unexpected extra fields are ignored', () => {
    const r = resolveInboundIdentity({ from_user_id: BSUID, surprise: 1 } as never, { user_id: BSUID, profile: undefined, extra: { a: 1 } } as never)
    expect(r).toMatchObject({ ok: true, bsuid: BSUID })
    expect(r.ok && r.name).toBeUndefined()
    expect(resolveInboundIdentity({ from_user_id: BSUID }, { user_id: BSUID, profile: null })).toMatchObject({ ok: true })
  })

  it('message-level id wins over a different contact-level id (warning only)', () => {
    const other = 'PE.QA0000000000002'
    const r = resolveInboundIdentity({ from_user_id: BSUID }, { user_id: other })
    expect(r).toMatchObject({ ok: true, bsuid: BSUID, warnings: ['bsuid_mismatch'] })
  })

  it('a contact entry whose phone contradicts the message is not trusted for ids or profile', () => {
    const r = resolveInboundIdentity({ from: '51900000001' }, { wa_id: '51999999999', user_id: BSUID, profile: { name: 'Someone else', username: 'other' } })
    expect(r).toMatchObject({ ok: true, phone: '51900000001' })
    expect(r.ok && r.bsuid).toBeUndefined()
    expect(r.ok && r.name).toBeUndefined()
    expect(r.ok && r.username).toBeUndefined()
  })

  it('a system notice carries the previous id', () => {
    const r = resolveInboundIdentity({ type: 'system', from_user_id: BSUID, system: { type: 'user_changed_user_id', previous_user_id: 'PE.QA0000000000009' } }, { user_id: BSUID })
    expect(r).toMatchObject({ ok: true, bsuid: BSUID, previousBsuid: 'PE.QA0000000000009' })
  })
})

describe('pairContact (several senders in one delivery)', () => {
  const contacts = [
    { wa_id: '51900000001', profile: { name: 'A' } },
    { user_id: BSUID, profile: { name: 'B' } },
  ]
  it('matches by explicit id before position', () => {
    expect(pairContact({ from_user_id: BSUID }, contacts, 0)).toBe(contacts[1])
    expect(pairContact({ from: '+51 900 000 001' }, contacts, 1)).toBe(contacts[0])
  })
  it('falls back to position, then to the first entry, then to nothing', () => {
    expect(pairContact({}, contacts, 1)).toBe(contacts[1])
    expect(pairContact({}, contacts, 5)).toBe(contacts[0])
    expect(pairContact({}, [], 0)).toBeUndefined()
  })
})

describe('recipient addressing', () => {
  it('a phone goes in `to`, a BSUID in `recipient`, never both', () => {
    expect(recipientFields('51900000001')).toEqual({ to: '51900000001' })
    expect(recipientFields({ bsuid: BSUID })).toEqual({ recipient: BSUID })
  })
  it('a BSUID is attempted exactly once (no phone-prefix variants); a phone keeps its variants', () => {
    expect(targetAttempts({ kind: 'bsuid', bsuid: BSUID })).toEqual([{ bsuid: BSUID }])
    expect(targetAttempts({ kind: 'phone', phone: '51900000001' }).length).toBeGreaterThan(1)
  })
})

import { describeShape, shapeLoggingActiveFor } from './payload-shape'

describe('temporary payload-shape diagnostic', () => {
  const value = {
    metadata: { phone_number_id: 'pn-1', display_phone_number: '51900000001' },
    contacts: [{ user_id: BSUID, parent_user_id: PARENT, wa_id: '51900000001', profile: { name: 'Ana Perez', username: 'ana_01' } }],
    messages: [{ id: 'wamid.SECRET', from: '51900000001', from_user_id: BSUID, type: 'text', text: { body: 'mensaje privado' } }],
  }
  it('describes names and types only: no phone, id, username, name, text or message id', () => {
    const out = JSON.stringify(describeShape(value))
    for (const secret of ['51900000001', BSUID, PARENT, 'ana_01', 'Ana Perez', 'mensaje privado', 'wamid.SECRET']) expect(out).not.toContain(secret)
    expect(out).toContain('"user_id":"bsuid-shaped"')
    expect(out).toContain('"parent_user_id":"parent-bsuid-shaped"')
    expect(out).toContain('"wa_id":"digits"')
    expect(out).toContain('"username":"string"')
  })
  it('is inert unless the account is listed AND the window is open', () => {
    const now = Date.parse('2026-10-26T00:00:00Z')
    const env = { WEBHOOK_SHAPE_LOG_PHONE_NUMBER_IDS: 'pn-1, pn-2', WEBHOOK_SHAPE_LOG_UNTIL: '2026-10-27T00:00:00Z' }
    expect(shapeLoggingActiveFor('pn-1', now, env)).toBe(true)
    expect(shapeLoggingActiveFor('pn-9', now, env)).toBe(false)
    expect(shapeLoggingActiveFor('pn-1', Date.parse('2026-10-28T00:00:00Z'), env)).toBe(false)
    expect(shapeLoggingActiveFor('pn-1', now, {})).toBe(false)
    expect(shapeLoggingActiveFor('pn-1', now, { WEBHOOK_SHAPE_LOG_PHONE_NUMBER_IDS: 'pn-1' })).toBe(false)
  })
})
