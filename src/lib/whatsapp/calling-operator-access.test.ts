import { beforeEach, describe, expect, it, vi } from 'vitest'
import { assertCallingOperator } from './calling-operator-access'

const state = vi.hoisted(() => ({
  profile: { account_role: 'agent', operational_role: 'logistics' } as Record<string, unknown> | null,
  profileError: null as { code: string } | null,
  call: {
    state: 'connected',
    direction: 'USER_INITIATED',
    claimed_by_user_id: 'trusted-operator',
    accepted_by_user_id: 'trusted-operator',
    initiated_by_user_id: null,
  } as Record<string, unknown> | null,
  callError: null as { code: string } | null,
  reads: [] as Array<{ table: string; filters: Record<string, unknown> }>,
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {}
      state.reads.push({ table, filters })
      const q = {
        select: () => q,
        eq: (key: string, value: unknown) => { filters[key] = value; return q },
        maybeSingle: async () => table === 'profiles'
          ? { data: state.profile, error: state.profileError }
          : { data: state.call, error: state.callError },
      }
      return q
    },
  }),
}))

const actor = {
  accountId: 'trusted-tenant',
  userId: 'trusted-operator',
  role: 'agent' as const,
}
const id = 'wacid.legitimate-call'

beforeEach(() => {
  state.profile = { account_role: 'agent', operational_role: 'logistics' }
  state.profileError = null
  state.call = {
    state: 'connected', direction: 'USER_INITIATED', claimed_by_user_id: actor.userId,
    accepted_by_user_id: actor.userId, initiated_by_user_id: null,
  }
  state.callError = null
  state.reads = []
})

describe('CALL-RBAC-01 authoritative server guard', () => {
  it.each(['logistics', 'supervisor'])('allows %s on fresh tenant-scoped profile', async (area) => {
    state.profile = { account_role: 'agent', operational_role: area }
    await expect(assertCallingOperator(actor, { action: 'connect' })).resolves.toBeUndefined()
    expect(state.reads).toEqual([{
      table: 'profiles',
      filters: { account_id: actor.accountId, user_id: actor.userId },
    }])
  })

  it.each(['commercial', null, 'UNASSIGNED'])('fails closed for area %s', async (area) => {
    state.profile = { account_role: 'agent', operational_role: area }
    await expect(assertCallingOperator(actor, { action: 'claim', callId: id }))
      .rejects.toMatchObject({ status: 403 })
    expect(state.reads).toHaveLength(1)
  })

  it('does not allow the owner/account-admin to bypass Commercial', async () => {
    state.profile = { account_role: 'owner', operational_role: 'commercial' }
    await expect(assertCallingOperator({ ...actor, role: 'owner' }))
      .rejects.toMatchObject({ status: 403 })
    expect(state.reads).toHaveLength(1)
  })

  it('denies a changed technical role, missing profile and transient DB failure', async () => {
    state.profile = { account_role: 'viewer', operational_role: 'supervisor' }
    await expect(assertCallingOperator(actor)).rejects.toMatchObject({ status: 403 })
    state.profile = null
    await expect(assertCallingOperator(actor)).rejects.toMatchObject({ status: 403 })
    state.profileError = { code: 'PGRST500' }
    await expect(assertCallingOperator(actor)).rejects.toMatchObject({ status: 403 })
  })

  it('allows only original actor to release its previously held claim after demotion', async () => {
    state.profile = { account_role: 'agent', operational_role: 'commercial' }
    await expect(assertCallingOperator(actor, { action: 'release', callId: id })).resolves.toBeUndefined()
    expect(state.reads[1]).toEqual({
      table: 'whatsapp_call_sessions',
      filters: { account_id: actor.accountId, call_id: id },
    })
    await expect(assertCallingOperator(actor, { action: 'terminate', callId: id })).resolves.toBeUndefined()
    state.call = { ...state.call, claimed_by_user_id: 'another-agent', accepted_by_user_id: null }
    await expect(assertCallingOperator(actor, { action: 'release', callId: id }))
      .rejects.toMatchObject({ status: 403 })
  })

  it('allows an accepted/involved operator to terminate; not unrelated agents', async () => {
    state.profile = { account_role: 'agent', operational_role: 'commercial' }
    state.call = {
      state: 'connected', direction: 'BUSINESS_INITIATED',
      claimed_by_user_id: null, accepted_by_user_id: null,
      initiated_by_user_id: actor.userId,
    }
    await expect(assertCallingOperator(actor, { action: 'terminate', callId: id })).resolves.toBeUndefined()
    state.call = { ...state.call, initiated_by_user_id: 'another-agent' }
    await expect(assertCallingOperator(actor, { action: 'terminate', callId: id }))
      .rejects.toMatchObject({ status: 403 })
  })

  it('cannot use cleanup to accept, connect, reject, retrieve SDP or bypass a missing call', async () => {
    state.profile = { account_role: 'agent', operational_role: 'commercial' }
    for (const action of ['accept', 'pre_accept', 'connect', 'reject', 'check_permission', 'request_permission', 'renew_claim']) {
      await expect(assertCallingOperator(actor, { action, callId: id }))
        .rejects.toMatchObject({ status: 403 })
    }
    await expect(assertCallingOperator(actor, { action: 'release', callId: 'invalid' }))
      .rejects.toMatchObject({ status: 403 })
    state.call = null
    await expect(assertCallingOperator(actor, { action: 'terminate', callId: id }))
      .rejects.toMatchObject({ status: 403 })
  })

  it('does not clean up a call from another tenant or one already terminated', async () => {
    state.profile = { account_role: 'agent', operational_role: 'commercial' }
    state.call = { ...state.call, state: 'terminated' }
    await expect(assertCallingOperator(actor, { action: 'terminate', callId: id }))
      .rejects.toMatchObject({ status: 403 })
    state.call = null
    await expect(assertCallingOperator(actor, { action: 'release', callId: id }))
      .rejects.toMatchObject({ status: 403 })
  })
})
