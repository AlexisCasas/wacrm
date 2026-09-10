import { describe, expect, it } from 'vitest'
import { resolveSenderIdentity } from './resolve-sender-identity'

// Case labels below match docs/P1_DUPLICATE_CHATS_AUDIT.md section Q /
// the P1 Fase 2A spec. Cases D and E were reworked after the Fase 2
// adversarial review: `message.from`, whenever present and valid, is
// now ALWAYS authoritative — `contact.wa_id` never vetoes it, only
// flags a diagnostic warning. See resolve-sender-identity.ts's
// file-level comment for why (dropping a message with a valid `from`
// over an unrelated/misaligned `wa_id` is a bigger risk than trusting
// Meta's own sender field).
describe('resolveSenderIdentity', () => {
  it('A) message.from and contact.wa_id both valid and equal — uses that number, no warning', () => {
    const result = resolveSenderIdentity('15551230000', '15551230000')
    expect(result).toEqual({
      ok: true,
      phone: '15551230000',
      source: 'message_from',
      warning: undefined,
    })
  })

  it('B) message.from valid, contact.wa_id empty — uses message.from, no warning', () => {
    expect(resolveSenderIdentity('15551230000', '')).toEqual({
      ok: true,
      phone: '15551230000',
      source: 'message_from',
      warning: undefined,
    })
  })

  it('B) message.from valid, contact.wa_id absent (undefined) — uses message.from, no warning', () => {
    expect(resolveSenderIdentity('15551230000', undefined)).toEqual({
      ok: true,
      phone: '15551230000',
      source: 'message_from',
      warning: undefined,
    })
  })

  it('C) message.from empty, contact.wa_id valid — falls back to contact.wa_id', () => {
    expect(resolveSenderIdentity('', '15551230000')).toEqual({
      ok: true,
      phone: '15551230000',
      source: 'contact_wa_id',
      warning: undefined,
    })
  })

  it('C) message.from absent (undefined), contact.wa_id valid — falls back to contact.wa_id', () => {
    expect(resolveSenderIdentity(undefined, '15551230000')).toEqual({
      ok: true,
      phone: '15551230000',
      source: 'contact_wa_id',
      warning: undefined,
    })
  })

  it('D) both present, different digits, but a phonesMatch()-style trunk-prefix variant — keeps message.from, flags a diagnostic warning, still processes', () => {
    // Lithuanian trunk-0 variant: same last 8 digits — used to be the
    // ONLY discrepancy shape that was tolerated. Now behaves identically
    // to any other disagreement: accept `from`, warn, never refuse.
    const result = resolveSenderIdentity('37063949836', '370063949836')
    expect(result).toEqual({
      ok: true,
      phone: '37063949836',
      source: 'message_from',
      warning: 'sender_identity_mismatch',
    })
  })

  it('E) both present, genuinely different numbers (no phonesMatch either) — STILL uses message.from and warns; never drops a message with a valid from', () => {
    const result = resolveSenderIdentity('15551230000', '442071838750')
    expect(result).toEqual({
      ok: true,
      phone: '15551230000',
      source: 'message_from',
      warning: 'sender_identity_mismatch',
    })
  })

  it('F) both empty — refuses (the only refusal case left)', () => {
    expect(resolveSenderIdentity('', '')).toEqual({
      ok: false,
      reason: 'missing_sender_identity',
    })
  })

  it('F) both absent (undefined) — refuses', () => {
    expect(resolveSenderIdentity(undefined, undefined)).toEqual({
      ok: false,
      reason: 'missing_sender_identity',
    })
  })

  it('F) both present but non-normalizable (no digits) — refuses', () => {
    expect(resolveSenderIdentity('unknown', '   ')).toEqual({
      ok: false,
      reason: 'missing_sender_identity',
    })
  })

  it('never throws on null input', () => {
    expect(() => resolveSenderIdentity(null, null)).not.toThrow()
    expect(resolveSenderIdentity(null, null)).toEqual({
      ok: false,
      reason: 'missing_sender_identity',
    })
  })
})
