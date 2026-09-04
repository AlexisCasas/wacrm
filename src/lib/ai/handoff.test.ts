import { describe, it, expect } from 'vitest'
import { buildHandoffSummary, HANDOFF_CUSTOMER_NOTICE } from './handoff'

describe('HANDOFF_CUSTOMER_NOTICE', () => {
  it('is a fixed, deterministic string (no template placeholders, no invented ETA)', () => {
    expect(HANDOFF_CUSTOMER_NOTICE).toBe(
      'Para ayudarte correctamente con esta consulta, voy a derivarte con uno de nuestros asesores. En breve continuarán la atención contigo por este medio.',
    )
  })
})

describe('buildHandoffSummary', () => {
  it('notes the reply count and quotes the last customer message', () => {
    const summary = buildHandoffSummary({
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello! How can I help?' },
        { role: 'user', content: 'I want a refund' },
      ],
      replyCount: 2,
    })
    expect(summary).toBe(
      '🤖 AI agent handed off after 2 replies. Last customer message: “I want a refund”',
    )
  })

  it('uses the singular "reply" for a count of one', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: 'user', content: 'help' }],
      replyCount: 1,
    })
    expect(summary).toContain('after 1 reply.')
  })

  it('says "without replying" when the bot bailed on the first inbound', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: 'user', content: 'agent please' }],
      replyCount: 0,
    })
    expect(summary).toContain('handed off without replying.')
    expect(summary).toContain('“agent please”')
  })

  it('picks the most recent customer turn, ignoring assistant turns', () => {
    const summary = buildHandoffSummary({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'a reply' },
      ],
      replyCount: 1,
    })
    expect(summary).toContain('“second”')
  })

  it('collapses whitespace and truncates a long message', () => {
    const long = 'x'.repeat(300)
    const summary = buildHandoffSummary({
      messages: [{ role: 'user', content: long }],
      replyCount: 0,
    })
    expect(summary).toContain('…')
    // 160-char cap on the quote; the whole note stays well under 250.
    expect(summary.length).toBeLessThan(250)
  })

  it('degrades gracefully when there is no customer message', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: 'assistant', content: 'greeting' }],
      replyCount: 0,
    })
    expect(summary).toBe('🤖 AI agent handed off without replying.')
  })

  describe('reason: "cap" — the deterministic reply-cap path', () => {
    it('never claims the model chose to hand off', () => {
      const summary = buildHandoffSummary({
        messages: [{ role: 'user', content: 'still need help' }],
        replyCount: 3,
        reason: 'cap',
        maxReplies: 3,
      })
      expect(summary).toContain('reaching the 3-reply limit')
      expect(summary).not.toContain('without replying')
      expect(summary).toContain('“still need help”')
    })

    it('defaults reason to "model" when omitted, unchanged from before', () => {
      const summary = buildHandoffSummary({
        messages: [{ role: 'user', content: 'x' }],
        replyCount: 2,
      })
      expect(summary).toContain('after 2 replies')
    })
  })
})
