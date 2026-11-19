/* LOCAL ONLY. Drives payments of a QA order from the terminal (the same database functions the app calls, as the QA Logistics / Supervisor user). Optional: every scenario can be
 * done in the UI; this is only to speed the repeated steps.
 *   node scripts/qa/pr06/pay.cjs register <P1..P4|order_id> <amount> [advance|balance|full|other]   -> prints the payment id (status recorded)
 *   node scripts/qa/pr06/pay.cjs confirm <payment_id> [--supervisor] [--reason "..."]
 *   node scripts/qa/pr06/pay.cjs void <payment_id> "<reason>"                                          (Supervisor)
 *   node scripts/qa/pr06/pay.cjs pay <P1..P4|order_id> <amount> [kind]                                 register + confirm in one go
 *   node scripts/qa/pr06/pay.cjs deliver <P2..P4|order_id> ["note"]                                    manual delivery (orders without an active Shalom shipment)
 *   node scripts/qa/pr06/pay.cjs shift <P1..P4|order_id> <minutes>                                     moves finalized_at back N minutes (QA clock: +9 / +10 without waiting)
 *   node scripts/qa/pr06/pay.cjs tick                                                                   one tick of the routing-return cron (sweeper + return) against the app */
const crypto = require('node:crypto')
const C = require('../pr05/common.cjs')

const st = C.state()
const orderOf = (w) => st.pr05?.orders?.[String(w).toUpperCase()]?.orderId ?? w
const actor = (supervisor) => (supervisor ? st.users.supervisor : st.users.logistica).id
const rpc = async (name, args) => {
  const { data, error } = await C.admin.rpc(name, args)
  if (error) throw new Error(`${name}: ${error.message}`)
  return data
}
const register = (order, amount, kind = 'advance') =>
  rpc('register_order_payment', { p_account: st.acc, p_actor: actor(false), p_order: order, p_request_key: `qa-${crypto.randomUUID()}`, p_amount: String(amount), p_kind: kind, p_method: 'qa', p_operation_number: null, p_paid_at: new Date().toISOString(), p_evidence: null, p_notes: 'QA', p_source: 'manual', p_now: new Date().toISOString() })
const confirm = (payment, supervisor, reason) => rpc('confirm_order_payment', { p_account: st.acc, p_actor: actor(supervisor), p_payment: payment, p_expected_version: null, p_overpayment_reason: reason ?? null, p_now: new Date().toISOString() })

;(async () => {
  const [cmd, a, b, c] = process.argv.slice(2)
  if (cmd === 'register') return console.log(JSON.stringify(await register(orderOf(a), b, c)))
  if (cmd === 'confirm') return console.log(JSON.stringify(await confirm(a, process.argv.includes('--supervisor'), process.argv.includes('--reason') ? process.argv[process.argv.indexOf('--reason') + 1] : null)))
  if (cmd === 'void') return console.log(JSON.stringify(await rpc('void_order_payment', { p_account: st.acc, p_actor: actor(true), p_payment: a, p_expected_version: null, p_reason: b, p_now: new Date().toISOString() })))
  if (cmd === 'pay') {
    const r = await register(orderOf(a), b, c)
    if (!r.ok) return console.log(JSON.stringify(r))
    return console.log(JSON.stringify(await confirm(r.payment_id, false, null)))
  }
  if (cmd === 'deliver') return console.log(JSON.stringify(await rpc('mark_order_delivered_manual', { p_account: st.acc, p_actor: actor(false), p_order: orderOf(a), p_note: b ?? null, p_now: new Date().toISOString() })))
  if (cmd === 'shift') {
    const { data: f, error } = await C.admin.from('order_finalizations').select('finalized_at, return_state').eq('order_id', orderOf(a)).maybeSingle()
    if (error || !f) throw new Error('that order has no finalization')
    if (f.return_state !== 'pending') throw new Error(`the finalization is already ${f.return_state}`)
    const moved = new Date(Date.parse(f.finalized_at) - Number(b) * 60_000).toISOString()
    const u = await C.admin.from('order_finalizations').update({ finalized_at: moved }).eq('order_id', orderOf(a))
    if (u.error) throw u.error
    return console.log(`finalized_at: ${f.finalized_at} -> ${moved}`)
  }
  if (cmd === 'tick') {
    const secret = C.L.env.AUTOMATION_CRON_SECRET
    if (!secret) throw new Error('AUTOMATION_CRON_SECRET is not set in .env.local')
    const res = await fetch(`${C.L.APP_URL}/api/conversations/routing/cron`, { headers: { 'x-cron-secret': secret } })
    return console.log(res.status, JSON.stringify(await res.json().catch(() => ({}))))
  }
  throw new Error('usage: register|confirm|void|pay|deliver|shift|tick ...')
})().catch((e) => { console.error(e.message); process.exitCode = 1 })
