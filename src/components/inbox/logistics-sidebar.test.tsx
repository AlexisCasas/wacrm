// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({
  auth: { canSendMessages: true, profile: { operational_role: 'logistics' } } as Record<string, unknown>,
  routing: null as unknown,
}))
vi.mock('next-intl', () => ({
  useLocale: () => 'es',
  useTranslations: () => (key: string) => key,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => h.auth }))
vi.mock('@/hooks/use-conversation-routing', () => ({ useConversationRouting: () => ({ state: h.routing, refresh: vi.fn() }) }))
vi.mock('@/components/inbox/contact-sidebar', () => ({ ContactSidebar: () => <div data-testid="commercial-panel" /> }))
vi.mock('@/components/inbox/logistics-order-editor', () => ({ LogisticsOrderEditor: () => <div data-testid="order-editor" /> }))
vi.mock('@/components/orders/logistics/logistics-panel', () => ({ LogisticsPanel: () => null }))
vi.mock('@/components/orders/shalom/shalom-section', () => ({ ShalomSection: () => null }))

import { OperationalSidebar } from './operational-sidebar'

const CONV = '33333333-3333-4333-8333-333333333333'
const ORDER = { order_id: '11111111-1111-4111-8111-111111111111', product: 'Kit', confirmed_at: '2027-02-01T10:00:00Z', financial_status: 'unpaid', total: 100, paid_confirmed: 0, pending_balance: 100 }
const orders = (list: unknown[]) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ orders: list }), { status: 200 })))
const panel = () => render(<OperationalSidebar contact={null} conversationId={CONV} onTagsChanged={() => {}} onTagCreated={() => {}} onContactUpdated={() => {}} />)
const deriveButton = () => screen.queryByRole('button', { name: /derive/ })

beforeEach(() => {
  h.auth = { canSendMessages: true, profile: { operational_role: 'logistics' } }
  h.routing = { enabled: true, stage: 'logistics', can_derive: true, derived: null }
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Logistics sidebar: handing the chat back to Comercial', () => {
  it('a logistics user can derive the conversation from their own panel', async () => {
    orders([ORDER])
    panel()
    await waitFor(() => expect(screen.getByTestId('order-editor')).toBeTruthy())
    expect(screen.queryByTestId('commercial-panel')).toBeNull()
    expect(deriveButton()).toBeTruthy()
  })

  it('the action is also there for a chat with no tracked order (historical chats stay in logistics otherwise)', async () => {
    orders([])
    panel()
    await waitFor(() => expect(screen.getByText('Sin pedido confirmado')).toBeTruthy())
    expect(deriveButton()).toBeTruthy()
  })

  it('and when the orders cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    panel()
    await waitFor(() => expect(screen.getByText('No se pudo cargar la información logística.')).toBeTruthy())
    expect(deriveButton()).toBeTruthy()
  })

  it('the server decides: no button when it says the caller may not derive', async () => {
    h.routing = { enabled: true, stage: 'shared', can_derive: false, derived: null }
    orders([ORDER])
    panel()
    await waitFor(() => expect(screen.getByTestId('order-editor')).toBeTruthy())
    expect(deriveButton()).toBeNull()
  })

  it('a read-only member (viewer) is never offered the action', async () => {
    h.auth = { canSendMessages: false, profile: { operational_role: 'logistics' } }
    orders([ORDER])
    panel()
    await waitFor(() => expect(screen.getByTestId('order-editor')).toBeTruthy())
    expect(deriveButton()).toBeNull()
  })
})
