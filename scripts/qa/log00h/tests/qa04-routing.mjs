// QA04: "Derivar a Comercial" — real server authorization, idempotency and access afterwards.
import assert from 'node:assert/strict'

import { pause } from '../lib/harness.mjs'
import { deriveButton, deriveConfirm, deriveDialog, openChat, openPanel, panelFor, toast } from '../lib/ui.mjs'
import { mkConversation, mkOrder, must, routingState, signedIn, toLogisticsStage } from '../lib/world.mjs'

const url = (conversationId) => `/api/conversations/${conversationId}/derive-to-commercial`
const derivations = (state) => state.events.filter((e) => e.reason === 'derived_to_commercial').length
const order = (world, label = 'DER') => mkOrder(world, 'A', { label, total: 30 })

async function deriveInUi(page, aside) {
  await deriveButton(aside).click({ timeout: 45_000 })
  await deriveDialog(page).waitFor()
  await deriveConfirm(page).click()
  await toast(page, 'Conversación derivada a Comercial')
}

export async function register(r) {
  const world = r.world

  await r.test('04.1', { user: 'A-LOG', title: 'Logística deriva un chat con pedido', expected: 'shared, un evento, pedido sin cambios' }, async (t) => {
    const o = await t.setup(() => order(world))
    const before = await t.watch('order', o.orderId)
    const { page, aside } = await panelFor(t, 'A-LOG', o)
    await deriveInUi(page, aside)
    const state = await routingState(o.conversationId)
    assert.equal(state.stage, 'shared')
    assert.equal(derivations(state), 1)
    assert.deepEqual(await t.after('order'), before)
    await aside.getByText('Compartida con Comercial').waitFor()
    return 'Derivado; pedido idéntico'
  })

  await r.test('04.2', { user: 'A-LOG', title: 'Logística deriva un chat sin pedido', expected: 'shared, un evento' }, async (t) => {
    const chat = await t.setup(async () => {
      const c = await mkConversation(world, 'A', 'sin-pedido')
      await toLogisticsStage(world, 'A', c.conversationId)
      return c
    })
    const page = await t.page('A-LOG')
    const aside = await openPanel(page, chat.conversationId)
    await aside.getByText('Sin pedido confirmado').waitFor({ timeout: 45_000 })
    await deriveInUi(page, aside)
    const state = await routingState(chat.conversationId)
    assert.equal(state.stage, 'shared')
    assert.equal(derivations(state), 1)
    return 'Derivado'
  })

  await r.test('04.3', { user: 'A-SUP', title: 'Supervisor deriva desde la vista Logística', expected: 'shared, un evento' }, async (t) => {
    const o = await t.setup(() => order(world))
    const { page, aside } = await panelFor(t, 'A-SUP', o, { supervisor: true })
    await deriveInUi(page, aside)
    assert.equal((await routingState(o.conversationId)).stage, 'shared')
    return 'Derivado'
  })

  await r.test('04.4', { user: 'A-RO', title: 'Solo lectura intenta derivar', expected: 'Sin botón; API 403; sin cambios' }, async (t) => {
    const o = await t.setup(() => order(world))
    const page = await t.page('A-RO')
    // a viewer cannot read the order editor: wait for the panel and give the routing state time to arrive
    const aside = await openPanel(page, o.conversationId)
    await pause(6000)
    assert.equal(await deriveButton(aside).count(), 0)
    const res = await t.api('A-RO', 'POST', url(o.conversationId))
    assert.equal(res.status, 403, JSON.stringify(res.body))
    const state = await routingState(o.conversationId)
    assert.equal(state.stage, 'logistics')
    assert.equal(derivations(state), 0)
    return 'Botón ausente y servidor 403'
  })

  await r.test('04.5', { user: 'A-COM', title: 'Comercial intenta derivar', expected: 'API 403; sin botón' }, async (t) => {
    const o = await t.setup(() => order(world))
    const res = await t.api('A-COM', 'POST', url(o.conversationId))
    assert.equal(res.status, 403, JSON.stringify(res.body))
    const page = await t.page('A-COM')
    await openChat(page, o.conversationId)
    await pause(5000)
    assert.equal(await deriveButton(page).count(), 0)
    assert.equal((await routingState(o.conversationId)).stage, 'logistics')
    return 'Servidor 403'
  })

  for (const [id, user] of [['04.6a', 'B-LOG'], ['04.6b', 'B-SUP']]) {
    await r.test(id, { user, title: 'Usuario de otra cuenta intenta derivar', expected: 'API 403; sin cambios' }, async (t) => {
      const o = await t.setup(() => order(world))
      const before = await routingState(o.conversationId)
      const res = await t.api(user, 'POST', url(o.conversationId))
      assert.equal(res.status, 403, JSON.stringify(res.body))
      assert.deepEqual(await routingState(o.conversationId), before)
      return 'Rechazado por el servidor'
    })
  }

  await r.test('04.7', { user: 'A-LOG', title: 'Doble clic al confirmar', expected: 'Una petición y un evento' }, async (t) => {
    const o = await t.setup(() => order(world))
    const { page, aside } = await panelFor(t, 'A-LOG', o)
    await deriveButton(aside).click({ timeout: 45_000 })
    await deriveConfirm(page).dblclick()
    await toast(page, 'Conversación derivada a Comercial')
    await pause(1500)
    assert.equal(t.posts('/derive-to-commercial').length, 1)
    assert.equal(derivations(await routingState(o.conversationId)), 1)
    return 'Una sola petición'
  })

  await r.test('04.8', { user: 'A-LOG', title: 'Chat ya compartido', expected: '200, changed=false, sin evento nuevo' }, async (t) => {
    const o = await t.setup(() => order(world))
    const first = await t.api('A-LOG', 'POST', url(o.conversationId))
    assert.equal(first.status, 200)
    const second = await t.api('A-LOG', 'POST', url(o.conversationId))
    assert.equal(second.status, 200)
    assert.equal(second.body.changed, false)
    assert.equal(derivations(await routingState(o.conversationId)), 1)
    return 'Idempotente'
  })

  await r.test('04.9', { user: 'A-LOG', title: 'Chat en etapa comercial', expected: 'API 409' }, async (t) => {
    const chat = await t.setup(() => mkConversation(world, 'A', 'comercial'))
    const res = await t.api('A-LOG', 'POST', url(chat.conversationId))
    assert.equal(res.status, 409, JSON.stringify(res.body))
    assert.equal((await routingState(chat.conversationId)).stage, 'commercial')
    return 'Rechazado: transición no válida'
  })

  await r.test('04.10', { user: 'A-LOG', title: 'Error de red al derivar', expected: 'Mensaje, sin cambios y reintento correcto' }, async (t) => {
    const o = await t.setup(() => order(world))
    const { page, aside } = await panelFor(t, 'A-LOG', o)
    await page.route('**/derive-to-commercial', (route) => route.abort('failed'))
    await deriveButton(aside).click({ timeout: 45_000 })
    await deriveConfirm(page).click()
    await toast(page, 'No se pudo derivar la conversación')
    assert.equal((await routingState(o.conversationId)).stage, 'logistics')
    await page.unroute('**/derive-to-commercial')
    await deriveConfirm(page).click()
    await toast(page, 'Conversación derivada a Comercial')
    assert.equal(derivations(await routingState(o.conversationId)), 1)
    return 'Falló sin cambios; el reintento derivó una vez'
  })

  await r.test('04.11', { user: 'A-COM / A-LOG', title: 'Acceso después de derivar', expected: 'Comercial accede; Logística conserva acceso y gestiona el pedido' }, async (t) => {
    const o = await t.setup(() => order(world))
    const commercial = await signedIn(world, 'A-COM')
    const visible = async (client) => (await must(client.from('conversations').select('id').eq('id', o.conversationId), 'conversations')).length
    assert.equal(await visible(commercial), 0, 'commercial must not see a logistics chat before')
    assert.equal((await t.api('A-LOG', 'POST', url(o.conversationId))).status, 200)
    assert.equal(await visible(commercial), 1)
    assert.ok((await must(commercial.from('messages').select('id').eq('conversation_id', o.conversationId), 'messages')).length > 0)
    assert.equal(await visible(await signedIn(world, 'A-LOG')), 1)
    const edit = await t.api('A-LOG', 'POST', `/api/orders/payments/orders/${o.orderId}`, { action: 'edit_order', fields: { destination: 'Tras derivar' }, reason: 'QA' })
    assert.equal(edit.status, 200, JSON.stringify(edit.body))
    return 'Comercial gana acceso; Logística lo conserva y edita el pedido'
  })
}
