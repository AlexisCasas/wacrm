import { beforeEach, describe, expect, it, vi } from 'vitest'

const data: { flag: unknown; flagError: boolean; conversation: unknown; role: unknown; stage: unknown; derived: unknown } = {
  flag: true,
  flagError: false,
  conversation: { id: 'conv-1' },
  role: 'logistics',
  stage: 'logistics',
  derived: null,
}
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => (data.flagError ? { data: null, error: { message: 'boom' } } : { data: { logistics_mvp_enabled: data.flag }, error: null }) }),
      }),
    }),
  }),
}))

const calls: Array<{ table: string; eq: Array<[string, unknown]> }> = []
const ctx = {
  userId: 'user-1',
  accountId: 'acc-1',
  supabase: {
    from: (table: string) => {
      const call = { table, eq: [] as Array<[string, unknown]> }
      calls.push(call)
      const result = () => {
        if (table === 'conversations') return { data: data.conversation, error: null }
        if (table === 'profiles') return { data: { operational_role: data.role }, error: null }
        if (table === 'conversation_routing') return { data: data.stage === null ? null : { stage: data.stage }, error: null }
        return { data: data.derived, error: null }
      }
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (c: string, v: unknown) => (call.eq.push([c, v]), b),
        order: () => b,
        limit: () => b,
        maybeSingle: async () => result(),
      }
      return b
    },
  },
} as never

import { readRoutingState } from './routing'

beforeEach(() => {
  calls.length = 0
  data.flag = true
  data.flagError = false
  data.conversation = { id: 'conv-1' }
  data.role = 'logistics'
  data.stage = 'logistics'
  data.derived = null
})

describe('readRoutingState', () => {
  it('flag OFF: nothing is shown and the conversation is not even read (legacy Inbox untouched)', async () => {
    data.flag = false
    expect(await readRoutingState(ctx, 'conv-1')).toEqual({ enabled: false, stage: null, can_derive: false, derived: null })
    expect(calls).toHaveLength(0)
  })

  it('a failing flag lookup is an error, never an open door', async () => {
    data.flagError = true
    await expect(readRoutingState(ctx, 'conv-1')).rejects.toThrow('settings_lookup_failed')
  })

  it('a conversation the caller cannot see (RLS) is null', async () => {
    data.conversation = null
    expect(await readRoutingState(ctx, 'conv-1')).toBeNull()
  })

  it('no routing row means the commercial stage (model rule)', async () => {
    data.stage = null
    data.role = 'commercial'
    expect(await readRoutingState(ctx, 'conv-1')).toMatchObject({ enabled: true, stage: 'commercial', can_derive: false })
  })

  it.each([
    ['logistics', 'logistics', true],
    ['supervisor', 'logistics', true],
    ['commercial', 'logistics', false],
    [null, 'logistics', false],
    ['logistics', 'shared', false], // already shared
    ['supervisor', 'commercial', false], // nothing to hand over
  ])('can_derive for role %s on a %s conversation = %s', async (role, stage, expected) => {
    data.role = role
    data.stage = stage
    expect((await readRoutingState(ctx, 'conv-1'))!.can_derive).toBe(expected)
  })

  it('an unknown stage value falls back to commercial', async () => {
    data.stage = 'brand_new'
    expect((await readRoutingState(ctx, 'conv-1'))!.stage).toBe('commercial')
  })

  it('shared: reports who derived it and when (from the audit trail), scoped to the session account', async () => {
    data.stage = 'shared'
    data.derived = { actor_name: 'Jesus', created_at: '2026-11-17T15:42:00+00:00' }
    expect((await readRoutingState(ctx, 'conv-1'))!.derived).toEqual({ by: 'Jesus', at: '2026-11-17T15:42:00+00:00' })
    for (const c of calls) expect(c.eq).toContainEqual(c.table === 'profiles' ? ['account_id', 'acc-1'] : ['account_id', 'acc-1'])
  })
})
