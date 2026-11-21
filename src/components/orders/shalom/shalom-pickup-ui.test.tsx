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

// PR-05A / PR-05B in the UI: the pickup block (Estado Shalom / Días en destino / Estado de recojo / Mensaje al cliente / Alerta interna), the
// "En abandono" banner and the list chips. "En abandono" is shown NEXT TO the Shalom status, never as one.

const ORDER = '11111111-1111-4111-8111-111111111111'
const MESSAGE = '77777777-7777-4777-8777-777777777777'
const shipment = (over: Record<string, unknown> = {}) => ({
  id: 's1', order_id: ORDER, tracking_number: '12345678', tracking_code: '7M99', identifier_version: 1, logistic_status: 'at_destination', tracking_state: 'active',
  stop_reason: null, stopped_at: null, status_changed_at: '2026-12-01T15:00:00Z', destination_episode: 1, destination_entered_at: '2026-12-01T15:00:00Z',
  last_polled_at: '2026-12-01T16:00:00Z', last_success_at: '2026-12-01T16:00:00Z', next_poll_at: '2026-12-01T19:00:00Z', consecutive_failures: 0,
  last_error_kind: null, last_error_code: null, pickup_state: 'waiting_pickup', pickup_alerted_at: null, pickup_abandoned_at: null, ...over,
})
const message = (over: Record<string, unknown> = {}) => ({ id: MESSAGE, destination_episode: 1, status: 'sent', attempt: 1, error_code: null, next_attempt_at: null, resolution: null, created_at: '2026-12-16T15:00:00Z', finished_at: null, ...over })
const alert = (over: Record<string, unknown> = {}) => ({ id: 'a1', destination_episode: 1, status: 'open', due_date: '2026-12-16', created_at: '2026-12-16T15:00:00Z', acknowledged_at: null, resolved_at: null, resolved_reason: null, ...over })
const panel = (over: Record<string, unknown> = {}) => ({ eligible: true, shipment: shipment(), events: [], alerts: [], polls: [], messages: [], days_at_destination: 3, can_stop: false, ...over })

function stubFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const r = handler(String(url), init)
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
  })
  vi.stubGlobal('fetch', f)
  return f
}
const posted = (f: ReturnType<typeof stubFetch>) => f.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === 'POST').map(([, i]) => JSON.parse(String((i as RequestInit).body)))

beforeEach(() => vi.spyOn(window, 'confirm').mockReturnValue(true))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  __resetShipmentSummaryStore()
})

describe('pickup block inside Tracking Shalom', () => {
  it('waiting: Shalom status, days at destination, pickup state, and no message / alert yet', async () => {
    stubFetch(() => ({ body: panel() }))
    render(<ShalomSection orderId={ORDER} />)
    expect(await screen.findByText('pickupTitle')).toBeTruthy()
    expect(screen.getByText('shalomStatus')).toBeTruthy()
    expect(screen.getAllByText('status.at_destination').length).toBeGreaterThan(0)
    expect(screen.getByText('daysValue:{"count":3}')).toBeTruthy()
    expect(screen.getByText('pickupStates.waiting_pickup')).toBeTruthy()
    expect(screen.getByText('internalAlertStates.none')).toBeTruthy()
    expect(screen.getByText('customerMessageStatus.none')).toBeTruthy()
    expect(screen.queryByText(/abandonmentNote/)).toBeNull()
  })

  it('day 15: open internal alert + message sent, side by side (the message does not depend on the alert being attended)', async () => {
    stubFetch(() => ({ body: panel({ shipment: shipment({ pickup_state: 'alerted_15d' }), alerts: [alert()], messages: [message()], days_at_destination: 15 }) }))
    render(<ShalomSection orderId={ORDER} />)
    expect(await screen.findByText('pickupStates.alerted_15d')).toBeTruthy()
    expect(screen.getByText('internalAlertStates.open')).toBeTruthy()
    expect(screen.getByText('customerMessageStatus.sent')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'retryMessage' })).toBeNull()
  })

  it('a FAILED message offers a controlled retry (message id only); the shipment keeps its Shalom status', async () => {
    const f = stubFetch((_u, init) => (init?.method === 'POST' ? { body: { queued: true } } : { body: panel({ shipment: shipment({ pickup_state: 'alerted_15d' }), messages: [message({ status: 'failed', attempt: 3 })] }) }))
    render(<ShalomSection orderId={ORDER} />)
    expect(await screen.findByText('customerMessageStatus.failed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'retryMessage' }))
    await waitFor(() => expect(posted(f)).toEqual([{ action: 'retry_message', message_id: MESSAGE }]))
    expect(screen.getAllByText('status.at_destination').length).toBeGreaterThan(0)
  })

  it('the immediate ARRIVAL notice has its own row, next to (not instead of) the day-15 one; a row without kind is the day-15 message', async () => {
    stubFetch(() => ({ body: panel({ messages: [message({ id: 'arrival-1', kind: 'destination_arrival_customer', status: 'sent' }), message({ id: 'day15-1', kind: 'destination_15d_customer', status: 'pending' })] }) }))
    render(<ShalomSection orderId={ORDER} />)
    expect(await screen.findByText('arrivalMessage')).toBeTruthy()
    expect(screen.getByText('customerMessageStatus.sent')).toBeTruthy()
    expect(screen.getByText('customerMessageStatus.pending')).toBeTruthy()
  })

  it('no arrival row is shown when the arrival notice does not exist (flag OFF / not configured): the panel is exactly the day-15 one', async () => {
    stubFetch(() => ({ body: panel({ messages: [message({ kind: 'destination_15d_customer', status: 'sent' })] }) }))
    render(<ShalomSection orderId={ORDER} />)
    expect(await screen.findByText('customerMessageStatus.sent')).toBeTruthy()
    expect(screen.queryByText('arrivalMessage')).toBeNull()
  })

  it('a FAILED arrival notice offers ITS OWN controlled retry (its message id), independent of the day-15 message', async () => {
    const f = stubFetch((_u, init) => (init?.method === 'POST' ? { body: { queued: true } } : { body: panel({ messages: [message({ id: 'arrival-9', kind: 'destination_arrival_customer', status: 'failed', attempt: 2 }), message({ id: 'day15-9', kind: 'destination_15d_customer', status: 'sent' })] }) }))
    render(<ShalomSection orderId={ORDER} />)
    expect(await screen.findByText('customerMessageStatus.failed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'retryMessage' }))
    await waitFor(() => expect(posted(f)).toEqual([{ action: 'retry_message', message_id: 'arrival-9' }]))
  })

  it('an UNCERTAIN message is NOT retried: the person confirms whether it was delivered', async () => {
    const f = stubFetch((_u, init) => (init?.method === 'POST' ? { body: { status: 'sent' } } : { body: panel({ shipment: shipment({ pickup_state: 'alerted_15d' }), messages: [message({ status: 'uncertain' })] }) }))
    render(<ShalomSection orderId={ORDER} />)
    expect(await screen.findByText('customerMessageStatus.uncertain')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'retryMessage' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'resolveNotSent' }))
    await waitFor(() => expect(posted(f)).toEqual([{ action: 'resolve_message', message_id: MESSAGE, resolution: 'confirmed_not_sent' }]))
  })

  it('EN ABANDONO: banner with date next to (not instead of) the Shalom status; tracking still active', async () => {
    stubFetch(() => ({ body: panel({ shipment: shipment({ pickup_state: 'abandoned', pickup_abandoned_at: '2026-12-21T05:00:00Z' }), alerts: [alert({ status: 'acknowledged' })], messages: [message()], days_at_destination: 20 }) }))
    render(<ShalomSection orderId={ORDER} />)
    expect(await screen.findByText(/abandonment ·/)).toBeTruthy()
    expect(screen.getByText('abandonmentNote')).toBeTruthy()
    expect(screen.getByText('pickupStates.abandoned')).toBeTruthy()
    expect(screen.getByText('internalAlertStates.acknowledged')).toBeTruthy()
    expect(screen.getAllByText('status.at_destination').length).toBeGreaterThan(0)
    expect(screen.getByText('state.active')).toBeTruthy()
  })

  it('delivered after abandonment: the abandonment banner is gone, the pickup is completed, the history stays', async () => {
    stubFetch(() => ({ body: panel({ shipment: shipment({ logistic_status: 'delivered', tracking_state: 'delivered', pickup_state: 'completed', pickup_abandoned_at: '2026-12-21T05:00:00Z' }), alerts: [alert({ status: 'resolved' })], messages: [message()], days_at_destination: null }) }))
    render(<ShalomSection orderId={ORDER} />)
    expect(await screen.findByText('pickupStates.completed')).toBeTruthy()
    expect(screen.queryByText('abandonmentNote')).toBeNull()
    expect(screen.queryByText('daysAtDestination')).toBeNull()
    expect(screen.getByText('deliveredBanner')).toBeTruthy()
    expect(screen.getByText('internalAlertStates.resolved')).toBeTruthy()
  })
})

describe('list chips', () => {
  beforeEach(() => {
    class IO {
      constructor(cb: IntersectionObserverCallback) {
        queueMicrotask(() => cb([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver))
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', IO)
  })
  const summary = (over: Record<string, unknown>) => ({ logistic_status: 'at_destination', tracking_state: 'active', alert_open: false, needs_attention: false, pickup_state: 'waiting_pickup', days_at_destination: 4, ...over })

  it.each([
    ['alerted_15d', /alert15Short/, 16],
    ['abandoned', /abandonedShort:\{"days":21\}/, 21],
  ])('%s shows its chip NEXT to En destino', async (pickup_state, chip, days) => {
    stubFetch(() => ({ body: { summaries: { [ORDER]: summary({ pickup_state, days_at_destination: days }) } } }))
    render(<DerivedLogisticsIndicator orderId={ORDER} />)
    expect(await screen.findByText('status.at_destination')).toBeTruthy()
    expect(screen.getByText(chip)).toBeTruthy()
  })

  it('waiting_pickup / completed add no chip', async () => {
    stubFetch(() => ({ body: { summaries: { [ORDER]: summary({}) } } }))
    render(<DerivedLogisticsIndicator orderId={ORDER} />)
    expect(await screen.findByText('status.at_destination')).toBeTruthy()
    expect(screen.queryByText(/alert15Short|abandonedShort/)).toBeNull()
  })
})
