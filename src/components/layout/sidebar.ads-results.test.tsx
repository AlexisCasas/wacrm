// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

const h = vi.hoisted(() => ({ role: 'agent' as string | null, audio: false }))
vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k }))
vi.mock('next/link', () => ({ default: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) => <a href={href} className={className}>{children}</a> }))
vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard' }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ profile: { full_name: 'X' }, profileLoading: false, account: { name: 'X' }, accountRole: h.role, signOut: vi.fn() }) }))
vi.mock('@/hooks/use-total-unread', () => ({ useTotalUnread: () => 0 }))
vi.mock('@/hooks/use-unread-notifications', () => ({ useUnreadNotifications: () => 0 }))
vi.mock('@/hooks/use-audio-guide-enabled', () => ({ useAudioGuideEnabled: () => h.audio }))

import { Sidebar } from './sidebar'
afterEach(cleanup)

// the first link is the logo (also /dashboard)
const hrefs = () => screen.getAllByRole('link').map((a) => a.getAttribute('href')).slice(1)
const EXISTING = ['/dashboard', '/inbox', '/notifications', '/contacts', '/pipelines', '/broadcasts', '/automations', '/flows', '/agents']

describe('sidebar: Resultados de anuncios', () => {
  it.each(['owner', 'admin', 'agent'])('%s sees the entry, with the existing items unchanged and in the same order', (role) => {
    h.role = role
    render(<Sidebar />)
    const links = hrefs()
    expect(links).toContain('/ads-results')
    expect(links.filter((l) => l !== '/ads-results' && EXISTING.includes(l!))).toEqual(EXISTING)
    expect(links).toContain('/settings')
    expect(screen.getByText('adsResults')).toBeTruthy()
  })
  it('viewer (no permission for the report) does not see it; every other item is still there', () => {
    h.role = 'viewer'
    render(<Sidebar />)
    expect(hrefs()).not.toContain('/ads-results')
    for (const l of [...EXISTING, '/settings']) expect(hrefs()).toContain(l)
  })
  it('role not loaded yet: not shown (no flash)', () => {
    h.role = null
    render(<Sidebar />)
    expect(hrefs()).not.toContain('/ads-results')
  })
  it('keeps the audio-guide entry working alongside it', () => {
    h.role = 'agent'; h.audio = true
    render(<Sidebar />)
    expect(hrefs()).toEqual(expect.arrayContaining(['/ads-results', '/audio-guide']))
    h.audio = false
  })
})
