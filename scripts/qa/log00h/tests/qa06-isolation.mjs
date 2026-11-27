// QA06: isolation between the two accounts, through the app's API and straight against PostgREST.
import assert from 'node:assert/strict'

import { mkCatalog, mkOrder, must, signedIn, snapshot } from '../lib/world.mjs'

export async function register(r) {
  const world = r.world
  const targets = (keys) => ({
    orders: keys.map((k) => world.orders[k].orderId),
    chats: keys.map((k) => world.orders[k].conversationId),
  })
  const A = targets(['O1', 'O5', 'O9', 'O14'])
  const B = targets(['OB1', 'OB2'])

  async function cannotRead(user, target) {
    const client = await signedIn(world, user)
    const queries = [
      ['order_confirmations', 'id', target.orders],
      ['order_confirmation_items', 'order_id', target.orders],
      ['order_payments', 'order_id', target.orders],
      ['order_documents', 'order_id', target.orders],
      ['conversations', 'id', target.chats],
      ['messages', 'conversation_id', target.chats],
    ]
    for (const [table, column, ids] of queries) {
      const { data, error } = await client.from(table).select(column).in(column, ids)
      assert.ok(error || data.length === 0, `${user} read ${data?.length} rows of ${table}`)
    }
  }
  async function control(user, target) {
    const client = await signedIn(world, user)
    assert.ok((await must(client.from('order_confirmations').select('id').in('id', target.orders), 'control')).length > 0, `${user} cannot even read its own orders: the test proves nothing`)
  }

  for (const [id, user] of [['06.1a', 'B-LOG'], ['06.1b', 'B-SUP']]) {
    await r.test(id, { user, title: 'Leer datos de la cuenta A', expected: '0 filas' }, async () => {
      await control(user, B)
      await cannotRead(user, A)
      return 'Ninguna fila ajena'
    })
  }

  await r.test('06.2', { user: 'B-SUP / B-LOG', title: 'API sobre un pedido de A', expected: '404 o 403; sin cambios' }, async (t) => {
    const orderId = world.orders.O5.orderId
    const before = await snapshot(orderId)
    const seen = []
    for (const user of ['B-SUP', 'B-LOG']) {
      const url = `/api/orders/payments/orders/${orderId}`
      for (const [method, body] of [
        ['GET', null],
        ['POST', { action: 'edit_order', fields: { destination: 'ajeno' }, reason: 'QA' }],
        ['POST', { action: 'register', request_key: `qa-x-${user}`, amount: '1.00', kind: 'advance', paid_at: new Date(Date.now() - 60_000).toISOString() }],
      ]) {
        const res = await t.api(user, method, url, body)
        assert.ok([403, 404].includes(res.status), `${user} ${method} ${body?.action ?? ''}: ${res.status}`)
        seen.push(res.status)
      }
    }
    assert.deepEqual(await snapshot(orderId), before)
    return `Respuestas ${seen.join(', ')}`
  })

  await r.test('06.3', { user: 'B-SUP / A-COM', title: 'Escritura directa en tablas', expected: 'Denegada; sin cambios' }, async () => {
    const orderId = world.orders.O5.orderId
    const before = await snapshot(orderId)
    for (const user of ['B-SUP', 'A-COM', 'A-LOG']) {
      const client = await signedIn(world, user)
      const update = await client.from('order_confirmations').update({ destination: 'directo' }).eq('id', orderId).select('id')
      assert.ok(update.error || update.data.length === 0, `${user} updated an order directly`)
      const insert = await client.from('order_payments').insert({ account_id: world.accounts.A, order_id: orderId, request_key: `qa-direct-${user}`, amount: 1, kind: 'advance', status: 'confirmed' }).select('id')
      assert.ok(insert.error, `${user} inserted a payment directly`)
      const items = await client.from('order_confirmation_items').update({ unit_price: 1 }).eq('order_id', orderId).select('id')
      assert.ok(items.error || items.data.length === 0, `${user} updated lines directly`)
    }
    assert.deepEqual(await snapshot(orderId), before)
    return 'Todas denegadas'
  })

  await r.test('06.4', { user: 'B-SUP / A-LOG', title: 'Funciones restringidas con sesión de usuario', expected: 'Denegadas' }, async () => {
    const orderId = world.orders.O5.orderId
    const before = await snapshot(orderId)
    for (const user of ['B-SUP', 'A-LOG']) {
      const client = await signedIn(world, user)
      const { error } = await client.rpc('edit_order_confirmation', {
        p_account: world.accounts.A, p_actor: world.users['A-LOG'].id, p_order: orderId, p_fields: { destination: 'rpc' }, p_reason: 'QA',
      })
      assert.ok(error, `${user} executed edit_order_confirmation`)
      assert.match(`${error.code} ${error.message}`, /42501|permission denied|PGRST202/)
    }
    assert.deepEqual(await snapshot(orderId), before)
    return 'Sin permiso de ejecución'
  })

  await r.test('06.5', { user: 'B-LOG', title: 'Usar un producto de catálogo de A en un pedido de B', expected: '400 invalid_catalog_product; sin cambios' }, async (t) => {
    const foreign = await t.setup(() => mkCatalog(world, 'A', 'ajeno'))
    const order = await t.setup(() => mkOrder(world, 'B', { label: 'B-CAT', items: [{ product_name: 'Producto B', quantity: 1, unit_price: 12 }] }))
    const before = await t.watch('order', order.orderId)
    const res = await t.api('B-LOG', 'POST', `/api/orders/payments/orders/${order.orderId}`, {
      action: 'edit_order', reason: 'QA',
      fields: { items: [{ product_name: foreign.name, quantity: '1', unit_price: '12.00', item_type: 'product', catalog_product_id: foreign.id }] },
    })
    assert.equal(res.status, 400, JSON.stringify(res.body))
    assert.equal(res.body.error, 'invalid_catalog_product')
    assert.deepEqual(await t.after('order'), before)
    return 'Rechazado'
  })

  await r.test('06.6', { user: 'A-SUP', title: 'Sentido inverso: A sobre datos de B', expected: '0 filas y 404' }, async (t) => {
    await control('A-SUP', A)
    await cannotRead('A-SUP', B)
    const res = await t.api('A-SUP', 'GET', `/api/orders/payments/orders/${world.orders.OB1.orderId}`)
    assert.equal(res.status, 404, JSON.stringify(res.body))
    return 'Aislado en ambos sentidos'
  })
}
