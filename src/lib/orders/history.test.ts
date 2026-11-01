import { describe, expect, it } from 'vitest'
import { formatLimaDateTime, formatPrice, HISTORY_COLUMNS, isInFlight, statusInfo } from './history'

describe('statusInfo', () => {
  it.each([
    ['held', 'statusHeld', 'neutral'],
    ['pending', 'statusPending', 'amber'],
    ['sending', 'statusSending', 'amber'],
    ['sent', 'statusSent', 'blue'],
    ['acknowledged', 'statusAcknowledged', 'green'],
    ['failed', 'statusFailed', 'red'],
    ['dead', 'statusDead', 'red'],
  ])('%s -> %s (%s)', (status, key, tone) => {
    expect(statusInfo(status)).toEqual({ key, tone })
  })

  it('an unknown status is neutral, never a crash', () => {
    expect(statusInfo('mystery')).toEqual({ key: 'statusUnknown', tone: 'neutral' })
  })

  it('only "acknowledged" means received by InkaClick; "sent" and "held" do not', () => {
    for (const s of ['held', 'pending', 'sending', 'sent', 'failed', 'dead']) expect(statusInfo(s).key).not.toBe('statusAcknowledged')
  })

  it('"held" is never presented as waiting to be sent', () => {
    expect(statusInfo('held').key).not.toBe('statusPending')
  })
})

describe('isInFlight', () => {
  it('only the states that can still change by themselves', () => {
    expect(['held', 'pending', 'sending', 'sent', 'acknowledged', 'failed', 'dead'].filter(isInFlight)).toEqual(['pending', 'sending', 'sent'])
  })
})

describe('formatLimaDateTime', () => {
  it('uses America/Lima, not the machine zone: 03:30 UTC on 1 Nov is 22:30 on 31 Oct', () => {
    const out = formatLimaDateTime('2026-11-01T03:30:00Z', 'es')
    expect(out).toContain('31')
    expect(out).toContain('22:30')
    expect(out).toContain('2026')
  })

  it('midday', () => {
    expect(formatLimaDateTime('2026-10-31T16:24:05Z', 'en')).toContain('11:24')
  })

  it('an invalid date renders as empty instead of "Invalid Date"', () => {
    expect(formatLimaDateTime('not a date')).toBe('')
  })
})

describe('formatPrice', () => {
  it.each([
    [110, 'S/ 110.00'],
    ['110.00', 'S/ 110.00'],
    ['1.5', 'S/ 1.50'],
    [1, 'S/ 1.00'],
  ])('%s -> %s', (input, out) => {
    expect(formatPrice(input)).toBe(out)
  })
})

describe('HISTORY_COLUMNS', () => {
  it('never selects personal data or internal error codes', () => {
    for (const forbidden of ['dni', 'phone', 'customer_name', 'last_error_code', 'order_description', 'request_key']) {
      expect(HISTORY_COLUMNS.split(/,\s*/)).not.toContain(forbidden)
    }
  })
})
