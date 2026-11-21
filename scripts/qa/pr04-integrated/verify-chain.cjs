/* LOCAL ONLY. Drives one order through the whole PR-04 chain through the REAL HTTP API as a given QA user (cookie session), printing every step.
 *   node verify-chain.cjs <userLabel> <orderLabel|new> <success|failed|uncertain>   */
const L = require('./lib.cjs')
const S = require('./seed.cjs')
const { admin, fs, path } = L

const st = L.readState()
const rid = () => Math.random().toString(36).slice(2, 8)
const sessions = {}
async function as(label) {
  if (!sessions[label]) sessions[label] = await L.login(st.users[label].email, st.password)
  return sessions[label]
}
async function http(label, method, url, body, opts = {}) {
  const s = await as(label)
  const headers = { cookie: s.cookie }
  let payload
  if (body instanceof FormData) payload = body
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body) }
  const res = await fetch(L.APP_URL + url, { method, headers, body: payload, redirect: 'manual' })
  let json = null
  const text = await res.text()
  try { json = JSON.parse(text) } catch { json = text.slice(0, 120) }
  return { status: res.status, body: json }
}
const upload = (label, orderId, file, key, extra = {}) => {
  const fd = new FormData()
  fd.append('file', new Blob([fs.readFileSync(path.join(st.fixtures, file))], { type: 'application/pdf' }), file)
  fd.append('request_key', key)
  if (orderId) fd.append('order_id', orderId)
  for (const [k, v] of Object.entries(extra)) fd.append(k, v)
  return http(label, 'POST', '/api/orders/logistics/documents', fd)
}
const setMode = (m) => fs.writeFileSync('C:\\WACRM-LOCAL-QA\\meta-mode.txt', m)

/** A fresh synthetic order (real RPC, PR-03 routing applies) with a chat that has one image of its own. */
async function freshOrder(tag, { media = true } = {}) {
  const conv = await S.mkConversation(st.acc, st.users.owner.id, `Verif ${tag}`, `5190${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, [['customer', `hola ${tag}`], ['agent', 'ok']])
  const mediaId = media ? await S.addMedia(conv.conversationId, st.acc, path.join(st.fixtures, 'media-A-correcta.png'), `v-${tag}-${rid()}`) : null
  const order = await S.confirmOrder(st.acc, st.users.comercial, conv, `verif-${tag}-${rid()}`, S.single(`Verif ${tag}`, String(20000000 + Math.floor(Math.random() * 7e7)), `5197${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, 'Producto Verif', 1, 9, 'Lima'))
  return { order, conv: conv.conversationId, mediaId }
}

async function chain(label, o, mode, log = console.log) {
  const out = {}
  const step = (name, r) => { out[name] = r.status; log(`  ${name.padEnd(22)} ${r.status} ${typeof r.body === 'string' ? r.body : JSON.stringify(r.body).slice(0, 130)}`); return r }
  const up = step('upload', await upload(label, o.order, 'voucher-pedidoA.pdf', `qa-pr04-v-${rid()}`, { allow_duplicate: 'true' }))
  const docId = up.body?.document?.id
  step('ocr', await http(label, 'POST', `/api/orders/logistics/documents/${docId}/ocr`, {}))
  const det = step('detail', await http(label, 'GET', `/api/orders/logistics/documents/${docId}`))
  step('url', await http(label, 'GET', `/api/orders/logistics/documents/${docId}/url`))
  const rv = det.body?.document?.row_version
  const fix = { dni: '11112222', phone: '51911112222', customer_name: 'Cliente Prueba', amount: '10.00' }
  const cor = step('correct', await http(label, 'POST', `/api/orders/logistics/documents/${docId}/review`, { action: 'correct', expected_row_version: rv, reviewed_data: fix }))
  const rv2 = cor.body?.document?.row_version ?? rv + 1
  step('validate', await http(label, 'POST', `/api/orders/logistics/documents/${docId}/review`, { action: 'validate', expected_row_version: rv2, reviewed_data: fix }))
  step('start_packaging', await http(label, 'POST', `/api/orders/logistics/orders/${o.order}/packaging`, { action: 'start' }))
  const cm = step('chat_media', await http(label, 'GET', `/api/orders/logistics/orders/${o.order}/chat-media`))
  const mid = cm.body?.items?.[0]?.message_id ?? cm.body?.media?.[0]?.message_id ?? o.mediaId
  step('select_evidence', await http(label, 'POST', `/api/orders/logistics/orders/${o.order}/evidence`, { message_id: mid, request_key: `qa-pr04-ev-${rid()}` }))
  setMode(mode)
  const key = `qa-pr04-tpl-${rid()}`
  step(`template(${mode})`, await http(label, 'POST', `/api/orders/logistics/orders/${o.order}/packaging`, { action: 'send_template', request_key: key }))
  out.key = key
  step('panel/trace', await http(label, 'GET', `/api/orders/logistics/orders/${o.order}`))
  setMode('success')
  return out
}

module.exports = { st, as, http, upload, freshOrder, chain, setMode, rid }
if (require.main === module) {
  ;(async () => {
    const [label, , mode] = process.argv.slice(2)
    const o = await freshOrder('chain')
    console.log('order', o.order)
    await chain(label, o, mode || 'success')
    process.exit(0)
  })().catch((e) => { console.error(e); process.exit(1) })
}
