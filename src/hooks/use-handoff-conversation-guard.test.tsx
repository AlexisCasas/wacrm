// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({ result: { data: null as unknown, error: null as unknown }, eq: vi.fn() }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: (col: string, id: string) => {
          h.eq(table, col, id)
          return { maybeSingle: async () => h.result }
        },
      }),
    }),
  }),
}))

import { ORDERS_CHANGED_EVENT } from '@/components/orders/order-history'
import { useHandoffConversationGuard } from './use-handoff-conversation-guard'

beforeEach(() => {
  h.result = { data: null, error: null }
  h.eq.mockReset()
})
afterEach(cleanup)

const fire = () => window.dispatchEvent(new Event(ORDERS_CHANGED_EVENT))

describe('useHandoffConversationGuard', () => {
  it('after a confirmed order, the conversation the database no longer returns leaves the Inbox at once', async () => {
    const gone = vi.fn()
    renderHook(() => useHandoffConversationGuard('conv-1', gone))
    fire()
    await waitFor(() => expect(gone).toHaveBeenCalledWith('conv-1'))
    expect(h.eq).toHaveBeenCalledWith('conversations', 'id', 'conv-1')
  })

  it('logistics / supervisor / flag OFF still get the row back: nothing is removed', async () => {
    h.result = { data: { id: 'conv-1' }, error: null }
    const gone = vi.fn()
    renderHook(() => useHandoffConversationGuard('conv-1', gone))
    fire()
    await waitFor(() => expect(h.eq).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 10))
    expect(gone).not.toHaveBeenCalled()
  })

  it('a failing query never removes the chat', async () => {
    h.result = { data: null, error: { message: 'network' } }
    const gone = vi.fn()
    renderHook(() => useHandoffConversationGuard('conv-1', gone))
    fire()
    await waitFor(() => expect(h.eq).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 10))
    expect(gone).not.toHaveBeenCalled()
  })

  it('does nothing without an open conversation, before the event, and after unmount', async () => {
    const gone = vi.fn()
    renderHook(() => useHandoffConversationGuard(null, gone))
    fire()
    const mounted = renderHook(() => useHandoffConversationGuard('conv-2', gone))
    expect(h.eq).not.toHaveBeenCalled()
    mounted.unmount()
    fire()
    await new Promise((r) => setTimeout(r, 10))
    expect(h.eq).not.toHaveBeenCalled()
    expect(gone).not.toHaveBeenCalled()
  })
})
