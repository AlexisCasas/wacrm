// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() } }))
vi.mock('next-intl', () => {
  const t = Object.assign((key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key), { has: () => true })
  return { useLocale: () => 'es', useTranslations: () => t }
})

import { ConversationFinancials } from './conversation-financials'
import { __resetPaymentSummaryStore, PaymentChip } from './payment-indicator'
import { PaymentsSection } from './payments-section'

const ORDER = '11111111-1111-4111-8111-111111111111'
const PAY = '55555555-5555-4555-8555-555555555555'
const payment = (over: Record<string, unknown> = {}) => ({
  id: PAY, amount: 30, kind: 'advance', method: 'yape', operation_number: null, paid_at: '2027-02-01T10:00:00Z', status: 'recorded', evidence_document_id: null, notes: null, supersedes_payment_id: null,
  overpayment_reason: null, registered_by_name: 'Lucía', registered_at: '2027-02-01T10:00:00Z', confirmed_by_name: null, confirmed_at: null, rejected_reason: null, voided_reason: null, voided_at: null, row_version: 1, ...over,
})
const panel = (over: Record<string, unknown> = {}) => ({
  tracked: true, total: 100, paid_confirmed: 0, pending_balance: 100, financial_status: 'unpaid', payments: [], events: [],
  delivery: { delivered: false, source: null, delivered_at: null, can_mark_manual: false }, finalization: null, voucher_candidate: null, is_supervisor: false, ...over,
})

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown } | undefined
function stubFetch(handler: Handler) {
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const r = handler(String(url), init) ?? { status: 404, body: {} }
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
  })
  vi.stubGlobal('fetch', f)
  return f
}
const posted = (f: ReturnType<typeof stubFetch>, path = '/api/orders/payments/orders/') =>
  f.mock.calls.filter(([u, i]) => String(u).includes(path) && (i as RequestInit | undefined)?.method === 'POST' && typeof (i as RequestInit).body === 'string').map(([, i]) => JSON.parse(String((i as RequestInit).body)))

beforeEach(() => vi.spyOn(window, 'confirm').mockReturnValue(true))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  __resetPaymentSummaryStore()
})

describe('PaymentsSection · who sees it', () => {
  it.each([401, 403, 404])('answer %i (flag OFF, Commercial, viewer, no area, other account) -> renders NOTHING', async (status) => {
    const f = stubFetch(() => ({ status, body: { error: 'feature_disabled' } }))
    const { container } = render(<PaymentsSection orderId={ORDER} />)
    await waitFor(() => expect(f).toHaveBeenCalled())
    await waitFor(() => expect(container.querySelector('section')).toBeNull())
    expect(container.textContent).toBe('')
  })

  it('an order that is not tracked (historical) shows nothing; a 500 is an error with a retry', async () => {
    stubFetch(() => ({ body: panel({ tracked: false, financial_status: null }) }))
    const a = render(<PaymentsSection orderId={ORDER} />)
    await waitFor(() => expect(a.container.querySelector('section')).toBeNull())
    a.unmount()
    let calls = 0
    stubFetch(() => ((calls += 1) === 1 ? { status: 500, body: {} } : { body: panel() }))
    render(<PaymentsSection orderId={ORDER} />)
    fireEvent.click(await screen.findByRole('button', { name: 'retry' }))
    expect((await screen.findAllByText('S/ 100.00')).length).toBeGreaterThan(0)
  })
})

describe('PaymentsSection · Total / Pagado / Saldo / Estado', () => {
  it('A. S/100 without payments: unpaid, balance S/100; B. partial: balance 70; C. paid: balance 0', async () => {
    stubFetch(() => ({ body: panel() }))
    const a = render(<PaymentsSection orderId={ORDER} />)
    expect(await screen.findByText('status.unpaid')).toBeTruthy()
    expect(screen.getByText('noPayments')).toBeTruthy()
    expect(screen.getAllByText('S/ 100.00')).toHaveLength(2) // total and balance
    a.unmount()
    stubFetch(() => ({ body: panel({ paid_confirmed: 30, pending_balance: 70, financial_status: 'partially_paid', payments: [payment({ status: 'confirmed' })] }) }))
    const b = render(<PaymentsSection orderId={ORDER} />)
    expect(await screen.findByText('status.partially_paid')).toBeTruthy()
    expect(screen.getByText('S/ 70.00')).toBeTruthy()
    b.unmount()
    stubFetch(() => ({ body: panel({ paid_confirmed: 100, pending_balance: 0, financial_status: 'paid', payments: [payment({ amount: 100, status: 'confirmed' })] }) }))
    render(<PaymentsSection orderId={ORDER} />)
    expect(await screen.findByText('status.paid')).toBeTruthy()
    expect(screen.getByText('paidNotDelivered')).toBeTruthy() // paid but not delivered: NOT finalized
    expect(screen.queryByText(/finalized/)).toBeNull()
  })

  it('delivered + balance is NOT finalized; delivered + paid shows the finalization', async () => {
    stubFetch(() => ({ body: panel({ paid_confirmed: 30, pending_balance: 70, financial_status: 'partially_paid', delivery: { delivered: true, source: 'manual', delivered_at: '2027-02-01T10:00:00Z', can_mark_manual: false } }) }))
    const a = render(<PaymentsSection orderId={ORDER} />)
    expect(await screen.findByText('deliveredWithBalance')).toBeTruthy()
    a.unmount()
    stubFetch(() => ({ body: panel({ paid_confirmed: 100, pending_balance: 0, financial_status: 'paid', delivery: { delivered: true, source: 'shalom', delivered_at: '2027-02-01T10:00:00Z', can_mark_manual: false }, finalization: { finalized_at: '2027-02-01T10:00:00Z', return_state: 'pending' } }) }))
    render(<PaymentsSection orderId={ORDER} />)
    expect(await screen.findByText(/finalized:/)).toBeTruthy()
  })
})

describe('PaymentsSection · actions by role', () => {
  it('Logistica: register posts only the payment (no account / role / actor / balance); a double click is ONE request; confirm / reject show; void / correct do NOT', async () => {
    let list = [] as ReturnType<typeof payment>[]
    const f = stubFetch((_u, init) => (init?.method === 'POST' ? { status: 201, body: { payment_id: PAY } } : { body: panel({ payments: list }) }))
    render(<PaymentsSection orderId={ORDER} />)
    fireEvent.click(await screen.findByRole('button', { name: 'register' }))
    const submit = (await screen.findByRole('button', { name: 'save' })) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('amount'), { target: { value: '30,00' } })
    fireEvent.change(screen.getByLabelText('method'), { target: { value: 'yape' } })
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    fireEvent.click(submit)
    await waitFor(() => expect(posted(f)).toHaveLength(1))
    const body = posted(f)[0]
    expect(body).toMatchObject({ action: 'register', amount: '30,00', kind: 'advance', method: 'yape' })
    expect(body.request_key).toBeTruthy()
    expect(Object.keys(body).sort()).toEqual(['action', 'amount', 'kind', 'method', 'paid_at', 'request_key'])
    list = [payment()]
    stubFetch((_u, init) => (init?.method === 'POST' ? { body: { changed: true } } : { body: panel({ payments: list }) }))
    cleanup()
    render(<PaymentsSection orderId={ORDER} />)
    expect(await screen.findByRole('button', { name: 'confirm' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'reject' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'void' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'correct' })).toBeNull()
  })

  it('confirm sends the payment and its row_version; a server refusal (exceeds_balance) is shown, not hidden', async () => {
    const f = stubFetch((_u, init) => (init?.method === 'POST' ? { status: 409, body: { error: 'exceeds_balance', pending_balance: 20 } } : { body: panel({ pending_balance: 20, paid_confirmed: 80, payments: [payment({ amount: 50 })] }) }))
    render(<PaymentsSection orderId={ORDER} />)
    fireEvent.click(await screen.findByRole('button', { name: 'confirm' }))
    await waitFor(() => expect(posted(f)).toEqual([{ action: 'confirm', payment_id: PAY, expected_version: 1 }]))
    const { toast } = await import('sonner')
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('exceeds_balance_with')))
  })

  it('Supervisor: void and correct need a reason; an excess confirmation asks for the overpayment reason first', async () => {
    const f = stubFetch((_u, init) => (init?.method === 'POST' ? { body: { changed: true } } : { body: panel({ is_supervisor: true, pending_balance: 20, paid_confirmed: 80, payments: [payment({ id: 'c1', amount: 80, status: 'confirmed', row_version: 2 }), payment({ amount: 50 })] }) }))
    render(<PaymentsSection orderId={ORDER} />)
    const voidBtn = await screen.findByRole('button', { name: 'void' })
    fireEvent.click(voidBtn)
    const accept = screen.getByRole('button', { name: 'accept' }) as HTMLButtonElement
    expect(accept.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('reasonPlaceholder'), { target: { value: 'devuelto por el banco' } })
    fireEvent.click(accept)
    await waitFor(() => expect(posted(f)).toEqual([{ action: 'void', payment_id: 'c1', expected_version: 2, reason: 'devuelto por el banco' }]))
    // the 50 > balance 20: the supervisor is asked for a reason BEFORE anything is sent
    fireEvent.click(screen.getAllByRole('button', { name: 'confirm' })[0])
    expect(posted(f)).toHaveLength(1)
    fireEvent.change(screen.getByLabelText('reasonPlaceholder'), { target: { value: 'cliente pagó de más' } })
    fireEvent.click(screen.getByRole('button', { name: 'accept' }))
    await waitFor(() => expect(posted(f)[1]).toMatchObject({ action: 'confirm', payment_id: PAY, overpayment_reason: 'cliente pagó de más' }))
    // correct: pre-filled, reason required, new request key
    fireEvent.click(screen.getAllByRole('button', { name: 'correct' })[0])
    const save = (await screen.findByRole('button', { name: 'saveCorrection' })) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('correctReason'), { target: { value: 'monto mal digitado' } })
    fireEvent.change(screen.getByLabelText('amount'), { target: { value: '70.00' } })
    fireEvent.click(save)
    await waitFor(() => expect(posted(f).at(-1)).toMatchObject({ action: 'correct', payment_id: 'c1', expected_version: 2, reason: 'monto mal digitado', amount: '70.00' }))
    expect(posted(f).at(-1).request_key).toBeTruthy()
  })

  it('a validated PR-04 voucher is offered as a CANDIDATE: it pre-fills the amount and links as evidence, but nothing is sent until a person saves', async () => {
    const f = stubFetch((_u, init) => (init?.method === 'POST' ? { status: 201, body: { payment_id: PAY } } : { body: panel({ voucher_candidate: { id: '99999999-9999-4999-8999-999999999999', filename: 'yape.pdf', amount_hint: 30 } }) }))
    render(<PaymentsSection orderId={ORDER} />)
    fireEvent.click(await screen.findByRole('button', { name: 'register' }))
    expect((screen.getByLabelText('amount') as HTMLInputElement).value).toBe('30.00')
    expect(screen.getByText(/evidenceLinked/)).toBeTruthy()
    expect(posted(f)).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'save' }))
    await waitFor(() => expect(posted(f)[0]).toMatchObject({ action: 'register', amount: '30.00', evidence_document_id: '99999999-9999-4999-8999-999999999999' }))
  })

  it('manual delivery: only when the server says so (no active Shalom shipment); asks for confirmation; declining sends nothing', async () => {
    const f = stubFetch((_u, init) => (init?.method === 'POST' ? { body: { changed: true } } : { body: panel({ delivery: { delivered: false, source: null, delivered_at: null, can_mark_manual: true } }) }))
    render(<PaymentsSection orderId={ORDER} />)
    const btn = await screen.findByRole('button', { name: 'markDelivered' })
    ;(window.confirm as ReturnType<typeof vi.fn>).mockReturnValueOnce(false)
    fireEvent.click(btn)
    expect(posted(f)).toEqual([])
    fireEvent.click(btn)
    await waitFor(() => expect(posted(f)).toEqual([{ action: 'mark_delivered' }]))
    cleanup()
    stubFetch(() => ({ body: panel() })) // can_mark_manual false (active Shalom shipment): no button
    render(<PaymentsSection orderId={ORDER} />)
    await screen.findByText('status.unpaid')
    expect(screen.queryByRole('button', { name: 'markDelivered' })).toBeNull()
  })
})

describe('PaymentChip (list) and the read-only chat view', () => {
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

  it.each([
    ['unpaid', /chip\.unpaid/, true],
    ['partially_paid', /chip\.partially_paid/, true],
    ['paid', /chip\.paid/, false],
  ])('%s chip (balance only while unpaid / partial)', async (financial_status, chip, hasBalance) => {
    stubFetch(() => ({ body: { summaries: { [ORDER]: { financial_status, total: 100, paid_confirmed: 30, pending_balance: hasBalance ? 70 : 0 } } } }))
    render(<PaymentChip orderId={ORDER} />)
    expect(await screen.findByText(chip)).toBeTruthy()
    if (hasBalance) expect(screen.getByText(/chipBalance/)).toBeTruthy()
    else expect(screen.queryByText(/chipBalance/)).toBeNull()
  })

  it('no access (403 / 404) or not tracked: nothing is shown and the list never asks again', async () => {
    const f = stubFetch(() => ({ status: 403, body: { error: 'feature_disabled' } }))
    const { container } = render(<PaymentChip orderId={ORDER} />)
    await waitFor(() => expect(f).toHaveBeenCalled())
    expect(container.textContent).toBe('')
    cleanup()
    stubFetch(() => ({ body: { summaries: {} } }))
    const r = render(<PaymentChip orderId="22222222-2222-4222-8222-222222222222" />)
    await waitFor(() => expect(r.container.textContent).toBe(''))
  })

  it('Commercial chat view: Total / Pagado / Saldo / Estado, NO buttons, nothing about payments or evidence; hidden without access', async () => {
    stubFetch(() => ({ body: { orders: [{ order_id: ORDER, product: 'Producto A', confirmed_at: '2027-02-01T10:00:00Z', financial_status: 'partially_paid', total: 100, paid_confirmed: 30, pending_balance: 70 }] } }))
    const { container } = render(<ConversationFinancials conversationId="33333333-3333-4333-8333-333333333333" />)
    expect(await screen.findByTestId('conversation-financials')).toBeTruthy()
    for (const label of ['total', 'paid', 'balance', 'statusLabel']) expect(screen.getByText(label)).toBeTruthy()
    expect(screen.getByText('S/ 70.00')).toBeTruthy()
    expect(screen.getByText('status.partially_paid')).toBeTruthy()
    expect(container.querySelectorAll('button, input, a, form')).toHaveLength(0)
    cleanup()
    const f = stubFetch(() => ({ status: 404, body: { error: 'not_found' } }))
    const hidden = render(<ConversationFinancials conversationId="33333333-3333-4333-8333-333333333333" />)
    await waitFor(() => expect(f).toHaveBeenCalled())
    expect(hidden.container.textContent).toBe('')
    expect(render(<ConversationFinancials conversationId={null} />).container.textContent).toBe('')
  })
})
