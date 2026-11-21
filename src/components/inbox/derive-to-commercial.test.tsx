// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({ state: null as unknown, refresh: vi.fn(), toastOk: vi.fn(), toastErr: vi.fn() }))
vi.mock('next-intl', () => ({
  useLocale: () => 'es',
  useTranslations: () => (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
}))
vi.mock('sonner', () => ({ toast: { success: h.toastOk, error: h.toastErr } }))
vi.mock('@/hooks/use-conversation-routing', () => ({ useConversationRouting: () => ({ state: h.state, refresh: h.refresh }) }))

import { DeriveToCommercial } from './derive-to-commercial'

const CONV = '33333333-3333-4333-8333-333333333333'
const state = (over: Record<string, unknown> = {}) => ({ enabled: true, stage: 'logistics', can_derive: true, derived: null, ...over })
const answer = (status = 200, body: unknown = { ok: true, stage: 'shared', changed: true }) => {
  const f = vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', f)
  return f
}

beforeEach(() => {
  h.state = state()
  h.refresh.mockReset()
  h.toastOk.mockReset()
  h.toastErr.mockReset()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('DeriveToCommercial', () => {
  it('renders nothing while unknown, with the feature off, or without a conversation (legacy Inbox untouched)', () => {
    for (const s of [null, { enabled: false, stage: null, can_derive: false, derived: null }]) {
      h.state = s
      const { container, unmount } = render(<DeriveToCommercial conversationId={CONV} />)
      expect(container.textContent).toBe('')
      unmount()
    }
    h.state = state()
    expect(render(<DeriveToCommercial conversationId={null} />).container.textContent).toBe('')
  })

  it('the button appears only when the server says the caller may derive; commercial / shared / non-allowed roles see no button', () => {
    for (const s of [state({ can_derive: false }), state({ stage: 'commercial', can_derive: false }), state({ stage: 'shared', can_derive: false })]) {
      h.state = s
      const { unmount } = render(<DeriveToCommercial conversationId={CONV} />)
      expect(screen.queryByRole('button', { name: /derive$/ })).toBeNull()
      unmount()
    }
    h.state = state()
    render(<DeriveToCommercial conversationId={CONV} />)
    expect(screen.getByRole('button', { name: /derive/ })).toBeTruthy()
  })

  it('pressing it asks for confirmation with the agreed text and Cancel / Derive; nothing is sent until confirmed', async () => {
    const f = answer()
    render(<DeriveToCommercial conversationId={CONV} />)
    fireEvent.click(screen.getByRole('button', { name: 'derive' }))
    await screen.findByText('deriveTitle')
    expect(screen.getByText('deriveDescription')).toBeTruthy()
    expect(f).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
    await waitFor(() => expect(screen.queryByText('deriveTitle')).toBeNull())
    expect(f).not.toHaveBeenCalled()
  })

  it('confirming sends ONE POST to the thin endpoint (no body) and refreshes the state without a reload', async () => {
    const f = answer()
    render(<DeriveToCommercial conversationId={CONV} />)
    fireEvent.click(screen.getByRole('button', { name: 'derive' }))
    const confirm = await screen.findByRole('button', { name: 'confirm' })
    fireEvent.click(confirm)
    fireEvent.click(confirm) // double click
    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1))
    expect(f).toHaveBeenCalledTimes(1)
    expect(String(f.mock.calls[0][0])).toBe(`/api/conversations/${CONV}/derive-to-commercial`)
    expect(f.mock.calls[0][1]).toEqual({ method: 'POST' })
    expect(h.toastOk).toHaveBeenCalledWith('derivedToast')
  })

  it('a refusal shows the error and keeps the state (no refresh)', async () => {
    answer(403, { error: 'operational_roles_disabled' })
    render(<DeriveToCommercial conversationId={CONV} />)
    fireEvent.click(screen.getByRole('button', { name: 'derive' }))
    fireEvent.click(await screen.findByRole('button', { name: 'confirm' }))
    await waitFor(() => expect(h.toastErr).toHaveBeenCalledWith('operational_roles_disabled'))
    expect(h.refresh).not.toHaveBeenCalled()
  })

  it('an invalid transition (409) shows its own message', async () => {
    answer(409, { error: 'invalid_transition' })
    render(<DeriveToCommercial conversationId={CONV} />)
    fireEvent.click(screen.getByRole('button', { name: 'derive' }))
    fireEvent.click(await screen.findByRole('button', { name: 'confirm' }))
    await waitFor(() => expect(h.toastErr).toHaveBeenCalledWith('invalidTransition'))
  })

  it('on a shared chat it shows the shared note with who derived it and when (Lima time), and no button', () => {
    h.state = state({ stage: 'shared', can_derive: false, derived: { by: 'Jesus', at: '2026-11-17T15:42:00+00:00' } })
    render(<DeriveToCommercial conversationId={CONV} />)
    expect(screen.getByText('sharedBadge')).toBeTruthy()
    expect(screen.getByText(/derivedBy:.*"name":"Jesus".*17 nov 2026.*10:42/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'derive' })).toBeNull()
  })
})
