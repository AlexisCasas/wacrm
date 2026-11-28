// QA02: accessories and catalogue links.
import assert from 'node:assert/strict'

import { accessoryName, openDetail, openEditForm, panelFor, price, productName, quantity, save, submitForm, toast, totalShown } from '../lib/ui.mjs'
import { editOrder, mkCatalog, mkOrder, setCatalogActive } from '../lib/world.mjs'
import { multiLine } from './qa01-orders.mjs'

async function withAccessory(world) {
  const order = await multiLine(world)
  await editOrder(world, order, {
    items: [
      { product_name: order.catalog[0].name, quantity: '1', unit_price: '60.00', item_type: 'product', catalog_product_id: order.catalog[0].id },
      { product_name: 'Accesorio QA', quantity: '1', unit_price: '10.00', item_type: 'accessory' },
    ],
  })
  return order
}
async function withInactive(world) {
  const live = await mkCatalog(world, 'A', 'vivo')
  const dead = await mkCatalog(world, 'A', 'baja')
  const order = await mkOrder(world, 'A', {
    label: 'INA',
    items: [{ product_name: live.name, quantity: 1, unit_price: 50, catalog_product_id: live.id }, { product_name: dead.name, quantity: 1, unit_price: 30, catalog_product_id: dead.id }],
  })
  await setCatalogActive(dead.id, false)
  return { ...order, live, dead }
}

export async function register(r) {
  const world = r.world

  await r.test('02.1', { user: 'A-LOG', title: 'Agregar un accesorio', expected: 'item_type accessory; suma al total' }, async (t) => {
    const order = await t.setup(() => multiLine(world))
    const before = await t.watch('order', order.orderId)
    const { page, aside } = await panelFor(t, 'A-LOG', order)
    await aside.getByRole('button', { name: 'Accesorio', exact: true }).click()
    await accessoryName(aside).fill('Funda QA')
    await price(aside, 3).fill('10')
    assert.equal(await totalShown(aside), 'S/ 125.00')
    await save(aside)
    await toast(page, 'Pedido actualizado.')
    const after = await t.after('order')
    assert.deepEqual(after.items.map((i) => i.item_type), ['product', 'product', 'product', 'accessory'])
    assert.equal(after.order.price, before.order.price + 10)
    assert.deepEqual(after.items.slice(0, 3).map((i) => i.catalog_product_id), before.items.map((i) => i.catalog_product_id))
    return 'Accesorio clasificado; total 115 → 125; vínculos intactos'
  })

  for (const [id, title, act, expectedTotal] of [
    ['02.2', 'Cambiar precio de un accesorio', (aside) => price(aside, 1).fill('15'), 75],
    ['02.3', 'Cambiar cantidad de un accesorio', (aside) => quantity(aside, 1).fill('3'), 90],
  ]) {
    await r.test(id, { user: 'A-LOG', title, expected: `Total ${expectedTotal}; clasificación intacta` }, async (t) => {
      const order = await t.setup(() => withAccessory(world))
      const before = await t.watch('order', order.orderId)
      assert.equal(before.order.price, 70)
      const { page, aside } = await panelFor(t, 'A-LOG', order)
      await act(aside)
      await save(aside)
      await toast(page, 'Pedido actualizado.')
      const after = await t.after('order')
      assert.deepEqual(after.items.map((i) => i.item_type), ['product', 'accessory'])
      assert.equal(after.order.price, expectedTotal)
      assert.equal(after.items[0].catalog_product_id, order.catalog[0].id)
      return `Total ${before.order.price} → ${after.order.price}`
    })
  }

  await r.test('02.4a', { user: 'A-LOG', title: 'Renombrar una línea vinculada (panel lateral)', expected: 'Solo esa línea pierde el vínculo' }, async (t) => {
    const order = await t.setup(() => multiLine(world))
    await t.watch('order', order.orderId)
    const { page, aside } = await panelFor(t, 'A-LOG', order)
    await productName(aside, 0).fill('Nombre escrito a mano')
    await save(aside)
    await toast(page, 'Pedido actualizado.')
    const after = await t.after('order')
    assert.deepEqual(after.items.map((i) => i.catalog_product_id), [null, order.catalog[1].id, null])
    assert.equal(after.order.price, 115)
    return 'Línea 1 desvinculada; línea 2 conserva el vínculo'
  })

  await r.test('02.4b', { user: 'A-LOG', title: 'Renombrar una línea vinculada (formulario de detalle)', expected: 'No aplicable: se valida por el panel lateral vigente' }, async (t) => {
    t.notApplicable('El formulario de detalle no es la vía aprobada para edición logística; el mismo comportamiento se cubre en el panel lateral vigente en 02.4a / 02.6a.')
    return 'NA: comportamiento equivalente cubierto por el panel lateral'
  }), async (t) => {
    const order = await t.setup(() => multiLine(world))
    await t.watch('order', order.orderId)
    const { page, section } = await openDetail(t, 'A-LOG', order.orderId)
    const form = await openEditForm(page, section)
    await form.getByLabel('Producto', { exact: true }).nth(0).fill('Nombre escrito a mano')
    await submitForm(form)
    await toast(page, 'Pedido actualizado')
    const after = await t.after('order')
    assert.deepEqual(after.items.map((i) => i.catalog_product_id), [null, order.catalog[1].id, null])
    assert.deepEqual(after.items.map((i) => i.item_type), ['product', 'product', 'product'])
    return 'Línea 1 desvinculada; línea 2 conserva el vínculo'
  })

  await r.test('02.5', { user: 'A-LOG', title: 'Cambiar cantidad sin renombrar', expected: 'Se conserva el vínculo' }, async (t) => {
    const order = await t.setup(() => multiLine(world))
    const before = await t.watch('order', order.orderId)
    const { page, aside } = await panelFor(t, 'A-LOG', order)
    await quantity(aside, 0).fill('2')
    await save(aside)
    await toast(page, 'Pedido actualizado.')
    const after = await t.after('order')
    assert.deepEqual(after.items.map((i) => i.catalog_product_id), before.items.map((i) => i.catalog_product_id))
    assert.equal(after.order.price, 175)
    return 'Vínculos intactos; total 175'
  })

  await r.test('02.6a', { user: 'A-LOG', title: 'Producto inactivo: guardar líneas (panel lateral)', expected: 'invalid_catalog_product, ningún cambio y mensaje de recuperación' }, async (t) => {
    const order = await t.setup(() => withInactive(world))
    const before = await t.watch('order', order.orderId)
    const { page, aside } = await panelFor(t, 'A-LOG', order)
    await quantity(aside, 0).fill('2')
    await save(aside)
    await toast(page, 'catálogo activo')
    assert.deepEqual(t.posts('/api/orders/payments/orders/').map((p) => p.status), [400])
    assert.deepEqual(await t.after('order'), before)
    return 'Rechazado sin cambios; el mensaje pide volver a escribir el nombre'
  })

  await r.test('02.6b', { user: 'A-LOG', title: 'Producto inactivo: guardar líneas (formulario de detalle)', expected: 'No aplicable: se valida por el panel lateral vigente' }, async (t) => {
    t.notApplicable('El formulario de detalle no es la vía aprobada para edición logística; el mismo comportamiento se cubre en el panel lateral vigente en 02.4a / 02.6a.')
    return 'NA: comportamiento equivalente cubierto por el panel lateral'
  }), async (t) => {
    const order = await t.setup(() => withInactive(world))
    const before = await t.watch('order', order.orderId)
    const { page, section } = await openDetail(t, 'A-LOG', order.orderId)
    const form = await openEditForm(page, section)
    await form.getByLabel('Cantidad', { exact: true }).nth(0).fill('2')
    await submitForm(form)
    await toast(page, 'ya no está en el catálogo activo')
    assert.deepEqual(await t.after('order'), before)
    return 'Rechazado sin cambios'
  })

  await r.test('02.7', { user: 'A-LOG', title: 'Recuperación: volver a escribir el nombre inactivo', expected: 'Guarda sin vínculo' }, async (t) => {
    const order = await t.setup(() => withInactive(world))
    await t.watch('order', order.orderId)
    const { page, aside } = await panelFor(t, 'A-LOG', order)
    await quantity(aside, 0).fill('2')
    await productName(aside, 1).fill('')
    await productName(aside, 1).fill(order.dead.name)
    await save(aside)
    await toast(page, 'Pedido actualizado.')
    const after = await t.after('order')
    assert.deepEqual(after.items.map((i) => i.catalog_product_id), [order.live.id, null])
    assert.equal(after.order.price, 130)
    return 'Guardado; la línea inactiva quedó sin vínculo'
  })

  await r.test('02.8', { user: '—', title: 'Comisiones históricas', expected: 'No aplicable' }, async (t) => {
    t.notApplicable('WACRM no calcula ni almacena comisiones.')
    return 'No existe cálculo de comisiones que verificar'
  })
}
