// QA05: general regression. Nothing here sends a message or places a call.
import assert from 'node:assert/strict'

import { APP, pause, until } from '../lib/harness.mjs'
import { logisticsAside, openChat } from '../lib/ui.mjs'
import { must, signedIn } from '../lib/world.mjs'

export async function register(r) {
  const world = r.world
  const chats = ['CV-COM', 'CV-LOG', 'CV-SH']

  await r.test('05.1a', { user: 'A-*', title: 'Bandejas: cada área ve sus etapas (RLS)', expected: 'COM: comercial+compartida · LOG y RO: logística+compartida · SUP: todas' }, async () => {
    const expected = { 'A-COM': ['CV-COM', 'CV-SH'], 'A-LOG': ['CV-LOG', 'CV-SH'], 'A-RO': ['CV-LOG', 'CV-SH'], 'A-SUP': chats }
    const seen = []
    for (const [user, keys] of Object.entries(expected)) {
      const client = await signedIn(world, user)
      const rows = await must(client.from('conversations').select('id').in('id', chats.map((k) => world.conversations[k])), 'conversations')
      const got = chats.filter((k) => rows.some((row) => row.id === world.conversations[k]))
      assert.deepEqual(got, keys, user)
      seen.push(`${user}: ${got.join('+')}`)
    }
    return seen.join(' · ')
  })

  await r.test('05.1b', { user: 'A-COM / A-LOG', title: 'Panel lateral según el área', expected: 'Comercial ve el panel de contacto; Logística el logístico' }, async (t) => {
    const commercial = await t.page('A-COM')
    await openChat(commercial, world.conversations['CV-SH'])
    await commercial.getByText('Contacto QA CV-SH').first().waitFor({ timeout: 45_000 })
    await pause(2500)
    assert.equal(await logisticsAside(commercial).count(), 0)
    const logistics = await t.page('A-LOG')
    await openChat(logistics, world.conversations['CV-SH'])
    await logisticsAside(logistics).waitFor({ timeout: 45_000 })
    return 'Paneles correctos'
  })

  await r.test('05.2', { user: 'A-LOG / A-COM', title: 'Pedidos Confirmados: lista y paginación', expected: 'Lista, carga más; Comercial 403' }, async (t) => {
    const page = await t.page('A-LOG')
    await page.goto(`${APP}/confirmed-orders`, { waitUntil: 'domcontentloaded' })
    const buttons = page.getByRole('button', { name: /Ver pedido/ })
    await buttons.first().waitFor({ timeout: 60_000 })
    const first = await buttons.count()
    await page.getByRole('button', { name: 'Cargar más' }).click()
    await until(async () => (await buttons.count()) > first, 'the second page')
    const second = await buttons.count()
    const denied = await t.api('A-COM', 'GET', '/api/orders/confirmed')
    assert.equal(denied.status, 403)
    return `${first} → ${second} pedidos; Comercial 403`
  })

  await r.test('05.3', { user: 'A-LOG', title: 'Resumen de pagos de la lista', expected: '200 con saldos' }, async (t) => {
    const ids = ['O9', 'O11'].map((k) => world.orders[k].orderId)
    const res = await t.api('A-LOG', 'GET', `/api/orders/payments/summary?ids=${ids.join(',')}`)
    assert.equal(res.status, 200)
    assert.equal(res.body.summaries[ids[0]].pending_balance, 60)
    assert.equal(res.body.summaries[ids[1]].pending_balance, 0)
    return 'Saldos 60 y 0'
  })

  await r.test('05.4', { user: 'A-*', title: 'Calling restringido por área (sin llamadas)', expected: 'Supervisor y Logística 200; Comercial y solo lectura 403' }, async (t) => {
    const seen = []
    for (const [user, status] of [['A-SUP', 200], ['A-LOG', 200], ['A-COM', 403], ['A-RO', 403]]) {
      const res = await t.api(user, 'GET', '/api/whatsapp/calls?inbox_alerts=1')
      assert.equal(res.status, status, `${user}: ${JSON.stringify(res.body)}`)
      seen.push(`${user} ${res.status}`)
    }
    return seen.join(' · ')
  })

  await r.test('05.5', { user: 'A-SUP', title: 'Flows: la sección abre y lista', expected: 'Página y API responden; sin ejecutar nada' }, async (t) => {
    const page = await t.page('A-SUP')
    const response = await page.goto(`${APP}/flows`, { waitUntil: 'networkidle' })
    assert.equal(response.status(), 200)
    assert.equal(await page.getByText('Application error').count(), 0)
    const list = await t.api('A-SUP', 'GET', '/api/flows')
    assert.equal(list.status, 200, JSON.stringify(list.body))
    return 'Sección y API correctas (prueba superficial)'
  })

  await r.test('05.6', { user: 'A-*', title: 'Permisos de la ficha de pagos', expected: 'Logística y Supervisor 200; Comercial y solo lectura 403' }, async (t) => {
    const url = `/api/orders/payments/orders/${world.orders.O9.orderId}`
    const seen = []
    for (const [user, status] of [['A-LOG', 200], ['A-SUP', 200], ['A-COM', 403], ['A-RO', 403]]) {
      const res = await t.api(user, 'GET', url)
      assert.equal(res.status, status, `${user}: ${JSON.stringify(res.body)}`)
      seen.push(`${user} ${res.status}`)
    }
    const write = await t.api('A-RO', 'POST', url, { action: 'edit_order', fields: { destination: 'x' }, reason: 'QA' })
    assert.equal(write.status, 403)
    return seen.join(' · ')
  })
}
