/* LOCAL ONLY. Runs ONE tracking tick against the local app (GET /api/orders/shalom/cron with the cron secret from .env.local; the secret is never printed).
 *   node scripts/qa/pr05/run-cron.cjs [--make-due]
 * --make-due : first marks every ACTIVE shipment of the QA accounts as due now (accelerates the 3 h / 12 h polling intervals for UAT; QA only). */
const C = require('./common.cjs')

;(async () => {
  const st = C.state()
  if (process.argv.includes('--make-due')) {
    const { error } = await C.admin.from('order_shipments').update({ next_poll_at: new Date().toISOString() }).eq('tracking_state', 'active').in('account_id', [st.acc, st.accC]).not('next_poll_at', 'is', null)
    if (error) throw error
  }
  const secret = C.env.AUTOMATION_CRON_SECRET
  if (!secret) throw new Error('AUTOMATION_CRON_SECRET is not set in .env.local')
  const res = await fetch(`${C.L.APP_URL}/api/orders/shalom/cron`, { headers: { 'x-cron-secret': secret } })
  const body = await res.json().catch(() => ({}))
  console.log(res.status, JSON.stringify(body, null, 2))
})().catch((e) => { console.error(e.message); process.exit(1) })
