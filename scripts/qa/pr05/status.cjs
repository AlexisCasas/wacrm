/* LOCAL ONLY. Read-only snapshot of the PR-05 QA state: shipments, alerts, the alert notifications and the fake scenarios in force.
 *   node scripts/qa/pr05/status.cjs */
const C = require('./common.cjs')

const limaDate = (d) => Date.parse(`${new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Lima' })}T00:00:00Z`)
const limaDays = (entered) => Math.round((limaDate(Date.now()) - limaDate(entered)) / 86_400_000)

;(async () => {
  const st = C.state()
  const labels = Object.fromEntries(Object.entries(st.pr05?.orders ?? {}).map(([k, v]) => [v.orderId, k]))
  console.log('fake scenarios:', JSON.stringify(C.readScenarios()))
  const rows = await C.shipments(st.acc)
  console.table(rows.map((r) => ({ order: labels[r.order_id] ?? r.order_id.slice(0, 8), guide: `${r.tracking_number}/${r.tracking_code}`, v: r.identifier_version, status: r.logistic_status ?? '-', state: r.tracking_state, fail: r.consecutive_failures, error: r.last_error_kind ? `${r.last_error_kind}:${r.last_error_code}` : '', episode: r.destination_episode, 'días destino': r.logistic_status === 'at_destination' && r.destination_entered_at ? limaDays(r.destination_entered_at) : '-', recojo: r.pickup_state, abandono: r.pickup_abandoned_at ? new Date(r.pickup_abandoned_at).toLocaleString('es-PE', { timeZone: 'America/Lima' }) : '', 'next poll': r.next_poll_at ? new Date(r.next_poll_at).toLocaleString('es-PE', { timeZone: 'America/Lima' }) : '-' })))
  const { data: alerts } = await C.admin.from('order_shipment_alerts').select('order_id, destination_episode, status, due_date, resolved_reason').eq('account_id', st.acc)
  console.log('alerts:'); console.table((alerts ?? []).map((a) => ({ order: labels[a.order_id] ?? a.order_id.slice(0, 8), episode: a.destination_episode, status: a.status, due: a.due_date, resolved: a.resolved_reason ?? '' })))
  const { data: msgs } = await C.admin.from('order_shipment_messages').select('order_id, destination_episode, status, attempt, error_code, next_attempt_at, resolution').eq('account_id', st.acc).order('created_at')
  console.log('customer messages (day 15):'); console.table((msgs ?? []).map((m) => ({ order: labels[m.order_id] ?? m.order_id.slice(0, 8), episode: m.destination_episode, status: m.status, attempt: m.attempt, error: m.error_code ?? '', 'next try': m.next_attempt_at ? new Date(m.next_attempt_at).toLocaleString('es-PE', { timeZone: 'America/Lima' }) : '-', resolution: m.resolution ?? '' })))
  const { data: pev } = await C.admin.from('order_shipment_events').select('order_id, event_type, created_at').eq('account_id', st.acc).or('event_type.like.pickup_%,event_type.like.destination_customer_message_%').order('created_at')
  console.log('pickup / message events:'); console.table((pev ?? []).map((e) => ({ order: labels[e.order_id] ?? e.order_id.slice(0, 8), event: e.event_type, at: new Date(e.created_at).toLocaleString('es-PE', { timeZone: 'America/Lima' }) })))
  const { data: notifs } = await C.admin.from('notifications').select('user_id, order_id, read_at').eq('type', 'shipment_destination_alert').eq('account_id', st.acc)
  const who = Object.fromEntries(Object.values(st.users).map((u) => [u.id, u.label]))
  console.log('alert notifications:'); console.table((notifs ?? []).map((n) => ({ to: who[n.user_id] ?? n.user_id.slice(0, 8), order: labels[n.order_id] ?? '', read: n.read_at ? 'sí' : 'no' })))
})().catch((e) => { console.error(e.message); process.exit(1) })
