/* LOCAL ONLY. QA control of PR-05C: simulates the canonical "pedido completamente finalizado" signal and runs the routing-return tick against the running app.
 * The REAL rule (when an order is "completamente finalizado") belongs to PR-06; nothing in the product declares it today. This script is the ONLY way to do it.
 *   node scripts/qa/pr05/finalize.cjs mark <R1..R5|order_id> [--minutes-ago N]   declares the signal (finalized_at = now - N min; default 0)
 *   node scripts/qa/pr05/finalize.cjs clear <label|order_id>                      the order stops being finalized (before the return ran)
 *   node scripts/qa/pr05/finalize.cjs human-change <label|order_id> <stage>       simulates a LATER human routing decision (commercial|logistics|shared)
 *   node scripts/qa/pr05/finalize.cjs tick                                        one tick of GET /api/conversations/routing/cron (secret from .env.local, never printed)
 *   node scripts/qa/pr05/finalize.cjs status                                      read-only: routing stage, version, signal and audit of R1..R5 */
const C = require('./common.cjs')

const lookup = (st, which) => {
  const hit = st.pr05?.orders?.[String(which).toUpperCase()]
  return hit ?? { orderId: which, conversationId: null, key: String(which).slice(0, 8) }
}
const convOf = async (orderId) => (await C.admin.from('order_confirmations').select('conversation_id').eq('id', orderId).single()).data?.conversation_id

async function tick() {
  const secret = C.L.env.AUTOMATION_CRON_SECRET
  if (!secret) throw new Error('AUTOMATION_CRON_SECRET is not set in .env.local')
  const res = await fetch(`${C.L.APP_URL}/api/conversations/routing/cron`, { headers: { 'x-cron-secret': secret } })
  console.log(res.status, JSON.stringify(await res.json().catch(() => ({}))))
}

;(async () => {
  const [cmd, which, extra] = process.argv.slice(2)
  const st = C.state()
  if (cmd === 'tick') return tick()
  if (cmd === 'status') {
    const rows = []
    for (const [k, o] of Object.entries(st.pr05?.orders ?? {}).filter(([k]) => k.startsWith('R'))) {
      const conv = o.conversationId ?? (await convOf(o.orderId))
      const { data: r } = await C.admin.from('conversation_routing').select('stage, version').eq('conversation_id', conv).maybeSingle()
      const { data: f } = await C.admin.from('order_finalizations').select('finalized_at, return_state, routing_version_at').eq('order_id', o.orderId).maybeSingle()
      const { data: ev } = await C.admin.from('conversation_routing_events').select('from_stage, to_stage, reason, actor_name, created_at').eq('conversation_id', conv).order('created_at')
      rows.push({
        pedido: k, stage: r?.stage ?? 'commercial', version: r?.version ?? '-',
        finalizado: f ? new Date(f.finalized_at).toLocaleTimeString('es-PE', { timeZone: 'America/Lima' }) : '-', retorno: f?.return_state ?? '-',
        'esperado v': f?.routing_version_at ?? '-', auditoria: (ev ?? []).map((e) => `${e.from_stage}→${e.to_stage} (${e.reason}, ${e.actor_name})`).join(' | '),
      })
    }
    return console.table(rows)
  }
  if (!which) throw new Error('usage: mark|clear|human-change|tick|status ...')
  const o = lookup(st, which)
  if (cmd === 'mark') {
    const ago = extra === '--minutes-ago' ? Number(process.argv[5]) : 0
    if (!Number.isFinite(ago) || ago < 0) throw new Error('--minutes-ago needs a number >= 0')
    const { data, error } = await C.admin.rpc('mark_order_finalized', { p_account: st.acc, p_order: o.orderId, p_source: 'qa_simulation', p_actor: null, p_now: new Date(Date.now() - ago * 60_000).toISOString() })
    if (error) throw error
    return console.log(`[${o.key}] mark_order_finalized:`, JSON.stringify(data), `(eligible at finalized_at + 10 min)`)
  }
  if (cmd === 'clear') {
    const { data, error } = await C.admin.rpc('clear_order_finalized', { p_account: st.acc, p_order: o.orderId, p_reason: 'qa_correction', p_now: new Date().toISOString() })
    if (error) throw error
    return console.log(`[${o.key}] clear_order_finalized:`, JSON.stringify(data))
  }
  if (cmd === 'human-change') {
    if (!['commercial', 'logistics', 'shared'].includes(extra)) throw new Error('stage must be commercial|logistics|shared')
    const conv = o.conversationId ?? (await convOf(o.orderId))
    const { data: cur } = await C.admin.from('conversation_routing').select('version').eq('conversation_id', conv).single()
    const { error } = await C.admin.from('conversation_routing').update({ stage: extra, version: cur.version + 1, updated_by: st.users.supervisor.id, updated_at: new Date().toISOString() }).eq('conversation_id', conv)
    if (error) throw error
    return console.log(`[${o.key}] routing set to ${extra} by the QA supervisor (version ${cur.version} -> ${cur.version + 1}); a later cron must NOT overwrite it`)
  }
  throw new Error('usage: mark|clear|human-change|tick|status ...')
})().catch((e) => { console.error(e.message); process.exitCode = 1 })
