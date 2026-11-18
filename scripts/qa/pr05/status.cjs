/* LOCAL ONLY. Read-only snapshot of the PR-05 QA state: shipments, alerts, the alert notifications and the fake scenarios in force.
 *   node scripts/qa/pr05/status.cjs */
const C = require('./common.cjs')

;(async () => {
  const st = C.state()
  const labels = Object.fromEntries(Object.entries(st.pr05?.orders ?? {}).map(([k, v]) => [v.orderId, k]))
  console.log('fake scenarios:', JSON.stringify(C.readScenarios()))
  const rows = await C.shipments(st.acc)
  console.table(rows.map((r) => ({ order: labels[r.order_id] ?? r.order_id.slice(0, 8), guide: `${r.tracking_number}/${r.tracking_code}`, v: r.identifier_version, status: r.logistic_status ?? '-', state: r.tracking_state, fail: r.consecutive_failures, error: r.last_error_kind ? `${r.last_error_kind}:${r.last_error_code}` : '', episode: r.destination_episode, 'next poll': r.next_poll_at ? new Date(r.next_poll_at).toLocaleString('es-PE', { timeZone: 'America/Lima' }) : '-' })))
  const { data: alerts } = await C.admin.from('order_shipment_alerts').select('order_id, destination_episode, status, due_date, resolved_reason').eq('account_id', st.acc)
  console.log('alerts:'); console.table((alerts ?? []).map((a) => ({ order: labels[a.order_id] ?? a.order_id.slice(0, 8), episode: a.destination_episode, status: a.status, due: a.due_date, resolved: a.resolved_reason ?? '' })))
  const { data: notifs } = await C.admin.from('notifications').select('user_id, order_id, read_at').eq('type', 'shipment_destination_alert').eq('account_id', st.acc)
  const who = Object.fromEntries(Object.values(st.users).map((u) => [u.id, u.label]))
  console.log('alert notifications:'); console.table((notifs ?? []).map((n) => ({ to: who[n.user_id] ?? n.user_id.slice(0, 8), order: labels[n.order_id] ?? '', read: n.read_at ? 'sí' : 'no' })))
})().catch((e) => { console.error(e.message); process.exit(1) })
