/* LOCAL ONLY. Simulates the passing of days for the 15-day En destino alert: moves destination_entered_at of one shipment back N days (QA only; the
 * product never edits it). Then run `run-cron.cjs` to evaluate the alert.
 *   node scripts/qa/pr05/advance.cjs <label A..I | order_id> <days>        e.g.  advance.cjs A 14   (day 14: no alert)   then   advance.cjs A 1   (day 15: alert)
 *   node scripts/qa/pr05/advance.cjs <label | order_id> <days> --absolute   sets the day count itself: `G 20 --absolute` = exactly 20 calendar days En destino (PR-05B: day 20 = En abandono)
 * The shipment must already be En destino (that is when the episode starts). */
const C = require('./common.cjs')

;(async () => {
  const [which, daysRaw] = process.argv.slice(2)
  const days = Number(daysRaw)
  if (!which || !Number.isFinite(days) || (days === 0 && !process.argv.includes('--absolute'))) throw new Error('usage: advance.cjs <label|order_id> <days>')
  const st = C.state()
  const orderId = st.pr05?.orders?.[which.toUpperCase()]?.orderId ?? which
  const { data: s, error } = await C.admin.from('order_shipments').select('id, logistic_status, destination_entered_at').eq('order_id', orderId).single()
  if (error || !s) throw new Error('shipment not found')
  if (s.logistic_status !== 'at_destination' || !s.destination_entered_at) throw new Error(`the shipment is not En destino yet (status: ${s.logistic_status ?? 'none'})`)
  const absolute = process.argv.includes('--absolute')
  const moved = new Date((absolute ? Date.now() : Date.parse(s.destination_entered_at)) - days * 86_400_000).toISOString()
  const u = await C.admin.from('order_shipments').update({ destination_entered_at: moved }).eq('id', s.id)
  if (u.error) throw u.error
  console.log(`destination_entered_at: ${s.destination_entered_at} -> ${moved}`)
})().catch((e) => { console.error(e.message); process.exit(1) })
