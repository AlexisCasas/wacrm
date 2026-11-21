/* LOCAL ONLY. End-to-end smoke of PR-06 through the REAL running app (HTTP, session cookies of the QA users) on the QA order "PS": payments (S/30 + S/70), proof upload + signed URL,
 * manual delivery, finalization, the +10 minute return and who can read what. It only touches order PS (never P1..P4 nor the earlier UAT).
 *   node scripts/qa/pr06/smoke.cjs */
const crypto = require('node:crypto')
const V = require('../pr04-integrated/verify-chain.cjs')
const C = require('../pr05/common.cjs')

const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) process.exitCode = 1 }
const key = () => `smoke-${crypto.randomUUID()}`

;(async () => {
  const st = C.state()
  const ps = st.pr05?.orders?.PS
  if (!ps) throw new Error('order PS not found: run `node scripts/qa/pr06/seed.cjs prepare` first')
  const base = `/api/orders/payments/orders/${ps.orderId}`
  const conv = `/api/orders/payments/conversation?conversation_id=${ps.conversationId}`

  const p0 = await V.http('logistica', 'GET', base)
  check('logistica sees the panel: tracked, S/100, unpaid', p0.status === 200 && p0.body.tracked && p0.body.total === 100 && p0.body.financial_status === 'unpaid', JSON.stringify({ s: p0.status, st: p0.body.financial_status }))
  for (const label of ['comercial', 'viewer']) check(`${label} has NO access to the panel`, [403, 404].includes((await V.http(label, 'GET', base)).status))
  check('comercial can NOT see the summary while the chat is in Logistica', (await V.http('comercial', 'GET', conv)).status === 404)

  // proof upload (PDF fixture) + signed URL
  const fd = new FormData()
  fd.append('file', new Blob([require('node:fs').readFileSync(require('node:path').join(st.fixtures, 'voucher-pedidoA.pdf'))], { type: 'application/pdf' }), 'comprobante.pdf')
  fd.append('request_key', key())
  const up = await V.http('logistica', 'POST', `${base}/evidence`, fd)
  check('payment proof uploaded to the private bucket', [200, 201].includes(up.status) && up.body.proof?.id, JSON.stringify({ s: up.status, e: up.body.error }))
  const url = await V.http('logistica', 'GET', `/api/orders/payments/documents/${up.body.proof?.id}/url`)
  check('signed URL (no path in the answer), viewer gets none', url.status === 200 && url.body.url && !('storage_path' in url.body) && (await V.http('viewer', 'GET', `/api/orders/payments/documents/${up.body.proof?.id}/url`)).status !== 200)

  const k1 = key()
  const r1 = await V.http('logistica', 'POST', base, { action: 'register', request_key: k1, amount: '30.00', kind: 'advance', method: 'yape', paid_at: new Date(Date.now() - 3600_000).toISOString(), evidence_document_id: up.body.proof?.id })
  const r1b = await V.http('logistica', 'POST', base, { action: 'register', request_key: k1, amount: '30.00', kind: 'advance', method: 'yape', paid_at: new Date(Date.now() - 3600_000).toISOString(), evidence_document_id: up.body.proof?.id })
  check('register S/30 (201) and the RETRY is the same payment (200)', r1.status === 201 && r1b.status === 200 && r1.body.payment_id === r1b.body.payment_id)
  const c1 = await V.http('logistica', 'POST', base, { action: 'confirm', payment_id: r1.body.payment_id })
  check('confirm -> partially_paid, balance 70', c1.status === 200 && c1.body.financial_status === 'partially_paid' && c1.body.pending_balance === 70, JSON.stringify(c1.body))
  const over = await V.http('logistica', 'POST', base, { action: 'register', request_key: key(), amount: '90.00', kind: 'other', paid_at: new Date().toISOString() })
  const overC = await V.http('logistica', 'POST', base, { action: 'confirm', payment_id: over.body.payment_id })
  check('an excess over the balance is BLOCKED for Logistica (409, balance 70)', overC.status === 409 && overC.body.error === 'exceeds_balance' && overC.body.pending_balance === 70)
  check('void is Supervisor only (Logistica 403)', (await V.http('logistica', 'POST', base, { action: 'void', payment_id: r1.body.payment_id, reason: 'x' })).status === 403)
  await V.http('logistica', 'POST', base, { action: 'reject', payment_id: over.body.payment_id, reason: 'prueba de rechazo' })
  const r2 = await V.http('logistica', 'POST', base, { action: 'register', request_key: key(), amount: '70.00', kind: 'balance', paid_at: new Date().toISOString() })
  const c2 = await V.http('logistica', 'POST', base, { action: 'confirm', payment_id: r2.body.payment_id })
  check('confirm S/70 -> paid, balance 0', c2.status === 200 && c2.body.financial_status === 'paid' && c2.body.pending_balance === 0)
  const mid = await V.http('supervisor', 'GET', base)
  check('paid but NOT delivered: no finalization', mid.status === 200 && mid.body.finalization === null && mid.body.is_supervisor === true)

  const del = await V.http('logistica', 'POST', base, { action: 'mark_delivered', note: 'smoke' })
  check('manual delivery (no Shalom shipment)', del.status === 200 && del.body.changed === true, JSON.stringify(del.body))
  const fin = await V.http('supervisor', 'GET', base)
  check('delivered + paid -> finalized (pending return)', fin.body.finalization?.return_state === 'pending', JSON.stringify(fin.body.finalization))

  // +10 minutes without waiting: move finalized_at back (QA clock), then the real cron endpoint
  const { data: f } = await C.admin.from('order_finalizations').select('finalized_at').eq('order_id', ps.orderId).single()
  await C.admin.from('order_finalizations').update({ finalized_at: new Date(Date.parse(f.finalized_at) - 10 * 60_000).toISOString() }).eq('order_id', ps.orderId)
  const secret = C.L.env.AUTOMATION_CRON_SECRET
  const tick = await (await fetch(`${C.L.APP_URL}/api/conversations/routing/cron`, { headers: { 'x-cron-secret': secret } })).json()
  check('routing cron returned the conversation to Comercial', tick.returned >= 1, JSON.stringify(tick))
  const view = await V.http('comercial', 'GET', conv)
  check('Comercial now sees the READ-ONLY summary (paid, balance 0) and it has no payment data', view.status === 200 && view.body.orders?.[0]?.financial_status === 'paid' && !JSON.stringify(view.body).match(/payment_id|evidence|operation/), JSON.stringify(view.body).slice(0, 140))
  const { data: ev } = await C.admin.from('conversation_routing_events').select('reason, actor_name').eq('conversation_id', ps.conversationId).order('created_at')
  check('audit: order_finalized_grace_elapsed by system', ev.some((e) => e.reason === 'order_finalized_grace_elapsed' && e.actor_name === 'system'))
})().catch((e) => { console.error(e.message); process.exitCode = 1 })
