import { beforeEach, describe, expect, it, vi } from 'vitest'

const flag = vi.fn()
const profilesSelect = vi.fn()
const profiles = vi.fn()
vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: async () => ({
    role: 'admin',
    accountId: 'acc-1',
    supabase: { from: () => ({ select: (cols: string) => (profilesSelect(cols), { eq: () => ({ order: () => profiles() }) }) }) },
  }),
  toErrorResponse: (e: Error) => new Response(JSON.stringify({ error: e.message }), { status: 500 }),
}))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: flag }) }) }) }) }))

import { GET } from './route'

const row = (over: Record<string, unknown> = {}) => ({ user_id: 'u1', full_name: 'Ana', email: 'a@x', avatar_url: null, account_role: 'agent', created_at: '2026-01-01', ...over })

beforeEach(() => {
  flag.mockReset()
  profilesSelect.mockReset()
  profiles.mockReset()
})

describe('GET /api/account/members (PR-01 logistics)', () => {
  it('flag OFF: the profiles query is the legacy one, every member has operational_role null', async () => {
    flag.mockResolvedValue({ data: { logistics_mvp_enabled: false }, error: null })
    profiles.mockResolvedValue({ data: [row({ operational_role: 'supervisor' })], error: null })
    const body = await (await GET()).json()
    expect(profilesSelect).toHaveBeenCalledWith('user_id, full_name, email, avatar_url, account_role, created_at')
    expect(body.operational_roles_enabled).toBe(false)
    expect(body.members[0]).toMatchObject({ role: 'agent', operational_role: null })
  })

  it('flag lookup failure fails closed (OFF)', async () => {
    flag.mockResolvedValue({ data: null, error: { message: 'column does not exist' } })
    profiles.mockResolvedValue({ data: [row()], error: null })
    const body = await (await GET()).json()
    expect(body.operational_roles_enabled).toBe(false)
    expect(profilesSelect).toHaveBeenCalledWith('user_id, full_name, email, avatar_url, account_role, created_at')
  })

  it('flag ON: includes operational_role (separate from role) and operational_roles_enabled=true', async () => {
    flag.mockResolvedValue({ data: { logistics_mvp_enabled: true }, error: null })
    profiles.mockResolvedValue({ data: [row({ operational_role: 'logistics' }), row({ user_id: 'u2', operational_role: null }), row({ user_id: 'u3', operational_role: 'bogus' })], error: null })
    const body = await (await GET()).json()
    expect(profilesSelect).toHaveBeenCalledWith('user_id, full_name, email, avatar_url, account_role, operational_role, created_at')
    expect(body.operational_roles_enabled).toBe(true)
    expect(body.members.map((m: { role: string; operational_role: string | null }) => [m.role, m.operational_role])).toEqual([['agent', 'logistics'], ['agent', null], ['agent', null]])
  })
})
