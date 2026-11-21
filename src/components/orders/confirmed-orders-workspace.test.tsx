// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('next-intl', () => ({
  useLocale: () => 'es',
  useTranslations: () => (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
}))

import { ConfirmedOrdersWorkspace } from './confirmed-orders-workspace'

const CONV = '33333333-3333-4333-8333-333333333333'
const order = (over: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  confirmed_at: '2026-11-16T17:12:59.474993+00:00',
  customer_name: 'Cliente Uno',
  seller_name: 'Angelo Jesus',
  order_status: 'Pedido confirmado',
  delivery_status: 'held',
  agency: 'Shalom',
  destination: 'Lima',
  department: 'Lima',
  conversation_id: CONV,
  total: 120,
  quantity: 2,
  product_summary: 'Producto A',
  lines: [{ line_number: 1, product_name: 'Producto A', quantity: 2, unit_price: null, subtotal: 120 }],
  is_multiproduct: false,
  ...over,
})
const multi = (over: Record<string, unknown> = {}) =>
  order({
    id: '22222222-2222-4222-8222-222222222222',
    customer_name: 'Cliente Tres',
    product_summary: '2 × Producto C + 1 × Producto D',
    quantity: 3,
    total: 175,
    is_multiproduct: true,
    lines: [
      { line_number: 1, product_name: 'Producto C', quantity: 2, unit_price: 75, subtotal: 150 },
      { line_number: 2, product_name: 'Producto D', quantity: 1, unit_price: 25, subtotal: 25 },
    ],
    ...over,
  })
const answer = (body: unknown, status = 200) => {
  const f = vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', f)
  return f
}
const viewButtons = () => screen.getAllByRole('button', { name: /openOrder/ })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  push.mockReset()
})

describe('ConfirmedOrdersWorkspace: list', () => {
  it('renders customer, date, product, total, destination, both badges and seller; never DNI or phone', async () => {
    answer({ orders: [order()], next_cursor: null })
    const { container } = render(<ConfirmedOrdersWorkspace />)
    await screen.findByText('Cliente Uno')
    expect(screen.getByText('16 nov 2026 · 12:12')).toBeTruthy() // America/Lima
    expect(screen.getByText('Producto A')).toBeTruthy()
    expect(screen.getByText('units:{"count":2}')).toBeTruthy()
    expect(screen.getAllByText('S/ 120.00').length).toBeGreaterThan(0)
    expect(screen.getByText('Lima', { selector: 'p' })).toBeTruthy()
    expect(screen.getByText('Shalom')).toBeTruthy()
    expect(screen.getByText('Pedido confirmado')).toBeTruthy()
    expect(screen.getByText('delivery.held')).toBeTruthy()
    expect(screen.getByText('Angelo Jesus')).toBeTruthy()
    expect(container.textContent).not.toMatch(/dni|phone|tel[eé]fono/i)
  })

  it('a multi-product row shows "N products" and the product names, not a duplicated order', async () => {
    answer({ orders: [multi()], next_cursor: null })
    render(<ConfirmedOrdersWorkspace />)
    await screen.findByText('multiproduct:{"count":2}')
    expect(screen.getByText('Producto C +')).toBeTruthy()
    expect(screen.getByText('Producto D')).toBeTruthy()
    expect(screen.getAllByText('Cliente Tres')).toHaveLength(1)
  })

  it('summary cards come from the loaded data (loaded, pending integration, amount); nothing is hardcoded', async () => {
    answer({
      orders: [order(), multi(), order({ id: '33333333-3333-4333-8333-333333333333', total: 85.5, delivery_status: 'acknowledged' })],
      next_cursor: null,
    })
    render(<ConfirmedOrdersWorkspace />)
    await screen.findByText('statOrders')
    const card = (label: string) => screen.getByText(label).closest('div')!.parentElement as HTMLElement
    expect(within(card('statOrders')).getByText('3')).toBeTruthy()
    expect(within(card('statPending')).getByText('2')).toBeTruthy() // the acknowledged one is not "por gestionar"
    expect(within(card('statAmount')).getByText('S/ 380.50')).toBeTruthy()
    expect(screen.queryByText('statPartial')).toBeNull()
  })

  it('"pending integration" counts only existing technical states that are not complete (unknown ones are not invented into it)', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((c, i) => `${i}${i}${i}${i}${i}${i}${i}${i}-0000-4000-8000-00000000000${i}`)
    const statuses = ['held', 'pending', 'sending', 'sent', 'failed', 'dead', 'acknowledged', 'brand_new_state']
    answer({ orders: statuses.map((delivery_status, i) => order({ id: ids[i], delivery_status })), next_cursor: null })
    render(<ConfirmedOrdersWorkspace />)
    await screen.findByText('statPending')
    const card = screen.getByText('statPending').closest('div')!.parentElement as HTMLElement
    expect(within(card).getByText('6')).toBeTruthy()
  })

  it('with more pages the cards never claim a global figure: "+" on the counts and a "loaded orders" note on the amount', async () => {
    answer({ orders: [order()], next_cursor: 'CUR' })
    render(<ConfirmedOrdersWorkspace />)
    await screen.findByText('statOrders')
    expect(screen.getAllByText('1+')).toHaveLength(2)
    expect(screen.getAllByText('statPartial')).toHaveLength(3) // every card says it only covers the loaded orders
  })

  it('an unknown delivery status falls back to the neutral "unknown" label', async () => {
    answer({ orders: [order({ delivery_status: 'brand_new_state' })], next_cursor: null })
    render(<ConfirmedOrdersWorkspace />)
    await screen.findByText('delivery.unknown')
  })

  it('feature off and missing operational role show a message instead of breaking', async () => {
    answer({ error: 'feature_disabled' }, 403)
    const first = render(<ConfirmedOrdersWorkspace />)
    await screen.findByText('disabled')
    first.unmount()
    answer({ error: 'operational_role_required' }, 403)
    render(<ConfirmedOrdersWorkspace />)
    await screen.findByText('forbidden')
  })

  it('"Load more" asks for the next page with the cursor and never repeats an order', async () => {
    const second = order({ id: '44444444-4444-4444-8444-444444444444', customer_name: 'Cliente Dos' })
    const pages = [{ orders: [order()], next_cursor: 'CUR1' }, { orders: [order(), second], next_cursor: null }]
    const f = vi.fn(async (url: string) => (/\/api\/orders\/(shalom|payments)\//.test(String(url)) ? new Response('{}', { status: 403 }) : new Response(JSON.stringify(pages.shift()))))
    vi.stubGlobal('fetch', f)
    render(<ConfirmedOrdersWorkspace />)
    fireEvent.click(await screen.findByRole('button', { name: 'loadMore' }))
    await screen.findByText('Cliente Dos')
    expect(f.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/api/orders/confirmed'))[1]).toContain('cursor=CUR1')
    expect(screen.getAllByText('Cliente Uno')).toHaveLength(1)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'loadMore' })).toBeNull())
  })

  it('PR-05B: the "En abandono" chip appears only when the server grants the list, narrows the loaded orders (loading more pages to find them) and clears with the filters', async () => {
    const second = order({ id: '44444444-4444-4444-8444-444444444444', customer_name: 'Cliente Dos' })
    const pages = [{ orders: [order()], next_cursor: 'CUR1' }, { orders: [second], next_cursor: null }]
    const f = vi.fn(async (url: string) => (String(url).includes('/api/orders/payments/') ? new Response('{}', { status: 403 }) : String(url).includes('/api/orders/shalom/abandoned') ? new Response(JSON.stringify({ order_ids: [second.id] })) : new Response(JSON.stringify(pages.shift()))))
    vi.stubGlobal('fetch', f)
    render(<ConfirmedOrdersWorkspace />)
    const chip = await screen.findByRole('button', { name: /abandonedFilter/ })
    expect(chip.getAttribute('aria-pressed')).toBe('false')
    await screen.findByText('Cliente Uno')
    fireEvent.click(chip)
    await screen.findByText('Cliente Dos')
    await waitFor(() => expect(screen.queryByText('Cliente Uno')).toBeNull())
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'clearFilters' }))
    await screen.findByText('Cliente Uno')
    expect(chip.getAttribute('aria-pressed')).toBe('false')
  })

  it('PR-05B: without access to the abandoned list (Commercial, flag OFF…) there is NO chip and the list is untouched', async () => {
    const f = vi.fn(async (url: string) => (String(url).includes('/api/orders/shalom/abandoned') ? new Response('{}', { status: 403 }) : new Response(JSON.stringify({ orders: [order()], next_cursor: null }))))
    vi.stubGlobal('fetch', f)
    render(<ConfirmedOrdersWorkspace />)
    await screen.findByText('Cliente Uno')
    await waitFor(() => expect(f.mock.calls.some(([u]) => String(u).includes('/abandoned'))).toBe(true))
    expect(screen.queryByRole('button', { name: /abandonedFilter/ })).toBeNull()
  })

  it('"Clear filters" is disabled until a filter is used, then resets the search', async () => {
    const f = answer({ orders: [order()], next_cursor: null })
    render(<ConfirmedOrdersWorkspace />)
    await screen.findByText('Cliente Uno')
    const clear = screen.getByRole('button', { name: 'clearFilters' }) as HTMLButtonElement
    expect(clear.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('searchLabel'), { target: { value: 'ana' } })
    expect(clear.disabled).toBe(false)
    await waitFor(() => expect(f.mock.calls.some(([u]) => String(u).includes('q=ana'))).toBe(true))
    fireEvent.click(clear)
    expect((screen.getByLabelText('searchLabel') as HTMLInputElement).value).toBe('')
    expect(clear.disabled).toBe(true)
  })
})

describe('ConfirmedOrdersWorkspace: no "Con saldo" filter, id search', () => {
  it('there is NO "Con saldo" chip (even when /with-balance would answer ids) and the screen never asks for it', async () => {
    const f = vi.fn(async (url: string) =>
      String(url).includes('/api/orders/payments/with-balance')
        ? new Response(JSON.stringify({ order_ids: [order().id] }))
        : String(url).includes('/api/orders/shalom/abandoned')
          ? new Response('{}', { status: 403 })
          : new Response(JSON.stringify({ orders: [order(), multi()], next_cursor: null })),
    )
    vi.stubGlobal('fetch', f)
    render(<ConfirmedOrdersWorkspace />)
    await screen.findByText('Cliente Uno')
    expect(screen.getByText('Cliente Tres')).toBeTruthy() // the whole list, not only tracked orders
    expect(screen.queryByRole('button', { name: /balanceFilter/ })).toBeNull()
    expect(screen.queryByText(/balanceFilter/)).toBeNull()
    expect(f.mock.calls.some(([u]) => String(u).includes('with-balance'))).toBe(false)
  })

  it('the search box sends a full UUID and an id prefix as q, unchanged, and "Clear filters" resets it', async () => {
    const f = answer({ orders: [order()], next_cursor: null })
    render(<ConfirmedOrdersWorkspace />)
    await screen.findByText('Cliente Uno')
    const box = screen.getByLabelText('searchLabel') as HTMLInputElement
    fireEvent.change(box, { target: { value: 'b5479c55-78d8-4507-8ba5-d9c9923d9199' } })
    await waitFor(() => expect(f.mock.calls.some(([u]) => String(u).includes('q=b5479c55-78d8-4507-8ba5-d9c9923d9199'))).toBe(true))
    fireEvent.change(box, { target: { value: 'b5479c55' } })
    await waitFor(() => expect(f.mock.calls.some(([u]) => /q=b5479c55(&|$)/.test(String(u)))).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'clearFilters' }))
    expect(box.value).toBe('')
    await waitFor(() => expect(String(f.mock.calls[f.mock.calls.length - 1][0])).not.toContain('q='))
  })
})

describe('ConfirmedOrdersWorkspace: selection and drawer', () => {
  it('opening an order marks its row selected, shows the full multi-product detail and the Open conversation link', async () => {
    answer({ orders: [multi(), order()], next_cursor: null })
    const { container } = render(<ConfirmedOrdersWorkspace />)
    await screen.findByText('Cliente Tres')
    expect(container.querySelector('[data-selected="true"]')).toBeNull()
    fireEvent.click(viewButtons()[0])
    const drawer = await screen.findByRole('dialog', { name: 'detailTitle' })
    expect(container.querySelectorAll('[data-selected="true"]')).toHaveLength(1)
    expect(viewButtons()[0].getAttribute('aria-pressed')).toBe('true')
    expect(viewButtons()[1].getAttribute('aria-pressed')).toBe('false')
    expect(within(drawer).getByText('detailProducts:{"count":2}')).toBeTruthy()
    expect(within(drawer).getByText('Producto C')).toBeTruthy()
    expect(within(drawer).getByText('Producto D')).toBeTruthy()
    expect(within(drawer).getByText('S/ 75.00')).toBeTruthy()
    expect(within(drawer).getByText('S/ 150.00')).toBeTruthy()
    expect(within(drawer).getAllByText('S/ 175.00').length).toBeGreaterThan(0)
    expect(within(drawer).getByText('shipping')).toBeTruthy()
    fireEvent.click(within(drawer).getByRole('button', { name: 'openChat' }))
    expect(push).toHaveBeenCalledWith(`/inbox?c=${CONV}`)
  })

  it('closing with X or Escape clears the visual selection', async () => {
    answer({ orders: [order()], next_cursor: null })
    const { container } = render(<ConfirmedOrdersWorkspace />)
    await screen.findByText('Cliente Uno')
    fireEvent.click(viewButtons()[0])
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'closeDetail' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(container.querySelector('[data-selected="true"]')).toBeNull()
    fireEvent.click(viewButtons()[0])
    await screen.findByRole('dialog')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(container.querySelector('[data-selected="true"]')).toBeNull()
  })

  it('an order without conversation renders normally and offers no Open conversation button', async () => {
    answer({ orders: [order({ conversation_id: null, department: null })], next_cursor: null })
    render(<ConfirmedOrdersWorkspace />)
    fireEvent.click(await screen.findByRole('button', { name: /openOrder/ }))
    const drawer = await screen.findByRole('dialog')
    expect(within(drawer).getByText('noChat')).toBeTruthy()
    expect(within(drawer).queryByRole('button', { name: 'openChat' })).toBeNull()
  })

  it('a legacy order shows its single line with no unit price (the snapshot only stores the total)', async () => {
    answer({ orders: [order()], next_cursor: null })
    render(<ConfirmedOrdersWorkspace />)
    fireEvent.click(await screen.findByRole('button', { name: /openOrder/ }))
    const drawer = await screen.findByRole('dialog')
    expect(within(drawer).getByText('Producto A')).toBeTruthy()
    expect(within(drawer).getAllByText('none').length).toBeGreaterThan(0)
  })
})
