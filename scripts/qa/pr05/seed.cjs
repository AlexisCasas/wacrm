/* LOCAL ONLY. Prepares the PR-05 UAT on top of the PR-04 integrated QA world: enables shalom_tracking_enabled for the QA accounts and creates six orders that
 * are REALLY ready_for_dispatch (they go through the real PR-04 HTTP flow: voucher -> OCR -> validation -> packaging -> evidence -> simulated template).
 *   node scripts/qa/pr05/seed.cjs prepare     (needs: local Supabase, the app on :3000 with the Meta simulator, the QA world of pr04-integrated)
 *   node scripts/qa/pr05/seed.cjs flag on|off  (shalom_tracking_enabled of the QA accounts A and C)
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
  throw new Error('usage: prepare | flag on|off')
})().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1) })
