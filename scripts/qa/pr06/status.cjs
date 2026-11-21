/* LOCAL ONLY. Read-only snapshot of the PR-06 QA state: per order the financial status, the payments, the delivery, the finalization and the routing of its chat.
 *   node scripts/qa/pr06/status.cjs */
const C = require('../pr05/common.cjs')

;(async () => {
  const st = C.state()
  const mine = Object.entries(st.pr05?.orders ?? {}).filter(([k]) => /^P/.test(k))
  const rows = []
  const payRows = []
  for (const [k, o] of mine) {
    const [{ data: ord }, { data: fin }, { data: pays }, { data: fz }, { data: md }, { data: sh }, { data: rt }] = await Promise.all([
      C.admin.from('order_confirmations').select('price').eq('id', o.orderId).single(),
      C.admin.from('order_financials').select('financial_status, paid_confirmed, paid_at').eq('order_id', o.orderId).maybeSingle(),
      C.admin.from('order_payments').select('amount, kind, status, request_key').eq('order_id', o.orderId).order('created_at'),
      C.admin.from('order_finalizations').select('finalized_at, source, return_state, cleared_at').eq('order_id', o.orderId).maybeSingle(),
      C.admin.from('order_manual_deliveries').select('delivered_at').eq('order_id', o.orderId).maybeSingle(),
      C.admin.from('order_shipments').select('logistic_status, tracking_state').eq('order_id', o.orderId).maybeSingle(),
      C.admin.from('conversation_routing').select('stage, version').eq('conversation_id', o.conversationId).maybeSingle(),
    ])
    const t = (iso) => (iso ? new Date(iso).toLocaleTimeString('es-PE', { timeZone: 'America/Lima' }) : '-')
    rows.push({
      pedido: k, total: ord?.price, estado: fin?.financial_status ?? 'not_tracked', pagado: fin?.paid_confirmed ?? '-', saldo: fin ? Math.max(Number(ord.price) - Number(fin.paid_confirmed), 0) : '-',
      entrega: sh?.logistic_status === 'delivered' ? 'Shalom' : md ? `manual ${t(md.delivered_at)}` : sh ? `${sh.logistic_status ?? '-'}/${sh.tracking_state}` : '-',
      finalizado: fz && !fz.cleared_at ? `${t(fz.finalized_at)} (${fz.return_state})` : fz ? `limpiado (${fz.return_state})` : '-',
      chat: rt?.stage ?? 'commercial', v: rt?.version ?? '-',
    })
    for (const p of pays ?? []) payRows.push({ pedido: k, monto: p.amount, tipo: p.kind, estado: p.status })
  }
  console.table(rows)
  console.log('payments:'); console.table(payRows)
})().catch((e) => { console.error(e.message); process.exit(1) })
