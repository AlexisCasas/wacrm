// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

// Regression: the order detail drawer (and the voucher upload inside it) must always belong to the order the operator is looking at.
// Field case: order A (S/95) was opened, the list was then searched for order B (S/149); the drawer kept showing A and "Subir voucher"
// attached B's voucher to A.
const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() } }))
vi.mock('next-intl', () => {
  const t = Object.assign((key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key), { has: () => true })
  return { useLocale: () => 'es', useTranslations: () => t }
})

import { ConfirmedOrdersWorkspace } from './confirmed-orders-workspace'

const A = 'b5479c55-78d8-4507-8ba5-d9c9923d9199'
const B = 'aa26b25e-9ab3-4e59-b8d4-5d6ff2309353'
const order = (id: string, name: string, total: number, destination: string) => ({
  id,
  confirmed_at: '2026-11-19T14:21:14.092592+00:00',
  customer_name: name,
  seller_name: 'Lindey',
  order_status: 'Pedido confirmado',
  delivery_status: 'acknowledged',
  agency: 'Shalom',
  destination,
  department: null,
  conversation_id: null,
  total,
  quantity: 1,
  product_summary: 'Producto',
  lines: [{ line_number: 1, product_name: 'Producto', quantity: 1, unit_price: null, subtotal: total }],
  is_multiproduct: false,
})
const ORDER_A = order(A, 'Cliente Sullana', 95, 'Piura, Sullana SANTA ROSA')
const ORDER_B = order(B, 'Cliente Chincha', 149, 'Ica, Chincha')

const panel = { order: {}, logistics: { status: 'pending_voucher', version: 0, evidence_document_id: null }, vouchers: [], evidence: null, dispatches: [], events: [] }

function stubServer() {
  const uploads: string[] = []
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (u.startsWith('/api/orders/confirmed?')) {
      const q = new URL('http://x' + u).searchParams.get('q')
      const orders = q === 'aa26b25e' ? [ORDER_B] : q === 'b5479c55' ? [ORDER_A] : [ORDER_A, ORDER_B]
      return new Response(JSON.stringify({ orders, next_cursor: null }))
    }
    if (u.startsWith('/api/orders/logistics/orders/')) return new Response(JSON.stringify(panel))
    if (u === '/api/orders/logistics/documents' && init?.method === 'POST') {
      const orderId = String((init.body as FormData).get('order_id'))
      uploads.push(orderId)
      return new Response(JSON.stringify({ error: 'unsupported_in_test' }), { status: 400 })
    }
    return new Response('{}', { status: 403 })
  })
  vi.stubGlobal('fetch', f)
  return { f, uploads }
}

const drawer = () => screen.getByRole('dialog', { name: 'detailTitle' })
const search = async (text: string) => {
  fireEvent.change(screen.getByLabelText('searchLabel'), { target: { value: text } })
  await waitFor(() => expect(screen.getAllByRole('button', { name: /openOrder/ })).toHaveLength(1), { timeout: 3000 })
}
const upload = async () => {
  const input = await screen.findByLabelText('uploadVoucher')
  fireEvent.change(input, { target: { files: [new File(['%PDF'], 'guia.pdf', { type: 'application/pdf' })] } })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  push.mockReset()
})

describe('confirmed orders: the detail drawer never keeps a stale order', () => {
  it('open A, search B: the drawer does NOT keep showing A (it closes because A left the list)', async () => {
    stubServer()
    render(<ConfirmedOrdersWorkspace />)
    await screen.findByText('Cliente Sullana')
    fireEvent.click(screen.getAllByRole('button', { name: /openOrder/ })[0])
    expect(within(drawer()).getByText('Cliente Sullana')).toBeTruthy()

    await search('aa26b25e')
    await screen.findByText('Cliente Chincha')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'detailTitle' })).toBeNull())
    expect(screen.queryByText('Cliente Sullana')).toBeNull()
  })

  it('field case: open A, search B and DO NOT open B: there is no stale upload control left that could attach a voucher to A', async () => {
    const { uploads } = stubServer()
    render(<ConfirmedOrdersWorkspace />)
    await screen.findByText('Cliente Sullana')
    fireEvent.click(screen.getAllByRole('button', { name: /openOrder/ })[0])
    await screen.findByLabelText('uploadVoucher')

    await search('aa26b25e')
    await screen.findByText('Cliente Chincha')
    await waitFor(() => expect(screen.queryByLabelText('uploadVoucher')).toBeNull())
    expect(uploads).toEqual([])
  })

  it('open A, search B, open B: the drawer shows B (total and destination), nothing of A', async () => {
    stubServer()
    render(<ConfirmedOrdersWorkspace />)
    await screen.findByText('Cliente Sullana')
    fireEvent.click(screen.getAllByRole('button', { name: /openOrder/ })[0])

    await search('aa26b25e')
    await screen.findByText('Cliente Chincha')
    fireEvent.click(screen.getByRole('button', { name: /openOrder/ }))

    const d = within(drawer())
    expect(d.getByText('Cliente Chincha')).toBeTruthy()
    expect(d.getAllByText('S/ 149.00').length).toBeGreaterThan(0)
    expect(d.queryByText('S/ 95.00')).toBeNull()
    expect(d.queryByText(/Sullana/)).toBeNull()
  })

  it('open A, search B, open B, upload a voucher: the request carries B (never A)', async () => {
    const { f, uploads } = stubServer()
    render(<ConfirmedOrdersWorkspace />)
    await screen.findByText('Cliente Sullana')
    fireEvent.click(screen.getAllByRole('button', { name: /openOrder/ })[0])
    await screen.findByLabelText('uploadVoucher')
    expect(f.mock.calls.some(([u]) => String(u).endsWith(`/api/orders/logistics/orders/${A}`))).toBe(true)

    await search('aa26b25e')
    await screen.findByText('Cliente Chincha')
    fireEvent.click(screen.getByRole('button', { name: /openOrder/ }))
    await waitFor(() => expect(f.mock.calls.some(([u]) => String(u).endsWith(`/api/orders/logistics/orders/${B}`))).toBe(true))
    await upload()
    await waitFor(() => expect(uploads).toHaveLength(1))
    expect(uploads).toEqual([B])
  })

  it('with the list showing both orders, switching A -> B swaps the drawer and the upload follows', async () => {
    const { uploads } = stubServer()
    render(<ConfirmedOrdersWorkspace />)
    await screen.findByText('Cliente Sullana')
    const buttons = screen.getAllByRole('button', { name: /openOrder/ })
    fireEvent.click(buttons[0])
    expect(within(drawer()).getByText('Cliente Sullana')).toBeTruthy()
    fireEvent.click(buttons[1])
    expect(within(drawer()).getByText('Cliente Chincha')).toBeTruthy()
    expect(within(drawer()).queryByText('Cliente Sullana')).toBeNull()
    await upload()
    await waitFor(() => expect(uploads).toEqual([B]))
  })

  it('an order that is still in the list after a search keeps its drawer open (no needless close)', async () => {
    stubServer()
    render(<ConfirmedOrdersWorkspace />)
    await screen.findByText('Cliente Sullana')
    fireEvent.click(screen.getAllByRole('button', { name: /openOrder/ })[0])
    await search('b5479c55')
    expect(within(drawer()).getByText('Cliente Sullana')).toBeTruthy()
  })
})
