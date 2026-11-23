// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useCan } from './use-can'

const auth = vi.hoisted(() => ({
  accountRole: 'agent' as 'owner' | 'admin' | 'agent' | 'viewer' | null,
  operationalRole: 'logistics' as 'commercial' | 'logistics' | 'supervisor' | null,
  profileLoading: false,
}))

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    profileLoading: auth.profileLoading,
    accountRole: auth.accountRole,
    profile: { operational_role: auth.operationalRole },
  }),
}))

beforeEach(() => {
  auth.accountRole = 'agent'
  auth.operationalRole = 'logistics'
  auth.profileLoading = false
})

describe('useCan/use-calling', () => {
  it('permits Logistics and Supervisor, but not Commercial for an agent', () => {
    const { result, rerender } = renderHook(() => useCan('use-calling'))
    expect(result.current).toBe(true)
    auth.operationalRole = 'supervisor'
    rerender()
    expect(result.current).toBe(true)
    auth.operationalRole = 'commercial'
    rerender()
    expect(result.current).toBe(false)
    auth.operationalRole = null
    rerender()
    expect(result.current).toBe(false)
  })

  it('never bypasses area controls for owners, and viewers are denied', () => {
    auth.accountRole = 'owner'
    auth.operationalRole = 'commercial'
    const { result, rerender } = renderHook(() => useCan('use-calling'))
    expect(result.current).toBe(false)
    auth.accountRole = 'viewer'
    auth.operationalRole = 'supervisor'
    rerender()
    expect(result.current).toBe(false)
  })

  it('does not change message-sending access for Commercial', () => {
    auth.operationalRole = 'commercial'
    const { result } = renderHook(() => useCan('send-messages'))
    expect(result.current).toBe(true)
  })

  it('fails closed during profile loading and missing account role', () => {
    auth.profileLoading = true
    const { result, rerender } = renderHook(() => useCan('use-calling'))
    expect(result.current).toBe(false)
    auth.profileLoading = false
    auth.accountRole = null
    rerender()
    expect(result.current).toBe(false)
  })
})
