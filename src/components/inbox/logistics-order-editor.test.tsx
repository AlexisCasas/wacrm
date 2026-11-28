// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({ ok: vi.fn(), err: vi.fn(), info: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: h.ok, error: h.err, info: h.info } }))

import { LogisticsOrderEditor } from './logistics-order-editor'

const ORDER = '11111111-1111-4111-8111-111111111111'
const CATALOG = '22222222-2222-4222-8222-222222222222'

type Item = { line_number: number; product_name: string; quantity: number; unit_price: number; catalog_product_id: string | null; item_type: 'product' | 'accessory' }
const panelData = (over: { total?: number; paid?: number; product?: string; quantity?: number; items?: Item[] } = {}) => {
  const total = over.total ?? 100
  const paid = over.paid ?? 0
  return {
    tracked: true, total, paid_confirmed: paid, pending_balance: Math.max(total - paid, 0),
    order: { customer_name: 'Ana', dni: null, phone: '51900000001', product: over.product ?? 'Kit', quantity: over.quantity ?? 1, order_description: null, agency: 'Shalom', destination: 'Lima', department: null },
    items: over.items ?? [],
  }
}
/** An order that already has lines, whose total was corrected by a supervisor (it is NOT the sum of the lines). */
const corrected = () => panelData({
  total: 90, product: '1 x Kit', quantity: 1,
  items: [{ line_number: 1, product_name: 'Kit', quantity: 1, unit_price: 100, catalog_product_id: CATALOG, item_type: 'product' }],
})

type Body = Record<string, unknown>
const serve = (data: unknown, edit: { status?: number; body?: unknown } = {}) => {
  const posts: Body[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (!init || init.method !== 'POST') return new Response(JSON.stringify(data), { status: 200 })
    const body = JSON.parse(String(init.body)) as Body
    posts.push(body)
    if (body.action === 'edit_order') return new Response(JSON.stringify(edit.body ?? { changed: true }), { status: edit.status ?? 200 })
    if (body.action === 'register') return new Response(JSON.stringify({ payment_id: 'p1', row_version: 1, status: 'recorded', created: true }), { status: 201 })
    return new Response('{}', { status: 200 })
  }))
  return posts
}
const open = async () => {
  render(<LogisticsOrderEditor orderId={ORDER} />)
  await waitFor(() => expect(screen.getByDisplayValue('Ana')).toBeTruthy())
}
const type = (current: string, value: string) => fireEvent.change(screen.getByDisplayValue(current), { target: { value } })
const pay = (value: string) => fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value } })
const save = () => fireEvent.click(screen.getByRole('button', { name: /Guardar/ }))
const totalShown = () => screen.getByText('Total').nextElementSibling?.textContent

beforeEach(() => { h.ok.mockReset(); h.err.mockReset(); h.info.mockReset(); window.sessionStorage.clear() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('LogisticsOrderEditor: saving never rewrites what the person did not change', () => {
  it('nothing changed -> nothing is sent', async () => {
    const posts = serve(panelData())
    await open()
    save()
    await waitFor(() => expect(h.info).toHaveBeenCalled())
    expect(posts).toEqual([])
  })

  it('an order without lines: changing the DNI sends only the DNI (no lines are invented)', async () => {
    const posts = serve(panelData())
    await open()
    fireEvent.change(screen.getByText('DNI').parentElement!.querySelector('input')!, { target: { value: '00000000' } })
    save()
    await waitFor(() => expect(h.ok).toHaveBeenCalled())
    expect(posts).toEqual([{ action: 'edit_order', fields: { dni: '00000000' }, reason: 'Actualización desde panel de Logística' }])
  })

  it('a total that does not divide by the quantity is shown and kept as it is', async () => {
    const posts = serve(panelData({ total: 100, quantity: 3 }))
    await open()
    expect(totalShown()).toBe('S/ 100.00')
    type('Lima', 'Cusco')
    save()
    await waitFor(() => expect(h.ok).toHaveBeenCalled())
    expect(posts.map((p) => p.fields)).toEqual([{ destination: 'Cusco' }])
  })

  it('an order with a corrected total: editing the buyer data does not send the lines back (the correction survives)', async () => {
    const posts = serve(corrected())
    await open()
    expect(totalShown()).toBe('S/ 90.00')
    type('Ana', 'Ana María')
    save()
    await waitFor(() => expect(h.ok).toHaveBeenCalled())
    expect(posts.map((p) => p.fields)).toEqual([{ customer_name: 'Ana María' }])
  })

  it('an order without lines: renaming the product keeps it without lines and keeps its total', async () => {
    const posts = serve(panelData({ total: 100, quantity: 3 }))
    await open()
    type('Kit', 'Kit grande')
    expect(totalShown()).toBe('S/ 100.00')
    save()
    await waitFor(() => expect(h.ok).toHaveBeenCalled())
    expect(posts.map((p) => p.fields)).toEqual([{ product: 'Kit grande' }])
  })

  it('an order without lines: a real change of quantity sends the lines, and the new total is announced first', async () => {
    const posts = serve(panelData({ total: 100, quantity: 1 }))
    await open()
    type('1', '2')
    expect(totalShown()).toBe('S/ 200.00')
    expect(screen.getByRole('status').textContent).toContain('S/ 100.00')
    expect(screen.getByRole('status').textContent).toContain('S/ 200.00')
    save()
    await waitFor(() => expect(h.ok).toHaveBeenCalled())
    expect(posts.map((p) => p.fields)).toEqual([{ items: [{ product_name: 'Kit', quantity: '2', unit_price: '100.00', item_type: 'product' }] }])
  })

  it('adding an accessory sends both lines, each with its type', async () => {
    const posts = serve(panelData())
    await open()
    fireEvent.click(screen.getByRole('button', { name: /Accesorio/ }))
    const name = screen.getByPlaceholderText('Nombre del accesorio')
    fireEvent.change(name, { target: { value: 'Funda' } })
    const inputs = name.parentElement!.parentElement!.querySelectorAll('input')
    fireEvent.change(inputs[2], { target: { value: '10' } })
    expect(totalShown()).toBe('S/ 110.00')
    save()
    await waitFor(() => expect(h.ok).toHaveBeenCalled())
    expect(posts.map((p) => p.fields)).toEqual([{ items: [
      { product_name: 'Kit', quantity: '1', unit_price: '100.00', item_type: 'product' },
      { product_name: 'Funda', quantity: '1', unit_price: '10.00', item_type: 'accessory' },
    ] }])
  })

  it('changing a price of an order with lines keeps the catalog link', async () => {
    const posts = serve(corrected())
    await open()
    type('100.00', '95')
    save()
    await waitFor(() => expect(h.ok).toHaveBeenCalled())
    expect(posts.map((p) => p.fields)).toEqual([{ items: [{ product_name: 'Kit', quantity: '1', unit_price: '95.00', item_type: 'product', catalog_product_id: CATALOG }] }])
  })

  it('renaming a line of an order with lines drops its catalogue link (the name was typed by hand)', async () => {
    const posts = serve(corrected())
    await open()
    type('Kit', 'Otro')
    save()
    await waitFor(() => expect(h.ok).toHaveBeenCalled())
    expect(posts.map((p) => p.fields)).toEqual([{ items: [{ product_name: 'Otro', quantity: '1', unit_price: '100.00', item_type: 'product' }] }])
  })

  it('a catalogue product that is no longer active: the person is told what to do and no payment is registered', async () => {
    const posts = serve(corrected(), { status: 400, body: { error: 'invalid_catalog_product' } })
    await open()
    type('100.00', '95')
    pay('5')
    save()
    await waitFor(() => expect(h.err).toHaveBeenCalledWith(expect.stringContaining('catálogo activo')))
    expect(posts.map((p) => p.action)).toEqual(['edit_order'])
  })

  it('emptying a required field blocks the save', async () => {
    const posts = serve(panelData())
    await open()
    type('Lima', '  ')
    save()
    await waitFor(() => expect(h.err).toHaveBeenCalled())
    expect(posts).toEqual([])
  })

  it('only a payment: the order is not edited; the payment is registered and confirmed', async () => {
    const posts = serve(panelData({ total: 100, quantity: 3, paid: 40 }))
    await open()
    pay('60')
    save()
    await waitFor(() => expect(h.ok).toHaveBeenCalled())
    expect(posts.map((p) => p.action)).toEqual(['register', 'confirm'])
    expect(posts[0]).toMatchObject({ amount: '60.00', kind: 'balance' })
  })

  it('a change and a payment: edit first, then the payment against the total the server answered', async () => {
    const posts = serve(panelData({ total: 100 }), { body: { changed: true, total: 200, pending_balance: 200 } })
    await open()
    type('1', '2')
    pay('200')
    save()
    await waitFor(() => expect(h.ok).toHaveBeenCalled())
    expect(posts.map((p) => p.action)).toEqual(['edit_order', 'register', 'confirm'])
    expect(posts[1]).toMatchObject({ amount: '200.00', kind: 'full' })
  })



  it('reuses the same request_key and payload when the register response is lost', async () => {
    const posts: Body[] = []
    let firstRegister = true
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init || init.method !== 'POST') return new Response(JSON.stringify(panelData({ total: 100 })), { status: 200 })
      const body = JSON.parse(String(init.body)) as Body
      posts.push(body)
      if (body.action === 'register') {
        if (firstRegister) {
          firstRegister = false
          throw new TypeError('network response lost')
        }
        return new Response(JSON.stringify({ payment_id: 'p1', row_version: 1, status: 'recorded', created: false }), { status: 200 })
      }
      if (body.action === 'confirm') return new Response(JSON.stringify({ changed: true, status: 'confirmed' }), { status: 200 })
      return new Response('{}', { status: 200 })
    }))
    await open()
    pay('20')
    save()
    await waitFor(() => expect(h.err).toHaveBeenCalled())
    save()
    await waitFor(() => expect(h.ok).toHaveBeenCalled())
    const registers = posts.filter((p) => p.action === 'register')
    expect(registers).toHaveLength(2)
    expect(registers[1].request_key).toBe(registers[0].request_key)
    expect(registers[1].amount).toBe(registers[0].amount)
    expect(registers[1].kind).toBe(registers[0].kind)
    expect(registers[1].paid_at).toBe(registers[0].paid_at)
    expect(posts.filter((p) => p.action === 'confirm')).toHaveLength(1)
  })

  it('reconciles a lost confirm response without confirming or registering a second payment', async () => {
    const posts: Body[] = []
    let confirmed = false
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init || init.method !== 'POST') return new Response(JSON.stringify(panelData({ total: 100 })), { status: 200 })
      const body = JSON.parse(String(init.body)) as Body
      posts.push(body)
      if (body.action === 'register') {
        return new Response(JSON.stringify({
          payment_id: 'p1',
          row_version: confirmed ? 2 : 1,
          status: confirmed ? 'confirmed' : 'recorded',
          created: !confirmed,
        }), { status: confirmed ? 200 : 201 })
      }
      if (body.action === 'confirm') {
        confirmed = true
        throw new TypeError('confirm response lost')
      }
      return new Response('{}', { status: 200 })
    }))
    await open()
    pay('20')
    save()
    await waitFor(() => expect(h.err).toHaveBeenCalled())
    save()
    await waitFor(() => expect(h.ok).toHaveBeenCalled())
    const registers = posts.filter((p) => p.action === 'register')
    expect(registers).toHaveLength(2)
    expect(registers[1].request_key).toBe(registers[0].request_key)
    expect(registers[1].paid_at).toBe(registers[0].paid_at)
    expect(posts.filter((p) => p.action === 'confirm')).toHaveLength(1)
  })

  it('locks the amount while an uncertain attempt is unresolved, then allows a new legitimate payment with a new key', async () => {
    const posts: Body[] = []
    let registerCount = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init || init.method !== 'POST') return new Response(JSON.stringify(panelData({ total: 100 })), { status: 200 })
      const body = JSON.parse(String(init.body)) as Body
      posts.push(body)
      if (body.action === 'register') {
        registerCount += 1
        if (registerCount === 1) throw new TypeError('network response lost')
        if (registerCount === 2) return new Response(JSON.stringify({ payment_id: 'p1', row_version: 2, status: 'confirmed', created: false }), { status: 200 })
        return new Response(JSON.stringify({ payment_id: 'p2', row_version: 1, status: 'recorded', created: true }), { status: 201 })
      }
      return new Response('{}', { status: 200 })
    }))
    await open()
    pay('20')
    save()
    await waitFor(() => expect(h.err).toHaveBeenCalled())
    expect((screen.getByPlaceholderText('0.00') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByPlaceholderText('0.00') as HTMLInputElement).value).toBe('20.00')
    save()
    await waitFor(() => expect(h.ok).toHaveBeenCalledTimes(1))
    expect((screen.getByPlaceholderText('0.00') as HTMLInputElement).disabled).toBe(false)
    pay('30')
    save()
    await waitFor(() => expect(h.ok).toHaveBeenCalledTimes(2))
    const registers = posts.filter((p) => p.action === 'register')
    expect(registers.map((p) => p.amount)).toEqual(['20.00', '20.00', '30.00'])
    expect(registers[1].request_key).toBe(registers[0].request_key)
    expect(registers[2].request_key).not.toBe(registers[0].request_key)
  })

  it('recovers the same payment attempt after the editor is unmounted and mounted again', async () => {
    const posts: Body[] = []
    let registerCount = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init || init.method !== 'POST') return new Response(JSON.stringify(panelData({ total: 100 })), { status: 200 })
      const body = JSON.parse(String(init.body)) as Body
      posts.push(body)
      if (body.action === 'register') {
        registerCount += 1
        if (registerCount === 1) throw new TypeError('response lost after server commit')
        return new Response(JSON.stringify({ payment_id: 'p1', row_version: 2, status: 'confirmed', created: false }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }))

    await open()
    pay('20')
    save()
    await waitFor(() => expect(h.err).toHaveBeenCalled())
    const firstKey = posts.find((p) => p.action === 'register')?.request_key

    cleanup()
    render(<LogisticsOrderEditor orderId={ORDER} />)
    await waitFor(() => expect((screen.getByPlaceholderText('0.00') as HTMLInputElement).value).toBe('20.00'))
    expect((screen.getByPlaceholderText('0.00') as HTMLInputElement).disabled).toBe(true)
    save()
    await waitFor(() => expect(h.ok).toHaveBeenCalled())
    const registers = posts.filter((p) => p.action === 'register')
    expect(registers).toHaveLength(2)
    expect(registers[1].request_key).toBe(firstKey)
    expect(posts.filter((p) => p.action === 'confirm')).toHaveLength(0)
  })

  it('keeps separate pending attempts when switching between two orders in the same conversation', async () => {
    const otherOrder = '33333333-3333-4333-8333-333333333333'
    const posts: Array<Body & { orderId: string }> = []
    let firstOrderRegisterCount = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const orderId = url.split('/').filter(Boolean).pop() ?? ORDER
      if (!init || init.method !== 'POST') return new Response(JSON.stringify(panelData({ total: 100 })), { status: 200 })
      const body = JSON.parse(String(init.body)) as Body
      posts.push({ ...body, orderId })
      if (body.action === 'register' && orderId === ORDER) {
        firstOrderRegisterCount += 1
        if (firstOrderRegisterCount === 1) throw new TypeError('response lost after commit')
        return new Response(JSON.stringify({ payment_id: 'p1', row_version: 2, status: 'confirmed', created: false }), { status: 200 })
      }
      if (body.action === 'register') return new Response(JSON.stringify({ payment_id: 'p2', row_version: 1, status: 'recorded', created: true }), { status: 201 })
      return new Response('{}', { status: 200 })
    }))

    const view = render(<LogisticsOrderEditor orderId={ORDER} />)
    await waitFor(() => expect(screen.getByDisplayValue('Ana')).toBeTruthy())
    pay('20')
    save()
    await waitFor(() => expect(h.err).toHaveBeenCalled())
    const firstKey = posts.find((p) => p.action === 'register' && p.orderId === ORDER)?.request_key

    view.rerender(<LogisticsOrderEditor orderId={otherOrder} />)
    await waitFor(() => expect(screen.getByDisplayValue('Ana')).toBeTruthy())
    expect((screen.getByPlaceholderText('0.00') as HTMLInputElement).value).toBe('')
    pay('20')
    save()
    await waitFor(() => expect(h.ok).toHaveBeenCalledTimes(1))
    const otherKey = posts.find((p) => p.action === 'register' && p.orderId === otherOrder)?.request_key
    expect(otherKey).toBeTruthy()
    expect(otherKey).not.toBe(firstKey)

    view.rerender(<LogisticsOrderEditor orderId={ORDER} />)
    await waitFor(() => expect((screen.getByPlaceholderText('0.00') as HTMLInputElement).value).toBe('20.00'))
    save()
    await waitFor(() => expect(h.ok).toHaveBeenCalledTimes(2))
    const firstOrderRegisters = posts.filter((p) => p.action === 'register' && p.orderId === ORDER)
    expect(firstOrderRegisters).toHaveLength(2)
    expect(firstOrderRegisters[1].request_key).toBe(firstKey)
  })

  it('does not repeat a completed order edit when recovering an uncertain payment after remount', async () => {
    const posts: Body[] = []
    let registerCount = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init || init.method !== 'POST') return new Response(JSON.stringify(panelData({ total: 100 })), { status: 200 })
      const body = JSON.parse(String(init.body)) as Body
      posts.push(body)
      if (body.action === 'edit_order') return new Response(JSON.stringify({ changed: true, total: 100, pending_balance: 100 }), { status: 200 })
      if (body.action === 'register') {
        registerCount += 1
        if (registerCount === 1) throw new TypeError('register response lost')
        return new Response(JSON.stringify({ payment_id: 'p1', row_version: 2, status: 'confirmed', created: false }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }))

    await open()
    type('Ana', 'Ana María')
    pay('20')
    save()
    await waitFor(() => expect(h.err).toHaveBeenCalled())
    const firstEdit = posts.find((p) => p.action === 'edit_order')
    const firstRegister = posts.find((p) => p.action === 'register')
    cleanup()
    render(<LogisticsOrderEditor orderId={ORDER} />)
    await waitFor(() => expect((screen.getByPlaceholderText('0.00') as HTMLInputElement).value).toBe('20.00'))
    save()
    await waitFor(() => expect(h.ok).toHaveBeenCalled())
    const edits = posts.filter((p) => p.action === 'edit_order')
    const registers = posts.filter((p) => p.action === 'register')
    expect(edits).toHaveLength(1)
    expect(edits[0].fields).toEqual(firstEdit?.fields)
    expect(registers[1].request_key).toBe(firstRegister?.request_key)
    expect(registers[1].amount).toBe(firstRegister?.amount)
  })

  it('releases a terminally rejected attempt so a later legitimate payment gets a new key', async () => {
    const posts: Body[] = []
    let registerCount = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init || init.method !== 'POST') return new Response(JSON.stringify(panelData({ total: 100 })), { status: 200 })
      const body = JSON.parse(String(init.body)) as Body
      posts.push(body)
      if (body.action === 'register') {
        registerCount += 1
        return registerCount === 1
          ? new Response(JSON.stringify({ payment_id: 'p1', row_version: 2, status: 'rejected', created: false }), { status: 200 })
          : new Response(JSON.stringify({ payment_id: 'p2', row_version: 1, status: 'recorded', created: true }), { status: 201 })
      }
      return new Response('{}', { status: 200 })
    }))

    await open()
    pay('20')
    save()
    await waitFor(() => expect(h.err).toHaveBeenCalled())
    expect((screen.getByPlaceholderText('0.00') as HTMLInputElement).disabled).toBe(false)
    pay('30')
    save()
    await waitFor(() => expect(h.ok).toHaveBeenCalled())
    const registers = posts.filter((p) => p.action === 'register')
    expect(registers).toHaveLength(2)
    expect(registers[0].request_key).not.toBe(registers[1].request_key)
    expect(registers.map((p) => p.amount)).toEqual(['20.00', '30.00'])
  })

  it('when the edit is refused no payment is registered', async () => {
    const posts = serve(panelData(), { status: 409, body: { error: 'order_closed' } })
    await open()
    type('Lima', 'Ica')
    pay('10')
    save()
    await waitFor(() => expect(h.err).toHaveBeenCalled())
    expect(posts.map((p) => p.action)).toEqual(['edit_order'])
  })
})
