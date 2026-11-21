/* LOCAL ONLY. End-to-end smoke of PR-05A/B on the QA order "S" (created by `seed.cjs pickup-prepare`): registers its guide as the QA Logistics user, makes the FAKE Shalom
 * report an arrival 25 days ago, runs ONE real tick against the running app (Meta SIMULATOR answers the template) and prints the result.
 *   node scripts/qa/pr05/smoke-pickup.cjs
 * It only touches order S (never A..I). */
const C = require('./common.cjs')

;(async () => {
  const st = C.state()
  const o = st.pr05?.orders?.S
  if (!o) throw new Error('order S not found: run `node scripts/qa/pr05/seed.cjs pickup-prepare` first')
  const actor = st.users.logistica?.id
  if (!actor) throw new Error('QA logistics user not found in the QA state')
  const arrival = new Date(Date.now() - 25 * 86_400_000).toISOString()
  const reg = await C.admin.rpc('register_order_shipment', { p_account: st.acc, p_actor: actor, p_order: o.orderId, p_number: o.number, p_code: o.code, p_now: new Date().toISOString() })
  console.log('register:', JSON.stringify(reg.data ?? reg.error))
  const sc = C.readScenarios()
  ;(sc.byNumber ??= {})[o.number] = `destination@${arrival}`
  C.writeScenarios(sc)
  await C.admin.from('order_shipments').update({ next_poll_at: new Date().toISOString() }).eq('order_id', o.orderId)
  const res = await fetch(`${C.L.APP_URL}/api/orders/shalom/cron`, { headers: { 'x-cron-secret': C.L.env.AUTOMATION_CRON_SECRET } })
  console.log('cron:', res.status, JSON.stringify(await res.json().catch(() => ({}))))
  const { data: s } = await C.admin.from('order_shipments').select('logistic_status, tracking_state, pickup_state, pickup_abandoned_at, destination_entered_at').eq('order_id', o.orderId).single()
  const { data: m } = await C.admin.from('order_shipment_messages').select('status, attempt, error_code, conversation_id, message_row_id, wamid').eq('order_id', o.orderId)
  const { data: msgs } = await C.admin.from('messages').select('content_type, template_name, status').eq('conversation_id', o.conversationId).eq('template_name', 'qa_pendiente_recojo')
  console.log('shipment:', JSON.stringify(s))
  console.log('ledger:', JSON.stringify(m))
  console.log('chat messages with the template (same conversation as the order):', JSON.stringify(msgs))
})().catch((e) => { console.error(e.message); process.exit(1) })
