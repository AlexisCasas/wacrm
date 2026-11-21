import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({}) }))

import { decodeCursor, encodeCursor, idPrefixRange, parseLimit, sanitizeSearch, canViewConfirmedOrders, CONFIRMED_ORDER_COLUMNS } from './confirmed-orders'

describe('canViewConfirmedOrders', () => {
  it('only supervisor and logistics: commercial (handoff done), no area, technical roles and junk have no access', () => {
    expect(canViewConfirmedOrders('supervisor')).toBe(true)
    expect(canViewConfirmedOrders('logistics')).toBe(true)
    for (const v of ['commercial', null, undefined, '', 'owner', 'admin', 'agent', 'viewer', 1]) expect(canViewConfirmedOrders(v)).toBe(false)
  })
})

describe('cursor', () => {
  const good = { t: '2026-11-16T17:12:59.474993+00:00', id: '11111111-1111-4111-8111-111111111111' }
  it('round-trips and keeps the microseconds', () => {
    expect(decodeCursor(encodeCursor(good))).toEqual(good)
  })
  it('rejects garbage and anything that could carry filter syntax', () => {
    expect(decodeCursor('###')).toBeNull()
    expect(decodeCursor(encodeCursor({ t: '2026-11-16T17:12:59Z),id.eq.1', id: good.id }))).toBeNull()
    expect(decodeCursor(encodeCursor({ t: good.t, id: "x'); drop table" }))).toBeNull()
    expect(decodeCursor(Buffer.from('{"t":1,"id":2}').toString('base64url'))).toBeNull()
  })
})

describe('parseLimit', () => {
  it('defaults to 25, accepts 1..50, rejects the rest', () => {
    expect(parseLimit(null)).toBe(25)
    expect(parseLimit('50')).toBe(50)
    for (const bad of ['0', '51', '-1', '1.5', 'abc', '1e2']) expect(parseLimit(bad)).toBeNull()
  })
})

describe('sanitizeSearch', () => {
  it('keeps plain words and drops everything with a meaning in a filter or ILIKE pattern', () => {
    expect(sanitizeSearch('  Cliente   Uno ')).toBe('Cliente Uno')
    expect(sanitizeSearch('a,b(c)"d\'e\\f%g*h_i')).toBe('a b c d e f g h i')
    expect(sanitizeSearch(null)).toBe('')
    expect(sanitizeSearch('x'.repeat(500))).toHaveLength(80)
  })
})

describe('idPrefixRange', () => {
  it('a full UUID is a one-point range; a prefix pads with 0 / f; dashes are optional but only where a UUID has them', () => {
    const id = 'b5479c55-78d8-4507-8ba5-d9c9923d9199'
    expect(idPrefixRange(id)).toEqual({ lo: id, hi: id })
    expect(idPrefixRange(id.toUpperCase())).toEqual({ lo: id, hi: id })
    expect(idPrefixRange(id.replace(/-/g, ''))).toEqual({ lo: id, hi: id })
    expect(idPrefixRange('b5479c55')).toEqual({ lo: 'b5479c55-0000-0000-0000-000000000000', hi: 'b5479c55-ffff-ffff-ffff-ffffffffffff' })
    expect(idPrefixRange('b5479c55-78d8')).toEqual({ lo: 'b5479c55-78d8-0000-0000-000000000000', hi: 'b5479c55-78d8-ffff-ffff-ffffffffffff' })
  })
  it('rejects anything that is not an id prefix of at least 8 hex characters', () => {
    for (const bad of ['', 'b5479c5', 'taladro', 'b5479c55x', 'b547-9c55', 'b5479c-5578', '-b5479c55', 'b5479c55-78d8-4507-8ba5-d9c9923d9199a', 'b5479c55,id.eq.x']) expect(idPrefixRange(bad)).toBeNull()
  })
})

describe('selected columns', () => {
  it('never include the PII or internal columns (seller_user_id included)', () => {
    expect(CONFIRMED_ORDER_COLUMNS).not.toMatch(/seller_user_id|\bdni\b|\bphone\b|order_description|request_key|last_error_code|inkaclick_order_id/)
  })
})
