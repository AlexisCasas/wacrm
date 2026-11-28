// QA01: protection of existing orders.
import assert from 'node:assert/strict'

import { pause } from '../lib/harness.mjs'
import {
  deriveButton, editorReady, field, logisticsAside, openDetail, openEditForm, openPanel, panelFor, price, productName, quantity, save, submitForm, toast, totalNotice, totalShown,
} from '../lib/ui.mjs'
import { cancelOrder, correctTotal, finalize, mkCatalog, mkOrder } from '../lib/world.mjs'

export const legacy = (world, extra = {}) => mkOrder(world, 'A', { label: 'LEG', total: 100, quantity: 3, ...extra })
export async function multiLine(world) {
  const a = await mkCatalog(world, 'A', 'm1')
  const b = await mkCatalog(world, 'A', 'm2')
  const items = [
    { product_name: a.name, quantity: 1, unit_price: 60, catalog_product_id: a.id },
    { product_name: b.name, quantity: 2, unit_price: 20, catalog_product_id: b.id },
    { product_name: 'Línea manual QA', quantity: 1, unit_price: 15 },
  ]
  return { ...(await mkOrder(world, 'A', { label: 'MULTI', items })), catalog: [a, b] }
}
export async function corrected(world) {
  const c = await mkCatalog(world, 'A', 'cor')
  const order = await mkOrder(world, 'A', { label: 'COR', items: [{ product_name: c.name, quantity: 1, unit_price: 100, catalog_product_id: c.id }] })
  await correctTotal(world, order, 90)
  return { ...order, catalog: [c] }
}

/** Nothing but the listed order columns changed; lines, money and corrections are untouched. */
function onlyChanged(before, after, columns) {
  for (const key of Object.keys(before.order)) {
    if (columns.includes(key)) continue
    assert.deepEqual(after.order[key], before.order[key], `order.${key} changed`)
  }
  assert.deepEqual(after.items, before.items, 'lines changed')
  assert.deepEqual(after.corrections, before.corrections, 'total corrections changed')
  assert.deepEqual(after.payments, before.payments, 'payments changed')
}

export async function register(r) {
  const world = r.world

  await r.test('01.1', { user: 'A-LOG', title: 'Guardar sin cambios (pedido sin líneas)', expected: 'No se envía nada y la base no cambia' }, async (t) => {
    const order = await t.setup(() => legacy(world))
    const before = await t.watch('order', order.orderId)
    const { page, aside } = await panelFor(t, 'A-LOG', order)
    assert.equal(await totalShown(aside), 'S/ 100.00')
    await save(aside)
    await toast(page, 'No hay cambios para guardar.')
    await pause(1000)
    assert.deepEqual(t.paymentPosts(), [])
    assert.deepEqual(await t.after('order'), before)
    return 'Aviso "No hay cambios"; cero peticiones; instantánea idéntica'
  })

  const shapes = [['a', 'sin líneas', legacy], ['b', 'total corregido', corrected], ['c', 'varias líneas', multiLine]]
  const buyerFields = [
    ['01.2', 'DNI', 'DNI', 'dni', '00000007'],
    ['01.3', 'destino', 'Destino', 'destination', 'Destino QA nuevo'],
    ['01.4', 'nombre', 'Nombre completo', 'customer_name', 'Nombre QA corregido'],
  ]
  for (const [id, human, label, column, value] of buyerFields) {
    for (const [suffix, shape, make] of shapes) {
      await r.test(`${id}${suffix}`, { user: 'A-LOG', title: `Cambiar ${human} (${shape})`, expected: `Se envía solo ${column}; líneas, total y correcciones intactos; queda auditado` }, async (t) => {
        const order = await t.setup(() => make(world))
        const before = await t.watch('order', order.orderId)
        const { page, aside } = await panelFor(t, 'A-LOG', order)
        await field(aside, label).fill(value)
        await save(aside)
        await toast(page, 'Pedido actualizado.')
        assert.deepEqual(t.paymentPosts().map((b) => [b.action, b.fields]), [['edit_order', { [column]: value }]])
        const after = await t.after('order')
        assert.equal(after.order[column], value)
        onlyChanged(before, after, [column])
        assert.equal(after.edits.length, before.edits.length + 1)
        assert.deepEqual(after.edits.at(-1).fields, [column])
        return `Enviado {${column}}; total S/ ${after.order.price.toFixed(2)} sin cambios; ${after.items.length} líneas intactas`
      })
    }
  }

  for (const [suffix, shape, make] of [['a', 'sin líneas', legacy], ['c', 'varias líneas', multiLine]]) {
    await r.test(`01.5${suffix}`, { user: 'A-LOG', title: `Agencia y departamento en el detalle (${shape})`, expected: 'Se envían solo agency y department' }, async (t) => {
      const order = await t.setup(() => make(world))
      const before = await t.watch('order', order.orderId)
      const { page, section } = await openDetail(t, 'A-LOG', order.orderId)
      const form = await openEditForm(page, section)
      await form.getByLabel('Agencia', { exact: true }).fill('Agencia QA')
      await form.getByLabel('Departamento', { exact: true }).fill('Lima')
      await submitForm(form)
      await toast(page, 'Pedido actualizado')
      assert.deepEqual(t.paymentPosts().map((b) => [b.action, b.fields]), [['edit_order', { agency: 'Agencia QA', department: 'Lima' }]])
      const after = await t.after('order')
      assert.equal(after.order.agency, 'Agencia QA')
      assert.equal(after.order.department, 'Lima')
      onlyChanged(before, after, ['agency', 'department'])
      return 'Enviados solo agency y department'
    })
  }

  await r.test('01.6', { user: 'A-LOG', title: 'Renombrar el producto de un pedido sin líneas', expected: 'Se envía product; no se crean líneas; total 100' }, async (t) => {
    const order = await t.setup(() => legacy(world))
    const before = await t.watch('order', order.orderId)
    const { page, aside } = await panelFor(t, 'A-LOG', order)
    await productName(aside).fill('Producto renombrado QA')
    assert.equal(await totalShown(aside), 'S/ 100.00')
    await save(aside)
    await toast(page, 'Pedido actualizado.')
    assert.deepEqual(t.paymentPosts().map((b) => b.fields), [{ product: 'Producto renombrado QA' }])
    const after = await t.after('order')
    assert.equal(after.items.length, 0)
    assert.equal(after.order.price, 100)
    assert.equal(after.order.product, 'Producto renombrado QA')
    onlyChanged(before, after, ['product'])
    return 'Sin líneas nuevas; total S/ 100.00'
  })

  await r.test('01.7', { user: 'A-LOG', title: 'Cambiar cantidad en el panel (pedido sin líneas)', expected: 'Aviso de total; líneas creadas; total guardado = anunciado' }, async (t) => {
    const order = await t.setup(() => legacy(world, { total: 120, quantity: 2 }))
    const before = await t.watch('order', order.orderId)
    const { page, aside } = await panelFor(t, 'A-LOG', order)
    await quantity(aside).fill('3')
    const notice = await totalNotice(aside).innerText()
    assert.match(notice, /S\/ 120\.00/)
    assert.match(notice, /S\/ 180\.00/)
    await save(aside)
    await toast(page, 'Pedido actualizado.')
    const after = await t.after('order')
    assert.equal(after.order.price, 180)
    assert.deepEqual(after.items.map((i) => [i.quantity, i.unit_price, i.item_type]), [[3, 60, 'product']])
    assert.equal(after.corrections.length, before.corrections.length + 1)
    return `Aviso mostrado; total ${before.order.price} → ${after.order.price}; 1 línea creada; corrección auditada`
  })

  await r.test('01.8', { user: 'A-LOG', title: 'Cambiar cantidad en el formulario de detalle (pedido sin líneas)', expected: 'Solo quantity; sin líneas; total 100' }, async (t) => {
    const order = await t.setup(() => legacy(world))
    const before = await t.watch('order', order.orderId)
    const { page, section } = await openDetail(t, 'A-LOG', order.orderId)
    const form = await openEditForm(page, section)
    await form.getByLabel('Cantidad', { exact: true }).fill('4')
    await submitForm(form)
    await toast(page, 'Pedido actualizado')
    assert.deepEqual(t.paymentPosts().map((b) => b.fields), [{ quantity: '4' }])
    const after = await t.after('order')
    assert.equal(after.order.quantity, 4)
    onlyChanged(before, after, ['quantity'])
    t.note('El formulario de detalle conserva el total al cambiar la cantidad; el panel lateral lo recalcula (ver 01.7).')
    return 'Cantidad 4, total S/ 100.00, sin líneas'
  })

  await r.test('01.9', { user: 'A-LOG', title: 'Cambiar una línea de un pedido con total corregido', expected: 'Aviso; la suma de líneas reemplaza la corrección; auditado' }, async (t) => {
    const order = await t.setup(() => corrected(world))
    const before = await t.watch('order', order.orderId)
    assert.equal(before.order.price, 90)
    const { page, aside } = await panelFor(t, 'A-LOG', order)
    assert.equal(await totalShown(aside), 'S/ 90.00')
    await price(aside).fill('80')
    const notice = await totalNotice(aside).innerText()
    assert.match(notice, /S\/ 90\.00/)
    assert.match(notice, /S\/ 80\.00/)
    await save(aside)
    await toast(page, 'Pedido actualizado.')
    const after = await t.after('order')
    assert.equal(after.order.price, 80)
    assert.equal(after.corrections.length, before.corrections.length + 1)
    t.note('DECISIÓN DE PRODUCTO: la corrección supervisada (90) queda reemplazada por la suma de líneas al editar una línea; el panel lo avisa.')
    return 'Total 90 → 80 anunciado y auditado'
  })

  await r.test('01.10', { user: 'A-LOG', title: 'Cambiar el precio de una de varias líneas', expected: 'Las demás líneas conservan su vínculo; corrección auditada' }, async (t) => {
    const order = await t.setup(() => multiLine(world))
    const before = await t.watch('order', order.orderId)
    const { page, aside } = await panelFor(t, 'A-LOG', order)
    await price(aside, 0).fill('55')
    await save(aside)
    await toast(page, 'Pedido actualizado.')
    const after = await t.after('order')
    assert.deepEqual(after.items.map((i) => i.catalog_product_id), before.items.map((i) => i.catalog_product_id))
    assert.deepEqual(after.items.slice(1), before.items.slice(1))
    assert.equal(after.order.price, 110)
    assert.equal(after.corrections.length, before.corrections.length + 1)
    return 'Total 115 → 110; vínculos intactos'
  })

  for (const [suffix, shape, close] of [
    ['a', 'anulado', (order) => cancelOrder(world, order)],
    ['b', 'finalizado', (order) => finalize(world, order, 100)],
  ]) {
    await r.test(`01.11${suffix}`, { user: 'A-LOG', title: `Intentar editar un pedido ${shape}`, expected: 'El servidor rechaza; sin cambios; el detalle no ofrece editar' }, async (t) => {
      const order = await t.setup(async () => {
        const o = await legacy(world, { quantity: 1 })
        await close(o)
        return o
      })
      const before = await t.watch('order', order.orderId)
      const { page, aside } = await panelFor(t, 'A-LOG', order)
      await field(aside, 'Destino').fill('No debe guardarse')
      await save(aside)
      await toast(page, 'No se pudieron guardar los cambios.')
      assert.deepEqual(await t.after('order'), before)
      const { section } = await openDetail(t, 'A-LOG', order.orderId)
      await pause(1500)
      assert.equal(await section.getByRole('button', { name: 'Editar pedido', exact: true }).count(), 0)
      t.note('El panel lateral deja escribir en un pedido cerrado y solo informa con un mensaje genérico al guardar.')
      return 'Rechazado sin cambios'
    })
  }

  await r.test('01.12', { user: 'A-LOG', title: 'Pedido histórico sin ficha financiera', expected: 'No aparece en el panel lateral (documentar)' }, async (t) => {
    const order = world.orders.O3
    const page = await t.page('A-LOG')
    const aside = await openPanel(page, order.conversationId)
    await aside.getByText('Sin pedido confirmado').waitFor({ timeout: 45_000 })
    await deriveButton(aside).waitFor({ timeout: 30_000 })
    t.note('Los pedidos anteriores a la activación de pagos se muestran como "Sin pedido confirmado" en el panel lateral.')
    return '"Sin pedido confirmado", con la opción de derivar disponible'
  })

  await r.test('01.13', { user: 'A-LOG', title: 'Dos pedidos en una conversación', expected: 'Editar el seleccionado no cambia el otro' }, async (t) => {
    const { O15a, O15b } = world.orders
    const beforeA = await t.watch('a', O15a.orderId)
    const beforeB = await t.watch('b', O15b.orderId)
    const page = await t.page('A-LOG')
    const aside = await openPanel(page, O15a.conversationId)
    await editorReady(aside, O15b)
    await aside.locator('[data-slot="select-trigger"]').first().click()
    await page.getByRole('option').filter({ hasText: O15a.product }).click()
    await editorReady(aside, O15a)
    await field(aside, 'Destino').fill('Destino del primero')
    await save(aside)
    await toast(page, 'Pedido actualizado.')
    onlyChanged(beforeA, await t.after('a'), ['destination'])
    assert.deepEqual(await t.after('b'), beforeB)
    assert.equal(await logisticsAside(page).count(), 1)
    return 'Solo cambió el pedido seleccionado'
  })
}
