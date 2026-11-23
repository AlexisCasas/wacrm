import { describe, expect, it } from 'vitest'
import { canOperateWhatsAppCalling } from '@/lib/auth/operational-role'
import type { AccountRole } from '@/lib/auth/roles'

describe('CALL-RBAC-01 operator policy', () => {
  const allowed: Array<[AccountRole, 'logistics' | 'supervisor']> = [
    ['owner', 'logistics'],
    ['admin', 'logistics'],
    ['agent', 'logistics'],
    ['owner', 'supervisor'],
    ['admin', 'supervisor'],
    ['agent', 'supervisor'],
  ]
  it.each(allowed)('allows technical %s AND operational %s', (account, area) => {
    expect(canOperateWhatsAppCalling(account, area)).toBe(true)
  })

  const denied: Array<[AccountRole | null, 'commercial' | null | 'logistics' | 'supervisor']> = [
    ['owner', 'commercial'],
    ['admin', 'commercial'],
    ['agent', 'commercial'],
    ['viewer', 'commercial'],
    ['viewer', 'logistics'],
    ['viewer', 'supervisor'],
    ['agent', null],
    ['admin', null],
    ['owner', null],
    [null, 'logistics'],
    [null, 'supervisor'],
  ]
  it.each(denied)('rejects technical %s / operational %s', (account, area) => {
    expect(canOperateWhatsAppCalling(account, area)).toBe(false)
  })
  it('rejects unexpected values without a technical-owner bypass', () => {
    expect(canOperateWhatsAppCalling('root' as AccountRole, 'supervisor')).toBe(false)
    expect(canOperateWhatsAppCalling('owner', 'SUPERvisor' as 'supervisor')).toBe(false)
    expect(canOperateWhatsAppCalling('admin', undefined)).toBe(false)
  })
})
