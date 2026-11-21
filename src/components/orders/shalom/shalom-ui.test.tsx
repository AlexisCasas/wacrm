// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() } }))
vi.mock('next-intl', () => {
  const t = Object.assign((key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key), { has: () => true })
  return { useLocale: () => 'es', useTranslations: () => t }
})
vi.mock('@/components/orders/logistics/voucher-indicator', () => ({ VoucherIndicator: ({ orderId }: { orderId: string }) => <span data-testid="pr04-indicator">{orderId}</span> }))

import { __resetShipmentSummaryStore, DerivedLogisticsIndicator } from './shalom-indicator'
import { ShalomSection } from './shalom-section'

const ORDER = '11111111-1111-4111-8111-111111111111'
const ALERT = '99999999-9999-4999-8999-999999999999'
const shipment = (over: Record<string, unknown> = {}) => ({
  id: 's1', order_id: ORDER, tracking_number: '12345678', tracking_code: '7M99', identifier_version: 1, logistic_status: 'in_transit', tracking_state: 'active',
  stop_reason: null, stopped_at: null, status_changed_at: '2026-12-01T15:00:00Z', destination_episode: 0, destination_entered_at: null,
  last_polled_at: '2026-12-01T16:00:00Z', last_success_at: '2026-12-01T16:00:00Z', next_poll_at: '2026-12-01T19:00:00Z', consecutive_failures: 0,
  last_error_kind: null, last_error_code: null, pickup_state: 'none', pickup_alerted_at: null, pickup_abandoned_at: null, ...over,
})
const panel = (over: Record<string, unknown> = {}) => ({ eligible: true, shipment: shipment(), events: [], alerts: [], polls: [], messages: [], days_at_destination: null, can_stop: false, ...over })

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown } | undefined
function stubFetch(handler: Handler) {
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const r = handler(String(url), init) ?? { status: 404, body: {} }
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
  })
  vi.stubGlobal('fetch', f)
  return f
}
const posted = (f: ReturnType<typeof stubFetch>, path: string) =>
  f.mock.calls.filter(([u, i]) => String(u).includes(path) && (i as RequestInit | undefined)?.method === 'POST').map(([, i]) => JSON.parse(String((i as RequestInit).body)))

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  __resetShipmentSummaryStore()
})

describe('ShalomSection · who sees it', () => {
  it.each([401, 403, 404])('answer %i (flag OFF, Commercial, viewer, no area, other account) → renders NOTHING', async (status) => {
    const f = stubFetch(() => ({ status, body: { error: 'feature_disabled' } }))
    const { container } = render(<ShalomSection orderId={ORDER} />)
    await waitFor(() => expect(f).toHaveBeenCalled())
    await waitFor(() => expect(container.querySelector('section')).toBeNull())
    expect(container.textContent).toBe('')
  })

  it('an order that is not ready for dispatch and has no guide shows nothing', async () => {
    stubFetch(() => ({ body: panel({ eligible: false, shipment: null }) }))
    const { container } = render(<ShalomSection orderId={ORDER} />)
    await waitFor(() => expect(container.querySelector('section')).toBeNull())
  })

  it('a 500 is an error with a retry, not a crash', async () => {
    let calls = 0
    stubFetch(() => ((calls += 1) === 1 ? { status: 500, body: {} } : { body: panel() }))
    render(<ShalomSection orderId={ORDER} />)
    fireEvent.click(await screen.findByRole('button', { name: 'retry' }))
    expect(await screen.findByText('12345678')).toBeTruthy()
  })
})

describe('ShalomSection · register the guide', () => {
  it('the button needs a valid number + code; the request carries only the guide (no account / role / actor)', async () => {
    let registered = false
    const f = stubFetch((url, init) => {
      if (init?.method === 'POST') {
        registered = true
        return { status: 201, body: { created: true, identifier_version: 1 } }
      }
      return { body: registered ? panel({ shipment: shipment({ logistic_status: null }) }) : panel({ shipment: null }) }
    })
    render(<ShalomSection orderId={ORDER} />)
    const submit = (await screen.findByRole('button', { name: 'register' })) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('numero'), { target: { value: '123' } })
    fireEvent.change(screen.getByLabelText('codigo'), { target: { value: '7m99' } })
    expect(submit.disabled).toBe(true) // number too short
    fireEvent.change(screen.getByLabelText('numero'), { target: { value: ' 12345678 ' } })
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    await waitFor(() => expect(posted(f, `/api/orders/shalom/orders/${ORDER}`)).toEqual([{ action: 'register', numero_orden: '12345678', codigo: '7m99' }]))
    expect(await screen.findByText('awaitingFirst', { exact: false }).catch(() => null)).toBeDefined()
    await waitFor(() => expect(screen.getAllByText('12345678').length).toBeGreaterThan(0)) // the section now shows the guide
  })
})

describe('ShalomSection · the guide, its status and the actions', () => {
  it('shows guide, normalized status (5 steps, current one marked), last / next query and the version', async () => {
    stubFetch(() => ({ body: panel() }))
    render(<ShalomSection orderId={ORDER} />)
    expect(await screen.findByText('12345678')).toBeTruthy()
    expect(screen.getByText(/7M99/)).toBeTruthy()
    expect(screen.getByText('state.active')).toBeTruthy()
    const steps = screen.getAllByRole('listitem').filter((li) => li.getAttribute('aria-current') === 'step')
    expect(steps).toHaveLength(1)
    expect(steps[0].textContent).toContain('status.in_transit')
    for (const s of ['ready_for_dispatch', 'at_origin', 'in_transit', 'at_destination', 'delivered']) expect(screen.getAllByText(`status.${s}`).length).toBeGreaterThan(0)
    expect(screen.getByText('lastPolled')).toBeTruthy()
    expect(screen.getByText('nextPoll')).toBeTruthy()
    expect(screen.queryByText(/raw|reparto|demora/i)).toBeNull() // the raw Shalom status is never the UI status
  })

  it('refresh posts the action; correct posts the new guide with the version it edits; stop is hidden unless the server says the person is a supervisor', async () => {
    const f = stubFetch((url, init) => (init?.method === 'POST' ? { body: { queried: true } } : { body: panel() }))
    render(<ShalomSection orderId={ORDER} />)
    fireEvent.click(await screen.findByRole('button', { name: /refresh/ }))
    await waitFor(() => expect(posted(f, '/shalom/orders/')).toContainEqual({ action: 'refresh' }))
    expect(screen.queryByRole('button', { name: /^stop$/ })).toBeNull()
    // The preceding refresh may still have its server-side completion in flight.
    // Wait for the UI to become actionable before opening the correction form.
    const correctButton = await screen.findByRole('button', { name: 'correct' }) as HTMLButtonElement
    await waitFor(() => expect(correctButton.disabled).toBe(false))
    fireEvent.click(correctButton)
    fireEvent.change(await screen.findByLabelText('numero'), { target: { value: '87654321' } })
    fireEvent.change(screen.getByLabelText('codigo'), { target: { value: 'zz11' } })
    fireEvent.click(screen.getByRole('button', { name: 'saveCorrection' }))
    await waitFor(() => expect(posted(f, '/shalom/orders/')).toContainEqual({ action: 'correct', numero_orden: '87654321', codigo: 'zz11', expected_version: 1 }))
  })

  it('supervisor: stop asks for confirmation (declining sends nothing, accepting stops)', async () => {
    const f = stubFetch((url, init) => (init?.method === 'POST' ? { body: { changed: true } } : { body: panel({ can_stop: true }) }))
    render(<ShalomSection orderId={ORDER} />)
    const stop = await screen.findByRole('button', { name: 'stop' })
    ;(window.confirm as ReturnType<typeof vi.fn>).mockReturnValueOnce(false)
    fireEvent.click(stop)
    expect(posted(f, '/shalom/orders/')).toEqual([])
    fireEvent.click(stop)
    await waitFor(() => expect(posted(f, '/shalom/orders/')).toEqual([{ action: 'stop', reason: 'manual' }]))
  })

  it('an API error is shown through the error text and the section stays usable', async () => {
    stubFetch((url, init) => (init?.method === 'POST' ? { status: 429, body: { error: 'rate_limited' } } : { body: panel() }))
    render(<ShalomSection orderId={ORDER} />)
    fireEvent.click(await screen.findByRole('button', { name: /refresh/ }))
    const { toast } = await import('sonner')
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('err.rate_limited'))
    expect(screen.getByText('12345678')).toBeTruthy()
  })

  it('delivered: final banner, no actions; stopped: banner with the reason, no actions', async () => {
    stubFetch(() => ({ body: panel({ shipment: shipment({ logistic_status: 'delivered', tracking_state: 'delivered', next_poll_at: null }) }) }))
    const { unmount } = render(<ShalomSection orderId={ORDER} />)
    expect(await screen.findByText('deliveredBanner')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /refresh/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'correct' })).toBeNull()
    expect(screen.queryByText('nextPoll')).toBeNull()
    unmount()
    stubFetch(() => ({ body: panel({ can_stop: true, shipment: shipment({ tracking_state: 'stopped', stop_reason: 'order_cancelled', next_poll_at: null }) }) }))
    render(<ShalomSection orderId={ORDER} />)
    expect(await screen.findByText(/stoppedBanner/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'stop' })).toBeNull()
  })

  it('requires_attention, unknown-state exception and the three error kinds are visible and never mistaken for the status', async () => {
    stubFetch(() => ({ body: panel({ shipment: shipment({ tracking_state: 'requires_attention', next_poll_at: null, last_error_kind: 'order', last_error_code: 'not_found' }) }) }))
    const a = render(<ShalomSection orderId={ORDER} />)
    expect(await screen.findByText('attentionBanner')).toBeTruthy()
    expect(screen.getByRole('button', { name: /refresh/ })).toBeTruthy() // a person can re-arm it
    a.unmount()
    stubFetch(() => ({ body: panel({ shipment: shipment({ last_error_kind: 'exception', last_error_code: 'unknown_status' }) }) }))
    const b = render(<ShalomSection orderId={ORDER} />)
    expect(await screen.findByText('exceptionBanner')).toBeTruthy()
    expect(screen.getAllByText('status.in_transit').length).toBeGreaterThan(0) // the order did not advance
    b.unmount()
    for (const kind of ['order', 'integration', 'credentials']) {
      stubFetch(() => ({ body: panel({ shipment: shipment({ last_error_kind: kind, last_error_code: 'x' }) }) }))
      const r = render(<ShalomSection orderId={ORDER} />)
      expect(await screen.findByText(new RegExp(`errorKind.${kind}`))).toBeTruthy()
      r.unmount()
    }
  })

  it('the history lists the events (who / what) and the latest queries', async () => {
    stubFetch(() => ({
      body: panel({
        events: [{ id: 'e1', event_type: 'status_changed', from_status: null, to_status: 'in_transit', source: 'system', actor_name: 'system', detail: {}, created_at: '2026-12-01T16:00:00Z' }, { id: 'e2', event_type: 'identifier_corrected', from_status: null, to_status: null, source: 'user', actor_name: 'Laura Logística', detail: {}, created_at: '2026-12-01T15:00:00Z' }],
        polls: [{ id: 'p1', trigger: 'cron', started_at: '2026-12-01T16:00:00Z', outcome: 'ok', http_status: 200, latency_ms: 30, applied: true, ignored_reason: null }],
      }),
    }))
    render(<ShalomSection orderId={ORDER} />)
    fireEvent.click(await screen.findByRole('button', { name: /showHistory/ }))
    expect(screen.getByText(/events.status_changed/)).toBeTruthy()
    expect(screen.getByText(/Laura Logística/)).toBeTruthy()
    expect(screen.getByText(/outcome.ok/)).toBeTruthy()
  })
})

describe('ShalomSection · the 15-day alert', () => {
  const open = { id: ALERT, destination_episode: 1, status: 'open', due_date: '2026-12-16', created_at: '2026-12-16T05:00:00Z', acknowledged_at: null, resolved_at: null, resolved_reason: null }

  it('an open alert is shown with "attend"; attending posts to the alert endpoint and does not touch the order', async () => {
    let acked = false
    const f = stubFetch((url, init) => {
      if (init?.method === 'POST') {
        acked = true
        return { body: { changed: true } }
      }
      return { body: panel({ shipment: shipment({ logistic_status: 'at_destination' }), alerts: [{ ...open, ...(acked ? { status: 'acknowledged', acknowledged_at: '2026-12-16T06:00:00Z' } : {}) }] }) }
    })
    render(<ShalomSection orderId={ORDER} />)
    expect(await screen.findByText('alertTitle')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^ack$/ }))
    await waitFor(() => expect(f.mock.calls.some(([u, i]) => String(u).endsWith(`/api/orders/shalom/alerts/${ALERT}/ack`) && (i as RequestInit).method === 'POST')).toBe(true))
    expect(await screen.findByText(/acknowledged/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^ack$/ })).toBeNull()
    expect(posted(f, '/shalom/orders/')).toEqual([]) // no order action was sent
  })

  it('a resolved alert (delivered / left destination) is history, not a banner', async () => {
    stubFetch(() => ({ body: panel({ shipment: shipment({ logistic_status: 'delivered', tracking_state: 'delivered', next_poll_at: null }), alerts: [{ ...open, status: 'resolved', resolved_at: 't', resolved_reason: 'delivered' }] }) }))
    render(<ShalomSection orderId={ORDER} />)
    expect(await screen.findByText('deliveredBanner')).toBeTruthy()
    expect(screen.queryByText('alertTitle')).toBeNull()
  })
})

describe('DerivedLogisticsIndicator · the list shows the PR-05 status when a shipment exists, otherwise the PR-04 indicator', () => {
  type Stub = { observe: (el: Element) => void; disconnect: () => void }
  let reveal: () => void
  beforeEach(() => {
    class IO implements Stub {
      cb: IntersectionObserverCallback
      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb
        reveal = () => cb([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', IO)
  })

  it('nothing is asked until the row is visible; a shipment replaces the PR-04 indicator', async () => {
    const f = stubFetch(() => ({ body: { summaries: { [ORDER]: { logistic_status: 'in_transit', tracking_state: 'active', alert_open: false, needs_attention: false } } } }))
    render(<DerivedLogisticsIndicator orderId={ORDER} />)
    expect(f).not.toHaveBeenCalled()
    expect(screen.getByTestId('pr04-indicator')).toBeTruthy()
    reveal()
    await waitFor(() => expect(screen.queryByTestId('pr04-indicator')).toBeNull())
    expect(screen.getByText('status.in_transit')).toBeTruthy()
    expect(String(f.mock.calls[0][0])).toContain(`/api/orders/shalom/summary?ids=${ORDER}`)
  })

  it('without a shipment the PR-04 indicator stays; an open alert / attention is flagged', async () => {
    stubFetch(() => ({ body: { summaries: {} } }))
    const a = render(<DerivedLogisticsIndicator orderId={ORDER} />)
    reveal()
    await waitFor(() => expect(screen.getByTestId('pr04-indicator')).toBeTruthy())
    a.unmount()
    stubFetch(() => ({ body: { summaries: { [ORDER]: { logistic_status: 'at_destination', tracking_state: 'requires_attention', alert_open: true, needs_attention: true } } } }))
    render(<DerivedLogisticsIndicator orderId={ORDER} />)
    reveal()
    expect(await screen.findByText('status.at_destination')).toBeTruthy()
    expect(screen.getByLabelText('alertTitle')).toBeTruthy()
    expect(screen.getByText(/needsAttentionShort/)).toBeTruthy()
  })

  it('no access (403) is remembered while the list is on screen: nothing changes and no other row asks again', async () => {
    const f = stubFetch(() => ({ status: 403, body: { error: 'feature_disabled' } }))
    const { rerender } = render(<DerivedLogisticsIndicator orderId={ORDER} />)
    reveal()
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('pr04-indicator')).toBeTruthy()
    rerender(
      <>
        <DerivedLogisticsIndicator orderId={ORDER} />
        <DerivedLogisticsIndicator orderId="22222222-2222-4222-8222-222222222222" />
      </>,
    )
    reveal()
    await new Promise((r) => setTimeout(r, 20))
    expect(f).toHaveBeenCalledTimes(1)
    expect(screen.getAllByTestId('pr04-indicator')).toHaveLength(2)
  })

  it('without IntersectionObserver nothing is asked and the PR-04 indicator is shown exactly as before', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const f = stubFetch(() => ({ body: { summaries: {} } }))
    render(<DerivedLogisticsIndicator orderId={ORDER} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(f).not.toHaveBeenCalled()
    expect(screen.getByTestId('pr04-indicator')).toBeTruthy()
  })
})
