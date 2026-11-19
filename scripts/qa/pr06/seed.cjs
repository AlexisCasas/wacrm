/* LOCAL ONLY. Prepares the PR-06 (payments) UAT on top of the PR-04 integrated QA world (the same accounts / users as PR-05). It never touches the orders of the earlier UAT:
 * those were confirmed BEFORE PR-06 was activated, so they are "historical" (not tracked): no financial row, no chip, no Pagos block, they never block a conversation return.
 *   node scripts/qa/pr06/seed.cjs prepare   (needs: local Supabase, the app on :3000 with the Meta simulator, the QA world of pr04-integrated)
 *   node scripts/qa/pr06/seed.cjs flag on|off   order_payments_enabled of QA account A (off = no UI, no writes, no finalization; nothing is deleted)
 * NEW orders (every one is TRACKED, S/ 100.00, ready_for_dispatch through the real PR-04 flow):
 *   P1  S/100 Shalom           guide 40000021 / QAP1   A,B,C (payments) then Shalom delivered (E) -> finalization
 *   P2  S/100 "Olva"           NO Shalom guide         J: manual delivered
 *   P3 + P4  two orders in the SAME chat (manual delivery)  I: one finalized + the other active -> no return; both -> return
 *   PS  smoke (already driven end to end by Claude, do not use) */
const C = require('../pr05/common.cjs')
const S = require('../pr04-integrated/seed.cjs')
const V = require('../pr04-integrated/verify-chain.cjs')
const path = require('node:path')

const TOTAL = 100
const ORDERS = [
  { key: 'P1', name: 'Pago QA P1 · S/100 con guía Shalom (A→E)', number: '40000021', code: 'QAP1', note: 'registrar guía 40000021/QAP1; pagar S/30, S/70; sim set delivered 40000021 → finalizado' },
  { key: 'P2', name: 'Pago QA P2 · S/100 Olva (entrega manual)', note: 'SIN guía Shalom: pagar S/100 y "Marcar como entregado" (J)' },
  { key: 'P3', name: 'Pago QA P3 · chat compartido, pedido 1', note: 'I: mismo chat que P4' },
  { key: 'P4', name: 'Pago QA P4 · chat compartido, pedido 2', note: 'I: mismo chat que P3', sameChatAs: 'P3' },
  { key: 'PS', name: 'Pago QA PS · humo automático (ya recorrido por Claude, no lo uses)', note: 'ignorar' },
]

async function setFlag(st, on) {
  const { error } = await C.admin.from('order_payment_settings').upsert({ account_id: st.acc, order_payments_enabled: on })
  if (error) throw error
  console.log(`order_payments_enabled = ${on} (QA account A). Orders confirmed before the FIRST activation stay not tracked.`)
}

async function makeReady(st, o, conv) {
  const c = conv ?? (await S.mkConversation(st.acc, st.users.owner.id, o.name, `5190${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, [['customer', 'Hola, ya pagué el adelanto'], ['agent', 'Recibido, vamos a embalar']]))
  const mediaId = await S.addMedia(c.conversationId, st.acc, path.join(st.fixtures, 'media-A-correcta.png'), `pr06-${o.key}`)
  const order = await S.confirmOrder(st.acc, st.users.comercial, c, `pr06-${o.key}-${V.rid()}`, S.single(o.name, String(60000000 + Math.floor(Math.random() * 3e7)), `5196${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, 'Producto Pago', 1, TOTAL, 'Arequipa'))
  console.log(`[${o.key}] ${o.name}: PR-04 chain…`)
  require('node:fs').writeFileSync(path.join(C.L.QA_DIR, 'meta-mode.txt'), 'success')
  const out = await V.chain('logistica', { order, conv: c.conversationId, mediaId }, 'success', () => {})
  if (out.validate !== 200 || !String(out['template(success)']).startsWith('2')) throw new Error(`PR-04 chain failed for ${o.key}: ${JSON.stringify(out)}`)
  return { orderId: order, conversationId: c.conversationId, contactId: c.contactId, ...o }
}

async function prepare() {
  const st = C.state()
  await setFlag(st, true) // BEFORE the new orders: they start tracked (unpaid)
  st.pr05 ??= { orders: {} }
  for (const o of ORDERS) {
    if (st.pr05.orders[o.key]) { console.log(`[${o.key}] already exists, skipped`); continue }
    const shared = o.sameChatAs ? { conversationId: st.pr05.orders[o.sameChatAs].conversationId, contactId: st.pr05.orders[o.sameChatAs].contactId } : null
    st.pr05.orders[o.key] = await makeReady(st, o, shared)
    C.L.writeState(st)
  }
  console.log('\nNEW PR-06 orders (S/ 100.00 each, TRACKED, ready_for_dispatch). Open Pedidos Confirmados as qa-logistica / qa-supervisor:')
  console.table(ORDERS.map((o) => ({ pedido: o.name, guía: o.number ? `${o.number} / ${o.code}` : '—', prueba: o.note })))
}

;(async () => {
  const [cmd, arg] = process.argv.slice(2)
  if (cmd === 'prepare') return prepare()
  if (cmd === 'flag') return setFlag(C.state(), arg === 'on')
  throw new Error('usage: prepare | flag on|off')
})().catch((e) => { console.error(e.message); process.exitCode = 1 })
