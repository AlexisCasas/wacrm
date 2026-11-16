import { describe, expect, it } from 'vitest'

import { assignableOperationalRoles, isOperationalRole, type OperationalRole } from './operational-role'

const owner = { isAdmin: true, operationalRole: null as OperationalRole | null }
const ownerSupervisor = { isAdmin: true, operationalRole: 'supervisor' as OperationalRole | null }
const supervisor = { isAdmin: false, operationalRole: 'supervisor' as OperationalRole | null }
const commercial = { isAdmin: false, operationalRole: 'commercial' as OperationalRole | null }
const logistics = { isAdmin: false, operationalRole: 'logistics' as OperationalRole | null }
const plain = { isAdmin: false, operationalRole: null as OperationalRole | null }

describe('owner/admin targets are protected from a non-admin supervisor', () => {
  it('read-only for owner/admin rows, with or without an area; owner/admin callers unaffected', () => {
    for (const accountRole of ['owner', 'admin']) {
      for (const operationalRole of [null, 'commercial', 'logistics', 'supervisor'] as const) {
        expect(assignableOperationalRoles(supervisor, { operationalRole, accountRole })).toEqual([])
      }
      expect(assignableOperationalRoles(owner, { operationalRole: null, accountRole })).toEqual(['commercial', 'logistics', 'supervisor'])
    }
    expect(assignableOperationalRoles(supervisor, { operationalRole: null, accountRole: 'agent' })).toEqual(['commercial', 'logistics'])
    expect(assignableOperationalRoles(supervisor, { operationalRole: 'logistics', accountRole: 'viewer' })).toEqual(['commercial', 'logistics'])
  })
})

describe('assignableOperationalRoles (UI mirror of the RPC)', () => {
  it('owner/admin: all three areas on anyone, including supervisors', () => {
    for (const target of [null, 'commercial', 'logistics', 'supervisor'] as const) {
      expect(assignableOperationalRoles(owner, { operationalRole: target })).toEqual(['commercial', 'logistics', 'supervisor'])
    }
  })

  it('owner/admin that is also supervisor keeps the full power', () => {
    expect(assignableOperationalRoles(ownerSupervisor, { operationalRole: 'supervisor' })).toEqual(['commercial', 'logistics', 'supervisor'])
  })

  it('operational supervisor (not owner/admin): commercial/logistics only, on non-supervisors', () => {
    for (const target of [null, 'commercial', 'logistics'] as const) {
      expect(assignableOperationalRoles(supervisor, { operationalRole: target })).toEqual(['commercial', 'logistics'])
    }
  })

  it('operational supervisor never gets "supervisor" and cannot edit a supervisor (another one or itself)', () => {
    expect(assignableOperationalRoles(supervisor, { operationalRole: null })).not.toContain('supervisor')
    expect(assignableOperationalRoles(supervisor, { operationalRole: 'supervisor' })).toEqual([])
  })

  it('non-supervisor agents/viewers (any or no area) get nothing', () => {
    for (const caller of [commercial, logistics, plain]) {
      expect(assignableOperationalRoles(caller, { operationalRole: null })).toEqual([])
    }
  })

  it('isOperationalRole accepts only the three areas', () => {
    expect(['commercial', 'logistics', 'supervisor'].every(isOperationalRole)).toBe(true)
    expect([null, 'owner', 'admin', '', 1].some(isOperationalRole)).toBe(false)
  })
})
