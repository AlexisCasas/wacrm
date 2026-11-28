// QA03: payments, including injected failures before and after the server has saved.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { pause } from '../lib/harness.mjs'
import { field, panelFor, payInput, quantity, save, toast } from '../lib/ui.mjs'
import { cancelOrder } from '../lib/world.mjs'
import { legacy } from './qa01-orders.mjs'

const GENERIC = 'No se pudieron guardar los cambios.'
const PAYMENT_FAILURE = 'No se pudo completar el pago. El intento quedó conservado para recuperar la misma operación sin duplicarla.'
const one = (world) => legacy(world, { total: 100, quantity: 1 })
const rows = (snap) => snap.payments.map((p) => [p.amount, p.status])
const PAYMENTS_URL = '**/api/orders/payments/orders/*'

/** Fails the first request of `action`: before it leaves the browser, or after the server answered (the answer is lost). */
async function failOnce(page, action, { reachServer }) {
  let done = false
  await page.route(PAYMENTS_URL, async (route) => {
    const request = route.request()
    let body = null
    try {
      body = request.postDataJSON()
    } catch {
      body = null
    }
    if (done || request.method() !== 'POST' || body?.action !== action) return route.continue()
    done = true
    if (reachServer) await route.fetch()
    return route.abort('failed')
  })
}

export async function register(r) {
  const world = r.world

  await r.test('03.1', { user: 'A-LOG', title: 'Sin cambios ni pago', expected: 'Sin peticiones' }, async (t) => {
    const order = await t.setup(() => one(world))
    const { page, aside } = await panelFor(t, 'A-LOG', order)
    await payInput(aside).fill('')
    await save(aside)
    await toast(page, 'No hay cambios para guardar.')
    await pause(800)
    assert.deepEqual(t.paymentPosts(), [])
    return 'Cero peticiones'
  })

  await r.test('03.2', { user: 'A-LOG', title: 'Adelanto sin editar el pedido', expected: 'register + confirm; sin edit_order; saldo 60' }, async (t) => {
    const order = await t.setup(() => one(world))
    const before = await t.watch('order', order.orderId)
    const { page, aside } = await panelFor(t, 'A-LOG', order)
    await payInput(aside).fill('40')
    await save(aside)
    await toast(page, 'Pago registrado.')
    assert.deepEqual(t.paymentPosts().map((b) => b.action), ['register', 'confirm'])
    const after = await t.after('order')
    assert.deepEqual(after.order, before.order)
    assert.deepEqual(after.edits, before.edits)
    assert.deepEqual(rows(after), [[40, 'confirmed']])
    assert.deepEqual(after.financial, { paid: 40, status: 'partially_paid' })
    return 'Confirmado 40; saldo 60; pedido intacto'
  })

  await r.test('03.3', { user: 'A-LOG', title: 'Edición sin pago', expected: 'Solo edit_order; sin pagos' }, async (t) => {
    const order = await t.setup(() => one(world))
    await t.watch('order', order.orderId)
    const { page, aside } = await panelFor(t, 'A-LOG', order)
    await field(aside, 'Destino').fill('Solo edición')
    await save(aside)
    await toast(page, 'Pedido actualizado.')
    assert.deepEqual(t.paymentPosts().map((b) => b.action), ['edit_order'])
    assert.deepEqual(rows(await t.after('order')), [])
    return 'Sin pagos'
  })

  await r.test('03.4', { user: 'A-LOG', title: 'Editar y pagar', expected: 'edit_order, register, confirm sobre el total nuevo' }, async (t) => {
    const order = await t.setup(() => one(world))
    await t.watch('order', order.orderId)
    const { page, aside } = await panelFor(t, 'A-LOG', order)
    await quantity(aside).fill('2')
    await payInput(aside).fill('200')
    await save(aside)
    await toast(page, 'Pedido y pago actualizados.')
    const posts = t.paymentPosts()
    assert.deepEqual(posts.map((b) => b.action), ['edit_order', 'register', 'confirm'])
    assert.equal(posts[1].kind, 'full')
    const after = await t.after('order')
    assert.equal(after.order.price, 200)
    assert.deepEqual(rows(after), [[200, 'confirmed']])
    assert.deepEqual(after.financial, { paid: 200, status: 'paid' })
    return 'Total 200 pagado por completo'
  })

  await r.test('03.5', { user: 'A-LOG', title: 'Edición rechazada con pago (pedido anulado mientras se editaba)', expected: 'No se registra el pago' }, async (t) => {
    const order = await t.setup(() => one(world))
    const { page, aside } = await panelFor(t, 'A-LOG', order)
    await t.setup(() => cancelOrder(world, order))
    const before = await t.watch('order', order.orderId)
    await field(aside, 'Destino').fill('No debe guardarse')
    await payInput(aside).fill('10')
    await save(aside)
    await toast(page, GENERIC)
    assert.deepEqual(t.paymentPosts().map((b) => b.action), ['edit_order'])
    assert.deepEqual(await t.after('order'), before)
    return 'Rechazado; sin pago'
  })

  await r.test('03.6', { user: 'A-LOG', title: 'El servidor falla al registrar (después de editar)', expected: 'Estado parcial: pedido editado, sin pago, mensaje genérico' }, async (t) => {
    const order = await t.setup(() => one(world))
    await t.watch('order', order.orderId)
    const { page, aside } = await panelFor(t, 'A-LOG', order)
    await field(aside, 'Destino').fill('Editado antes del fallo')
    await payInput(aside).fill('11.11')
    await save(aside)
    await toast(page, PAYMENT_FAILURE)
    const after = await t.after('order')
    assert.equal(after.order.destination, 'Editado antes del fallo')
    assert.deepEqual(rows(after), [])
    t.note('ESTADO PARCIAL: el pedido quedó editado aunque el mensaje dice que no se pudieron guardar los cambios.')
    return 'Pedido editado; sin pago; mensaje genérico'
  })

  await r.test('03.7', { user: 'A-LOG', title: 'El servidor falla al confirmar', expected: 'Estado parcial: pago registrado sin confirmar; saldo igual' }, async (t) => {
    const order = await t.setup(() => one(world))
    await t.watch('order', order.orderId)
    const { page, aside } = await panelFor(t, 'A-LOG', order)
    await payInput(aside).fill('13.13')
    await save(aside)
    await toast(page, PAYMENT_FAILURE)
    const after = await t.after('order')
    assert.deepEqual(rows(after), [[13.13, 'recorded']])
    assert.deepEqual(after.financial, { paid: 0, status: 'unpaid' })
    t.note('ESTADO PARCIAL: queda un pago "registrado" que la pantalla no menciona.')
    return 'Pago registrado sin confirmar'
  })

  const retry = async (t, order, { amount, fault }) => {
    await t.watch('order', order.orderId)
    const { page, aside } = await panelFor(t, 'A-LOG', order)
    if (fault) await failOnce(page, fault.action, fault)
    await payInput(aside).fill(amount)
    await save(aside)
    await toast(page, PAYMENT_FAILURE)
    const afterFailure = await t.after('order')
    await save(aside)
    return { page, afterFailure }
  }
  const report = (t, afterFailure, after) => {
    const text = `tras el fallo: ${JSON.stringify(rows(afterFailure))}; tras reintentar: ${JSON.stringify(rows(after))}; confirmado ${after.financial.paid}`
    // one payment typed once must end as at most one record: anything else is a defect of the application, never a pass
    assert.ok(after.payments.length <= 1, `DUPLICADO al reintentar (cada intento usa una request_key nueva): ${text}`)
    return text
  }

  await r.test('03.8a', { user: 'A-LOG', title: 'Reintentar tras un fallo de confirmación', expected: 'Un solo pago' }, async (t) => {
    const order = await t.setup(() => one(world))
    const { page, afterFailure } = await retry(t, order, { amount: '13.13' })
    await toast(page, 'Pago registrado.')
    await pause(500)
    const after = await t.after('order')
    assert.deepEqual(rows(after), [[13.13, 'confirmed']])
    assert.deepEqual(after.financial, { paid: 13.13, status: 'partially_paid' })
    return report(t, afterFailure, after)
  })

  for (const [id, title, fault] of [
    ['03.8b', 'Reintentar tras perder la respuesta de "register"', { action: 'register', reachServer: true }],
    ['03.8c', 'Reintentar tras perder la respuesta de "confirm"', { action: 'confirm', reachServer: true }],
    ['03.8d', 'Reintentar tras un corte antes de enviar "register"', { action: 'register', reachServer: false }],
  ]) {
    await r.test(id, { user: 'A-LOG', title, expected: 'Un solo pago de 20 confirmado' }, async (t) => {
      const order = await t.setup(() => one(world))
      const { page, afterFailure } = await retry(t, order, { amount: '20', fault })
      await toast(page, 'Pago registrado.')
      const after = await t.after('order')
      const text = report(t, afterFailure, after)
      assert.deepEqual(rows(after), [[20, 'confirmed']])
      assert.deepEqual(after.financial, { paid: 20, status: 'partially_paid' })
      return text
    })
  }

  await r.test('03.9', { user: 'A-LOG', title: 'La misma request_key dos veces (API)', expected: 'Un solo pago' }, async (t) => {
    const order = await t.setup(() => one(world))
    await t.watch('order', order.orderId)
    const body = { action: 'register', request_key: `qa-same-${randomUUID()}`, amount: '25.00', kind: 'advance', paid_at: new Date(Date.now() - 60_000).toISOString() }
    const first = await t.api('A-LOG', 'POST', `/api/orders/payments/orders/${order.orderId}`, body)
    const second = await t.api('A-LOG', 'POST', `/api/orders/payments/orders/${order.orderId}`, body)
    assert.equal(first.status, 201, JSON.stringify(first.body))
    assert.equal(first.body.created, true)
    assert.equal(second.status, 200, JSON.stringify(second.body))
    assert.equal(second.body.created, false)
    assert.equal(second.body.payment_id, first.body.payment_id)
    assert.deepEqual(rows(await t.after('order')), [[25, 'recorded']])
    return 'Misma respuesta, un registro'
  })

  await r.test('03.10', { user: 'A-LOG', title: 'Pago mayor que el saldo (interfaz y API)', expected: 'La interfaz lo bloquea; la API no lo confirma' }, async (t) => {
    const order = await t.setup(() => one(world))
    await t.watch('order', order.orderId)
    const { page, aside } = await panelFor(t, 'A-LOG', order)
    await payInput(aside).fill('150')
    await save(aside)
    await toast(page, 'El pago no puede superar el saldo pendiente.')
    assert.deepEqual(t.paymentPosts(), [])
    const url = `/api/orders/payments/orders/${order.orderId}`
    const reg = await t.api('A-LOG', 'POST', url, { action: 'register', request_key: `qa-over-${randomUUID()}`, amount: '150.00', kind: 'advance', paid_at: new Date(Date.now() - 60_000).toISOString() })
    assert.ok(reg.status === 201 || (reg.status >= 400 && reg.status < 500), `register over balance: ${reg.status} ${JSON.stringify(reg.body)}`)
    if (reg.status === 201) {
      const confirm = await t.api('A-LOG', 'POST', url, { action: 'confirm', payment_id: reg.body.payment_id, expected_version: reg.body.row_version })
      assert.equal(confirm.status, 409, JSON.stringify(confirm.body))
      assert.equal(confirm.body.error, 'exceeds_balance')
      t.note('La API admite registrar un pago mayor que el saldo; la confirmación es la que lo rechaza para Logística.')
    }
    assert.deepEqual((await t.after('order')).financial, { paid: 0, status: 'unpaid' })
    return 'Bloqueado en pantalla; sin importe confirmado'
  })

  await r.test('03.11', { user: 'A-LOG', title: 'Total, confirmado, saldo e historial de los pedidos sembrados', expected: 'O9 40/60 · O10 0/100 · O11 100/0 · O12 0/100' }, async (t) => {
    const expected = { O9: [100, 40, 60, ['confirmed']], O10: [100, 0, 100, ['recorded']], O11: [100, 100, 0, ['confirmed']], O12: [100, 0, 100, ['rejected', 'voided']] }
    const seen = []
    for (const [key, [total, paid, pending, statuses]] of Object.entries(expected)) {
      const res = await t.api('A-LOG', 'GET', `/api/orders/payments/orders/${world.orders[key].orderId}`)
      assert.equal(res.status, 200, key)
      assert.deepEqual([res.body.total, res.body.paid_confirmed, res.body.pending_balance], [total, paid, pending], key)
      assert.deepEqual(res.body.payments.map((p) => p.status).sort(), statuses, key)
      seen.push(`${key} ${paid}/${pending}`)
    }
    return seen.join(' · ')
  })

  // ---- reject, void and recovery, through the app's endpoint with real sessions ----
  const endpoint = (order) => `/api/orders/payments/orders/${order.orderId}`
  const registerAs = async (t, order, amount) => {
    const res = await t.api('A-LOG', 'POST', endpoint(order), {
      action: 'register', request_key: `qa-api-${randomUUID()}`, amount, kind: 'advance', paid_at: new Date(Date.now() - 60_000).toISOString(),
    })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    return res.body
  }
  const act = (t, user, order, action, payment, extra = {}) =>
    t.api(user, 'POST', endpoint(order), { action, payment_id: payment.payment_id, ...extra })

  await r.test('03.12', { user: 'A-LOG', title: 'Rechazar un pago registrado', expected: 'rejected; saldo intacto; no se puede confirmar después' }, async (t) => {
    const order = await t.setup(() => one(world))
    await t.watch('order', order.orderId)
    const payment = await registerAs(t, order, '30.00')
    const rejected = await act(t, 'A-LOG', order, 'reject', payment, { reason: 'comprobante ilegible (QA)' })
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body))
    const confirm = await act(t, 'A-LOG', order, 'confirm', payment)
    assert.equal(confirm.status, 409, JSON.stringify(confirm.body))
    const after = await t.after('order')
    assert.deepEqual(rows(after), [[30, 'rejected']])
    assert.deepEqual(after.financial, { paid: 0, status: 'unpaid' })
    return 'Rechazado; confirmado 0'
  })

  await r.test('03.13', { user: 'A-LOG / A-SUP', title: 'Anular un pago confirmado', expected: 'Logística 403; Supervisor anula; saldo restituido una sola vez' }, async (t) => {
    const order = await t.setup(() => one(world))
    await t.watch('order', order.orderId)
    const payment = await registerAs(t, order, '30.00')
    assert.equal((await act(t, 'A-LOG', order, 'confirm', payment)).status, 200)
    const denied = await act(t, 'A-LOG', order, 'void', payment, { reason: 'QA' })
    assert.equal(denied.status, 403, JSON.stringify(denied.body))
    assert.deepEqual((await t.after('order')).financial, { paid: 30, status: 'partially_paid' })
    const voided = await act(t, 'A-SUP', order, 'void', payment, { reason: 'error de registro (QA)' })
    assert.equal(voided.status, 200, JSON.stringify(voided.body))
    const again = await act(t, 'A-SUP', order, 'void', payment, { reason: 'segundo intento (QA)' })
    assert.ok([200, 409].includes(again.status), JSON.stringify(again.body))
    const after = await t.after('order')
    assert.deepEqual(rows(after), [[30, 'voided']])
    assert.deepEqual(after.financial, { paid: 0, status: 'unpaid' })
    return `Anulado; segundo intento ${again.status} sin efecto`
  })

  await r.test('03.14', { user: 'A-LOG', title: 'Recuperar un pago registrado sin confirmar, sin duplicarlo', expected: 'Confirmar el mismo registro (dos veces) deja un solo pago de 20' }, async (t) => {
    const order = await t.setup(() => one(world))
    await t.watch('order', order.orderId)
    const { page, aside } = await panelFor(t, 'A-LOG', order)
    await failOnce(page, 'confirm', { reachServer: false })
    await payInput(aside).fill('20')
    await save(aside)
    await toast(page, GENERIC)
    assert.deepEqual(rows(await t.after('order')), [[20, 'recorded']])
    const panel = await t.api('A-LOG', 'GET', endpoint(order))
    assert.equal(panel.status, 200)
    const pending = { payment_id: panel.body.payments[0].id }
    const first = await act(t, 'A-LOG', order, 'confirm', pending)
    assert.equal(first.status, 200, JSON.stringify(first.body))
    const second = await act(t, 'A-LOG', order, 'confirm', pending)
    assert.ok([200, 409].includes(second.status), JSON.stringify(second.body))
    const after = await t.after('order')
    assert.deepEqual(rows(after), [[20, 'confirmed']])
    assert.deepEqual(after.financial, { paid: 20, status: 'partially_paid' })
    return `Recuperado por la API del mismo registro; segunda confirmación ${second.status} sin efecto`
  })
}

/** Best-effort wait: used where either of two outcomes is possible and the assertion comes afterwards. */
async function until2(condition, ms = 20_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await condition().catch(() => false)) return
    await pause(300)
  }
}
