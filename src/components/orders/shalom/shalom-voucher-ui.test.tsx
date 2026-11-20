// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() } }))
vi.mock('next-intl', () => {
  const t = Object.assign((key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key), { has: () => true })
  return { useLocale: () => 'es', useTranslations: () => t }
})
vi.mock('@/components/orders/logistics/voucher-indicator', () => ({ VoucherIndicator: ({ orderId }: { orderId: string }) => <span>{orderId}</span> }))

import { __resetShipmentSummaryStore } from './shalom-indicator'
import { ShalomSection } from './shalom-section'

const ORDER = '11111111-1111-4111-8111-111111111111'
const MSG = '88888888-8888-4888-8888-888888888888'
const shipment = { id: 's1', order_id: ORDER, tracking_number: '12345678', tracking_code: '7M99', identifier_version: 1, logistic_status: 'at_destination', tracking_state: 'active', stop_reason: null, stopped_at: null, status_changed_at: '2026-12-01T15:00:00Z', destination_episode: 1, destination_entered_at: '2026-12-01T15:00:00Z', last_polled_at: null, last_success_at: null, next_poll_at: null, consecutive_failures: 0, last_error_kind: null, last_error_code: null, pickup_state: 'waiting_pickup', pickup_alerted_at: null, pickup_abandoned_at: null }
const vmsg = (over: Record<string, unknown> = {}) => ({ id: MSG, identifier_version: 1, status: 'sent', attempt: 1, error_code: null, created_at: '2026-12-02T15:00:00Z', finished_at: null, ...over })
const panel = (voucher_messages: unknown[]) => ({ eligible: true, shipment, events: [], alerts: [], polls: [], messages: [], voucher_messages, days_at_destination: 3, can_stop: false })

function stub(body: unknown) {
  const f = vi.fn(async (_u: string, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'POST' ? { ok: true } : body), { status: 200 }))
  vi.stubGlobal('fetch', f)
  return f
}
const posted = (f: ReturnType<typeof stub>) => f.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === 'POST').map(([, i]) => JSON.parse(String((i as RequestInit).body)))

beforeEach(() => vi.spyOn(window, 'confirm').mockReturnValue(true))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); __resetShipmentSummaryStore() })

describe('voucher notice row in Tracking Shalom', () => {
  it('no notice yet: shows "none" and ONE send button; a click sends exactly one send_voucher', async () => {
    const f = stub(panel([]))
    render(<ShalomSection orderId={ORDER} />)
    expect(await screen.findByText('voucherStatus.none')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'sendVoucher' }))
    await waitFor(() => expect(posted(f)).toEqual([{ action: 'send_voucher' }]))
  })

  it('sent: no send button (one per guide)', async () => {
    stub(panel([vmsg()]))
    render(<ShalomSection orderId={ORDER} />)
    expect(await screen.findByText('voucherStatus.sent')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'sendVoucher' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'retryVoucher' })).toBeNull()
  })

  it('failed: only a human retry; uncertain: only resolve (no retry, no send)', async () => {
    const f = stub(panel([vmsg({ status: 'failed', error_code: 'meta_rejected' })]))
    render(<ShalomSection orderId={ORDER} />)
    fireEvent.click(await screen.findByRole('button', { name: 'retryVoucher' }))
    await waitFor(() => expect(posted(f)).toEqual([{ action: 'retry_voucher', message_id: MSG }]))
    cleanup()
    stub(panel([vmsg({ status: 'uncertain', error_code: 'meta_unreachable' })]))
    render(<ShalomSection orderId={ORDER} />)
    expect(await screen.findByRole('button', { name: 'resolveSent' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'retryVoucher' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'sendVoucher' })).toBeNull()
  })
})
