/* LOCAL ONLY. Prepares the PR-05 UAT on top of the PR-04 integrated QA world: enables shalom_tracking_enabled for the QA accounts and creates six orders that
 * are REALLY ready_for_dispatch (they go through the real PR-04 HTTP flow: voucher -> OCR -> validation -> packaging -> evidence -> simulated template).
 *   node scripts/qa/pr05/seed.cjs prepare     (needs: local Supabase, the app on :3000 with the Meta simulator, the QA world of pr04-integrated)
 *   node scripts/qa/pr05/seed.cjs flag on|off  (shalom_tracking_enabled of the QA accounts A and C)
 *   node scripts/qa/pr05/seed.cjs pickup-prepare   PR-05A/B: NEW orders G/H/I (ready_for_dispatch), the day-15 customer message switch ON for QA account A and the fake template
 *                                                  `qa_pendiente_recojo`. It does NOT touch the orders / scenarios of the earlier UAT (A..F).
 *   node scripts/qa/pr05/seed.cjs message on|off   destination_customer_message_enabled of QA account A (the kill switch of the customer message only)
 *   node scripts/qa/pr05/seed.cjs routing-prepare  PR-05C: NEW confirmed orders R1..R5 whose conversation is in LOGISTICS (own history), to test Derivar a Comercial and the
 *                                                  automatic return 10 minutes after the simulated "pedido completamente finalizado" (see finalize.cjs)
 *   node scripts/qa/pr05/seed.cjs meta success|failed|uncertain   what the Meta SIMULATOR answers to the next template sends
 * Cleanup: `node scripts/qa/pr04-integrated/seed.cjs cleanup` removes the whole QA world (accounts cascade); the fake scenarios live in C:\WACRM-LOCAL-QA\shalom-scenarios.json. */
const C = require('./common.cjs')
const S = require('../pr04-integrated/seed.cjs')
const V = require('../pr04-integrated/verify-chain.cjs')

const ORDERS = [
  { key: 'A', name: 'Envío QA A · flujo completo', number: '40000001', code: 'QAA1', note: 'registrar → En origen → En tránsito → En destino → +15 días → alerta → atender → Entregado' },
  { key: 'B', name: 'Envío QA B · guía no encontrada (404)', number: '40000002', code: 'QAB2', note: 'sim set not_found 40000002 → no se marca inexistente de inmediato' },
  { key: 'C', name: 'Envío QA C · límite 429', number: '40000003', code: 'QAC3', note: 'sim set rate_limited 40000003' },
  { key: 'D', name: 'Envío QA D · estado desconocido', number: '40000004', code: 'QAD4', note: 'sim set unknown 40000004 → excepción técnica, no avanza' },
  { key: 'E', name: 'Envío QA E · corregir guía', number: '40000005', code: 'QAE5', note: 'registra 40000005/QAE5 (equivocada) y corrígela a 40000015/QAE6' },
  { key: 'F', name: 'Envío QA F · detener (Supervisor)', number: '40000006', code: 'QAF6', note: 'solo Supervisor puede detener el seguimiento' },
]

async function setFlag(st, on) {
  for (const acc of [st.acc, st.accC]) {
    const { error } = await C.admin.from('order_shipment_settings').upsert({ account_id: acc, shalom_tracking_enabled: on })
    if (error) throw error
  }
  console.log(`shalom_tracking_enabled = ${on} for the QA accounts A and C`)
}

const PICKUP_ORDERS = [
  { key: 'G', name: 'Envío QA G · recojo: día 14 → 15 → 19 → 20 → 21 → Entregado', number: '40000011', code: 'QAG1', note: 'registrar, sim set destination 40000011, run-cron, advance G 14 --absolute / 15 / 19 / 20 / 21, luego sim set delivered' },
  { key: 'H', name: 'Envío QA H · mensaje día 15 FALLA', number: '40000012', code: 'QAH2', note: 'seed meta failed, advance H 15 --absolute, run-cron: mensaje Falló, tracking sigue; seed meta success y Reintentar mensaje' },
  { key: 'I', name: 'Envío QA I · mensaje día 15 INCIERTO', number: '40000013', code: 'QAI3', note: 'seed meta uncertain, advance I 15 --absolute, run-cron: Incierto, nunca se reenvía solo; confirmar en el panel' },
  { key: 'S', name: 'Envío QA S · humo automático (ya recorrido por Claude, no lo uses)', number: '40000019', code: 'QAS9', note: 'verificación de extremo a extremo del envío real contra el simulador; ignorar' },
]
const FAKE_TEMPLATE = 'qa_pendiente_recojo'

async function setMessage(st, on) {
  const { error } = await C.admin.from('order_shipment_settings').upsert({
    account_id: st.acc, shalom_tracking_enabled: true, destination_customer_message_enabled: on,
    customer_message_template_name: FAKE_TEMPLATE, customer_message_template_language: 'es', customer_message_template_params: ['customer_name'],
  })
  if (error) throw error
  console.log(`destination_customer_message_enabled = ${on} (QA account A; template ${FAKE_TEMPLATE}/es, variable: customer_name)`)
}

async function ensureFakeTemplate(st) {
  const { data } = await C.admin.from('message_templates').select('id, status').eq('account_id', st.acc).eq('name', FAKE_TEMPLATE).eq('language', 'es').maybeSingle()
  if (data) {
    if (data.status !== 'APPROVED') await C.admin.from('message_templates').update({ status: 'APPROVED' }).eq('id', data.id)
    return
  }
  const { error } = await C.admin.from('message_templates').insert({
    user_id: st.users.owner.id, account_id: st.acc, name: FAKE_TEMPLATE, category: 'Utility', language: 'es', status: 'APPROVED',
    body_text: 'Hola {{1}}, tu pedido continúa pendiente de recojo en la agencia de destino. Si no es recogido dentro del plazo indicado, se procederá con la devolución del producto a la agencia de origen.',
  })
  if (error) throw error
  console.log(`fake template ${FAKE_TEMPLATE} created (QA only: the REAL Meta template is pending, see the PR-05A/B guide)`)
}

async function makeReady(st, o) {
  const conv = await S.mkConversation(st.acc, st.users.owner.id, o.name, `5190${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, [['customer', 'Hola, ya pagué'], ['agent', 'Recibido, vamos a embalar']])
  const mediaId = await S.addMedia(conv.conversationId, st.acc, require('node:path').join(st.fixtures, 'media-A-correcta.png'), `pr05-${o.key}`)
  const order = await S.confirmOrder(st.acc, st.users.comercial, conv, `pr05-${o.key}-${V.rid()}`, S.single(o.name, String(60000000 + Math.floor(Math.random() * 3e7)), `5196${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, 'Producto Envío', 1, 25, 'Arequipa'))
  console.log(`[${o.key}] ${o.name}: PR-04 chain…`)
  require('node:fs').writeFileSync(require('node:path').join(C.L.QA_DIR, 'meta-mode.txt'), 'success') // the PR-04 template of the chain must succeed whatever mode was left
  const out = await V.chain('logistica', { order, conv: conv.conversationId, mediaId }, 'success', () => {})
  if (out.validate !== 200 || !String(out['template(success)']).startsWith('2')) throw new Error(`PR-04 chain failed for ${o.key}: ${JSON.stringify(out)}`)
  return { orderId: order, conversationId: conv.conversationId, ...o }
}

async function pickupPrepare() {
  const st = C.state()
  await ensureFakeTemplate(st)
  await setMessage(st, true)
  st.pr05 ??= { orders: {} }
  for (const o of PICKUP_ORDERS) {
    if (st.pr05.orders[o.key]) { console.log(`[${o.key}] already exists, skipped`); continue }
    st.pr05.orders[o.key] = await makeReady(st, o)
    C.L.writeState(st)
  }
  console.log('\nNEW PR-05A/B orders ready for dispatch (type these guides in Pedidos Confirmados → Tracking Shalom):')
  console.table(PICKUP_ORDERS.map((o) => ({ order: o.name, 'número de orden': o.number, código: o.code, prueba: o.note })))
}

const ROUTING_ORDERS = [
  { key: 'R1', name: 'Ruteo QA R1 · derivar a Comercial (manual)', note: 'Logística abre el chat y pulsa Derivar a Comercial; luego entrar como Comercial: mismo chat e historial' },
  { key: 'R2', name: 'Ruteo QA R2 · retorno automático +9 / +10 min', note: 'finalize mark R2 --minutes-ago 9 → tick: sigue Logística; ~1 min después → tick: Comercial' },
  { key: 'R3', name: 'Ruteo QA R3 · manual antes de vencer', note: 'finalize mark R3 --minutes-ago 5, Derivar a Comercial, esperar el +10, tick: sin segunda transición' },
  { key: 'R4', name: 'Ruteo QA R4 · decisión humana posterior', note: 'finalize mark R4 --minutes-ago 5, finalize human-change R4 shared, tick tras el +10: no se pisa' },
  { key: 'R5', name: 'Ruteo QA R5 · reinicio de la app', note: 'finalize mark R5 --minutes-ago 4, reiniciar la app (start-app.ps1), esperar el +10, tick: igualmente vuelve' },
  { key: 'RS', name: 'Ruteo QA RS · humo automático (ya recorrido por Claude, no lo uses)', note: 'verificación de extremo a extremo; ignorar' },
]

async function routingPrepare() {
  const st = C.state()
  st.pr05 ??= { orders: {} }
  for (const o of ROUTING_ORDERS) {
    if (st.pr05.orders[o.key]) { console.log(`[${o.key}] already exists, skipped`); continue }
    const conv = await S.mkConversation(st.acc, st.users.owner.id, o.name, `5190${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, [['customer', 'Hola, ya pagué'], ['agent', 'Recibido, vamos a embalar'], ['customer', 'Gracias, quedo atento']])
    const order = await S.confirmOrder(st.acc, st.users.comercial, conv, `pr05c-${o.key}-${V.rid()}`, S.single(o.name, String(60000000 + Math.floor(Math.random() * 3e7)), `5196${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, 'Producto Ruteo', 1, 25, 'Arequipa'))
    st.pr05.orders[o.key] = { orderId: order, conversationId: conv.conversationId, ...o }
    C.L.writeState(st)
    console.log(`[${o.key}] ${o.name}: confirmed, conversation in LOGISTICS`)
  }
  console.log('\nNEW PR-05C scenarios (conversations in Logística). Use scripts/qa/pr05/finalize.cjs:')
  console.table(ROUTING_ORDERS.map((o) => ({ pedido: o.name, prueba: o.note })))
}

async function prepare() {
  const st = C.state()
  await setFlag(st, true)
  C.writeScenarios({ default: 'origin', byNumber: {} })
  require('node:fs').writeFileSync(require('node:path').join(C.L.QA_DIR, 'meta-mode.txt'), 'success')
  st.pr05 = { orders: {} }
  for (const o of ORDERS) {
    const conv = await S.mkConversation(st.acc, st.users.owner.id, o.name, `5190${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, [['customer', 'Hola, ya pagué'], ['agent', 'Recibido, vamos a embalar']])
    const mediaId = await S.addMedia(conv.conversationId, st.acc, require('node:path').join(st.fixtures, 'media-A-correcta.png'), `pr05-${o.key}`)
    const order = await S.confirmOrder(st.acc, st.users.comercial, conv, `pr05-${o.key}-${V.rid()}`, S.single(o.name, String(60000000 + Math.floor(Math.random() * 3e7)), `5196${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, 'Producto Envío', 1, 25, 'Arequipa'))
    console.log(`[${o.key}] ${o.name}: PR-04 chain…`)
    const out = await V.chain('logistica', { order, conv: conv.conversationId, mediaId }, 'success', () => {})
    if (out.validate !== 200 || !String(out['template(success)']).startsWith('2')) throw new Error(`PR-04 chain failed for ${o.key}: ${JSON.stringify(out)}`)
    st.pr05.orders[o.key] = { orderId: order, conversationId: conv.conversationId, ...o }
    C.L.writeState(st)
  }
  console.log('\nReady for dispatch (type these guides in Pedidos Confirmados → Tracking Shalom):')
  console.table(ORDERS.map((o) => ({ order: o.name, 'número de orden': o.number, código: o.code, prueba: o.note })))
}

;(async () => {
  const [cmd, arg] = process.argv.slice(2)
  if (cmd === 'prepare') return prepare()
  if (cmd === 'flag') return setFlag(C.state(), arg === 'on')
  if (cmd === 'pickup-prepare') return pickupPrepare()
  if (cmd === 'routing-prepare') return routingPrepare()
  if (cmd === 'message') return setMessage(C.state(), arg === 'on')
  if (cmd === 'meta') {
    if (!['success', 'failed', 'uncertain'].includes(arg)) throw new Error('usage: meta success|failed|uncertain')
    require('node:fs').writeFileSync(require('node:path').join(C.L.QA_DIR, 'meta-mode.txt'), arg)
    return console.log(`Meta simulator mode = ${arg}`)
  }
  throw new Error('usage: prepare | flag on|off | pickup-prepare | routing-prepare | message on|off | meta success|failed|uncertain')
})().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1) })
