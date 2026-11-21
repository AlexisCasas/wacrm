import { describe, expect, it, vi } from 'vitest'

import { assertConversationOperationalAccess, CONVERSATION_STAGE_FORBIDDEN } from './operational-access'

const client = (result: { data: unknown; error: { code: string; message: string } | null }) => {
  const rpc = vi.fn().mockResolvedValue(result)
  return { rpc, supabase: { rpc } as never }
}

describe('assertConversationOperationalAccess', () => {
  it('resolves when the database function says yes', async () => {
    const { supabase, rpc } = client({ data: true, error: null })
    await expect(assertConversationOperationalAccess(supabase, 'acc', 'conv')).resolves.toBeUndefined()
    expect(rpc).toHaveBeenCalledWith('conversation_operational_access', { p_account_id: 'acc', p_conversation_id: 'conv' })
  })

  it('throws a 403 (ForbiddenError) when it says no, or anything but a clear yes', async () => {
    for (const data of [false, null, undefined, 'true', 1]) {
      const { supabase } = client({ data, error: null })
      await expect(assertConversationOperationalAccess(supabase, 'acc', 'conv')).rejects.toMatchObject({ status: 403, message: CONVERSATION_STAGE_FORBIDDEN })
    }
  })

  it('treats a missing function as legacy (allowed) and any other error as closed', async () => {
    await expect(assertConversationOperationalAccess(client({ data: null, error: { code: '42883', message: 'x' } }).supabase, 'a', 'c')).resolves.toBeUndefined()
    await expect(assertConversationOperationalAccess(client({ data: null, error: { code: 'PGRST202', message: 'x' } }).supabase, 'a', 'c')).resolves.toBeUndefined()
    await expect(assertConversationOperationalAccess(client({ data: null, error: { code: '57014', message: 'timeout' } }).supabase, 'a', 'c')).rejects.toMatchObject({ status: 403 })
  })
})
