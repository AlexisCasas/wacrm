// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({ body: { allowed: true } as unknown, status: 200 }))
vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k }))
vi.mock('next/link', () => ({ default: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) => <a href={href} className={className}>{children}</a> }))
vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard' }))
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: { id: 'u1' }, accountId: 'acc-1', profile: { full_name: 'X' }, profileLoading: false, account: { name: 'X' }, accountRole: 'agent', signOut: vi.fn() }),
}))
vi.mock('@/hooks/use-total-unread', () => ({ useTotalUnread: () => 0 }))
vi.mock('@/hooks/use-unread-notifications', () => ({ useUnreadNotifications: () => 0 }))
vi.mock('@/hooks/use-audio-guide-enabled', () => ({ useAudioGuideEnabled: () => false }))

import { Sidebar } from './sidebar'

const hrefs = () => screen.getAllByRole('link').map((a) => a.getAttribute('href'))
const answer = () => vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify(h.body), { status: h.status })))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  h.body = { allowed: true }
  h.status = 200
})

describe('sidebar: Pedidos confirmados', () => {
  it('shows the entry only when the server says the user is allowed', async () => {
    answer()
    render(<Sidebar />)
    await waitFor(() => expect(hrefs()).toContain('/confirmed-orders'))
    expect(screen.getByText('confirmedOrders')).toBeTruthy()
  })

  it.each([
    ['feature off / no operational role', { allowed: false }, 200],
    ['server error', { error: 'x' }, 500],
    ['forbidden', { error: 'forbidden' }, 403],
    ['malformed answer', {}, 200],
  ])('does not show it: %s', async (_name, body, status) => {
    h.body = body
    h.status = status
    answer()
    render(<Sidebar />)
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))
    expect(hrefs()).not.toContain('/confirmed-orders')
    expect(hrefs()).toContain('/inbox')
  })

  it('does not show it while the answer is unknown, and a network failure keeps it hidden', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    render(<Sidebar />)
    expect(hrefs()).not.toContain('/confirmed-orders')
    await new Promise((r) => setTimeout(r, 20))
    expect(hrefs()).not.toContain('/confirmed-orders')
  })
})
