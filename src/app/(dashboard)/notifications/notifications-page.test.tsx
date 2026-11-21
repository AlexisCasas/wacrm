// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const push = vi.fn()
const updates: Array<{ id: string }> = []
let rows: Array<Record<string, unknown>> = []

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))
vi.mock('@/lib/date-locale', () => ({ useDateFnsLocale: () => undefined }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ accountId: 'acc-1' }) }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const select = {
      eq: () => select,
      order: () => select,
      limit: async () => ({ data: rows, error: null }),
    }
    return {
      from: () => ({
        select: () => select,
        update: () => ({ eq: (_c: string, id: string) => ({ is: async () => { updates.push({ id }); return { error: null } } }) }),
      }),
      channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
      removeChannel: () => undefined,
    }
  },
}))

import NotificationsPage from './page'

const base = { account_id: 'acc-1', user_id: 'u1', read_at: null, created_at: new Date().toISOString(), body: 'b' }

afterEach(() => {
  cleanup()
  push.mockReset()
  updates.length = 0
})

describe('Notifications page (existing behaviour + the PR-05 channel)', () => {
  it('a conversation_assigned notification still opens the Inbox conversation and is marked read', async () => {
    rows = [{ ...base, id: 'n1', type: 'conversation_assigned', conversation_id: 'c1', title: 'New conversation assigned' }]
    render(<NotificationsPage />)
    fireEvent.click(await screen.findByText('New conversation assigned'))
    expect(push).toHaveBeenCalledWith('/inbox?c=c1')
    await waitFor(() => expect(updates).toEqual([{ id: 'n1' }]))
  })

  it('a shipment alert opens Pedidos Confirmados on THAT order (the order id travels with the notification) and is marked read', async () => {
    rows = [{ ...base, id: 'n2', type: 'shipment_destination_alert', order_id: 'order-9', title: 'Pedido en destino hace 15 días' }]
    render(<NotificationsPage />)
    fireEvent.click(await screen.findByText('Pedido en destino hace 15 días'))
    expect(push).toHaveBeenCalledWith('/confirmed-orders?order=order-9')
    await waitFor(() => expect(updates).toEqual([{ id: 'n2' }]))
  })

  it('both kinds are listed together; a notification with neither target only gets marked read', async () => {
    rows = [
      { ...base, id: 'n3', type: 'conversation_assigned', conversation_id: 'c3', title: 'Assigned' },
      { ...base, id: 'n4', type: 'shipment_destination_alert', order_id: 'o4', title: 'Shipment alert' },
      { ...base, id: 'n5', type: 'conversation_assigned', title: 'Orphan' },
    ]
    render(<NotificationsPage />)
    expect(await screen.findByText('Assigned')).toBeTruthy()
    expect(screen.getByText('Shipment alert')).toBeTruthy()
    fireEvent.click(screen.getByText('Orphan'))
    expect(push).not.toHaveBeenCalled()
  })
})
