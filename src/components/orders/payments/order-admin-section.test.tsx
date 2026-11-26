// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('next-intl', () => {
  const t = Object.assign((key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key), { has: () => true })
  return { useLocale: () => 'es', useTranslations: () => t }
})

import { OrderAdminSection } from './order-admin-section'

const ORDER = '11111111-1111-4111-8111-111111111111'
const base = {
  tracked: true, total: 100, paid_confirmed: 0, pending_balance: 100, financial_status: 'unpaid', payments: [], events: [], delivery: { delivered: false, source: null, delivered_at: null, can_mark_manual: false },
  finalization: null, voucher_candidate: null, is_supervisor: false, cancellation: null, edits: [],
  order: { customer_name: 'Ana', dni: null, phone: '51900000001', product: 'Kit', quantity: 1, order_description: null, agency: 'Shalom', destination: 'Lima', department: null, seller_name: 'S', seller_user_id: null },
  items: [{ line_number: 1, product_name: 'Kit', quantity: 1, unit_price: 100, catalog_product_id: null }],
}
const stubPost = (status = 200, body: unknown = { changed: true }) => {
  const f = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', f)
  return f
}
const sent = (f: ReturnType<typeof stubPost>) =>
  (f.mock.calls as unknown as Array<[unknown, RequestInit]>)
    .map(([, init]) => JSON.parse(String(init.body)))

beforeEach(() => vi.spyOn(window, 'confirm').mockReturnValue(true))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('OrderAdminSection', () => {
  it('edit: sends only the fields that changed, with the reason, then reloads', async () => {
    const f = stubPost()
    const onChanged = vi.fn(async () => {})
    render(<OrderAdminSection orderId={ORDER} panel={base as never} onChanged={onChanged} />)
    fireEvent.click(screen.getByText('edit'))
    fireEvent.change(screen.getByDisplayValue('Lima'), { target: { value: 'Cusco' } })
    fireEvent.change(screen.getByLabelText('reason'), { target: { value: 'dato corregido' } })
    fireEvent.click(screen.getByText('save'))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(sent(f)).toEqual([{ action: 'edit_order', fields: { destination: 'Cusco' }, reason: 'dato corregido' }])
  })

  it('edit lines: the products are sent as lines; the browser never sends a total', async () => {
    const f = stubPost()
    render(<OrderAdminSection orderId={ORDER} panel={base as never} onChanged={async () => {}} />)
    fireEvent.click(screen.getByText('edit'))
    fireEvent.change(screen.getAllByLabelText('field.unit_price')[0], { target: { value: '80,50' } })
    fireEvent.change(screen.getByLabelText('reason'), { target: { value: 'descuento' } })
    fireEvent.click(screen.getByText('save'))
    await waitFor(() => expect(f).toHaveBeenCalled())
    expect(sent(f)[0]).toEqual({ action: 'edit_order', fields: { items: [{ product_name: 'Kit', quantity: '1', unit_price: '80.50', item_type: 'product' }] }, reason: 'descuento' })
  })

  it('nothing changed -> nothing is sent; a reason is required to save', () => {
    const f = stubPost()
    render(<OrderAdminSection orderId={ORDER} panel={base as never} onChanged={async () => {}} />)
    fireEvent.click(screen.getByText('edit'))
    expect((screen.getByText('save') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('reason'), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('save'))
    expect(f).not.toHaveBeenCalled()
  })

  it('cancel an unpaid order: reason required, confirm dialog, posts cancel_order', async () => {
    const f = stubPost(200, { changed: true })
    const onChanged = vi.fn(async () => {})
    render(<OrderAdminSection orderId={ORDER} panel={base as never} onChanged={onChanged} />)
    fireEvent.click(screen.getByText('cancelOrder'))
    expect((screen.getByText('confirmCancel') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('reason'), { target: { value: 'desistió' } })
    fireEvent.click(screen.getByText('confirmCancel'))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(sent(f)).toEqual([{ action: 'cancel_order', reason: 'desistió', acknowledge_paid: false }])
  })

  it('paid order: logistics cannot cancel; a supervisor must acknowledge the refund first', () => {
    const paid = { ...base, paid_confirmed: 40 }
    const a = render(<OrderAdminSection orderId={ORDER} panel={paid as never} onChanged={async () => {}} />)
    fireEvent.click(screen.getByText('cancelOrder'))
    expect(screen.getByText(/cancelNeedsSupervisor/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('reason'), { target: { value: 'x' } })
    expect((screen.getByText('confirmCancel') as HTMLButtonElement).disabled).toBe(true)
    a.unmount()
    render(<OrderAdminSection orderId={ORDER} panel={{ ...paid, is_supervisor: true } as never} onChanged={async () => {}} />)
    fireEvent.click(screen.getByText('cancelOrder'))
    fireEvent.change(screen.getByLabelText('reason'), { target: { value: 'x' } })
    expect((screen.getByText('confirmCancel') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    expect((screen.getByText('confirmCancel') as HTMLButtonElement).disabled).toBe(false)
  })

  it('a cancelled order shows the cancellation and the refund, and offers no more actions; delivered orders offer none either', () => {
    const cancelled = { ...base, cancellation: { reason: 'desistió', actor_name: 'Lucía', paid_confirmed: 40, refund_required: true, shipment_stopped: true, customer_notice: 'not_requested', cancelled_at: '2027-02-01T10:00:00Z' } }
    const a = render(<OrderAdminSection orderId={ORDER} panel={cancelled as never} onChanged={async () => {}} />)
    expect(screen.getByText('cancelledTitle')).toBeTruthy()
    expect(screen.getByText(/refundRequired/)).toBeTruthy()
    expect(screen.queryByText('edit')).toBeNull()
    a.unmount()
    render(<OrderAdminSection orderId={ORDER} panel={{ ...base, delivery: { ...base.delivery, delivered: true } } as never} onChanged={async () => {}} />)
    expect(screen.queryByText('edit')).toBeNull()
    expect(screen.getByText('closedHint')).toBeTruthy()
  })

  it('the server error is shown, nothing is reloaded', async () => {
    const f = stubPost(409, { error: 'below_paid', paid_confirmed: 80 })
    const onChanged = vi.fn(async () => {})
    const { toast } = await import('sonner')
    render(<OrderAdminSection orderId={ORDER} panel={base as never} onChanged={onChanged} />)
    fireEvent.click(screen.getByText('edit'))
    fireEvent.change(screen.getByDisplayValue('Lima'), { target: { value: 'Ica' } })
    fireEvent.change(screen.getByLabelText('reason'), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('save'))
    await waitFor(() => expect(f).toHaveBeenCalled())
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(onChanged).not.toHaveBeenCalled()
  })
})
