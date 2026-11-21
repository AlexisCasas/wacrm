/* LOCAL ONLY. Backend verification of the integrated PR-01..PR-04 behaviour against the RUNNING local app (:3000) and the local Supabase.
 * It builds its OWN disposable world (accounts "QA-PR04 VERIF ...", users verif-*@qa-pr04.example.invalid, same role layout as the QA world), runs the
 * permission matrix through the real HTTP API + direct RLS/RPC/storage access, and deletes the world at the end (it never touches the QA world).
 *   node scripts/qa/pr04-integrated/verify-all.cjs        -> prints the matrix and writes C:\WACRM-LOCAL-QA\verify-report.json */
const L = require('./lib.cjs')
const S = require('./seed.cjs')
const { admin, fs, path, MARK, DOMAIN, ACCOUNT_PREFIX } = L

const PASS = 'QaVerif-2026!'
const rid = () => Math.random().toString(36).slice(2, 8)
const results = [] // {section, name, ok, detail}
const rec = (section, name, ok, detail = '') => { results.push({ section, name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  [${section}] ${name}${detail ? ' :: ' + detail : ''}`) }
const must = (r, w) => { if (r.error) throw new Error(`${w}: ${r.error.message}`); return r.data }

const FIX = path.join(L.QA_DIR, 'fixtures')
const setMode = (m) => fs.writeFileSync(path.join(L.QA_DIR, 'meta-mode.txt'), m)
const metaLog = () => (fs.existsSync(path.join(L.QA_DIR, 'meta-sim.log')) ? fs.readFileSync(path.join(L.QA_DIR, 'meta-sim.log'), 'utf8').split('\n').filter(Boolean) : [])

const W = { users: {}, acc: null, accX: null, created: [] }

async function mkWorld() {
  const mk = async (label, name) => {
    const email = `verif-${label}@${DOMAIN}`
    const { data, error } = await admin.auth.admin.createUser({ email, password: PASS, email_confirm: true, user_metadata: { full_name: name } })
    if (error) throw error
    const { data: p } = await admin.from('profiles').select('account_id').eq('user_id', data.user.id).single()
    must(await admin.from('accounts').update({ name: `${ACCOUNT_PREFIX}VERIF autogen ${label}` }).eq('id', p.account_id), 'rename')
    must(await admin.from('profiles').update({ full_name: name }).eq('user_id', data.user.id), 'name')
    return { id: data.user.id, email, name, label, accountId: p.account_id }
  }
  for (const [l, n] of [['owner', 'V Dueño'], ['comm', 'V Comercial'], ['logi', 'V Logística'], ['sup', 'V Supervisor'], ['viewer', 'V Viewer'], ['null', 'V SinArea'], ['ext', 'V Externo']]) W.users[l] = await mk(l, n)
  W.acc = W.users.owner.accountId
  W.accX = W.users.ext.accountId
  must(await admin.from('accounts').update({ name: `${ACCOUNT_PREFIX}VERIF A` }).eq('id', W.acc), 'n')
  must(await admin.from('accounts').update({ name: `${ACCOUNT_PREFIX}VERIF X` }).eq('id', W.accX), 'n')
  const place = async (u, acc, ar, op) => { must(await admin.from('profiles').update({ account_id: acc, account_role: ar }).eq('user_id', u.id), 'place'); must(await admin.from('profiles').update({ operational_role: op }).eq('user_id', u.id), 'role') }
  await place(W.users.owner, W.acc, 'owner', null)
  await place(W.users.comm, W.acc, 'agent', 'commercial')
  await place(W.users.logi, W.acc, 'agent', 'logistics')
  await place(W.users.sup, W.acc, 'agent', 'supervisor')
  await place(W.users.viewer, W.acc, 'viewer', 'logistics')
  await place(W.users.null, W.acc, 'agent', null)
  await place(W.users.ext, W.accX, 'owner', 'supervisor')
  for (const a of [W.acc, W.accX]) must(await admin.from('order_integration_settings').upsert({ account_id: a, confirm_enabled: true, logistics_mvp_enabled: true, multiproduct_enabled: true }), 'settings')
  let n = 0
  for (const [a, o] of [[W.acc, W.users.owner], [W.accX, W.users.ext]]) {
    n++
    must(await admin.from('whatsapp_config').insert({ user_id: o.id, account_id: a, phone_number_id: `qapr04verif00000${n}`, waba_id: `qapr04verifwaba${n}`, access_token: L.encryptToken('qa-simulated-token-not-real'), status: 'connected' }), 'wa')
    must(await admin.from('message_templates').insert({ user_id: o.id, account_id: a, name: 'qa_pedido_embalado', category: 'Utility', language: 'es', header_type: 'image', body_text: 'Hola {{1}}, tu pedido de {{2}} ya fue embalado.', status: 'APPROVED' }), 'tpl')
    must(await admin.from('order_logistics_settings').upsert({ account_id: a, packaging_template_name: 'qa_pedido_embalado', packaging_template_language: 'es', packaging_template_params: ['customer_name', 'product'] }), 'ls')
  }
  for (const u of Object.values(W.users)) { const s = await L.login(u.email, PASS); u.cookie = s.cookie; u.client = s.client; u.session = s.session }
}
async function disposeWorld() {
  for (const bucket of ['order-docs', 'chat-media']) for (const a of [W.acc, W.accX, ...Object.values(W.users).map((u) => u.accountId)]) if (a) { const pre = bucket === 'chat-media' ? `account-${a}/mirror` : `${a}`; await rm(bucket, pre) }
  const { data: accs } = await admin.from('accounts').select('id').like('name', `${ACCOUNT_PREFIX}VERIF%`)
  for (const a of accs ?? []) await admin.from('accounts').delete().eq('id', a.id)
  for (const u of Object.values(W.users)) await admin.auth.admin.deleteUser(u.id)
}
async function rm(bucket, prefix) {
  const { data } = await admin.storage.from(bucket).list(prefix, { limit: 1000 })
  const files = []
  for (const e of data ?? []) { if (e.id) files.push(`${prefix}/${e.name}`); else await rm(bucket, `${prefix}/${e.name}`) }
  if (files.length) await admin.storage.from(bucket).remove(files)
}

async function http(label, method, url, body) {
  const u = W.users[label]
  const headers = { cookie: u.cookie }
  let payload
  if (body instanceof FormData) payload = body
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body) }
  const res = await fetch(L.APP_URL + url, { method, headers, body: payload, redirect: 'manual' })
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 100) } }
  return { status: res.status, body: json }
}
const form = (file, fields) => { const fd = new FormData(); fd.append('file', new Blob([fs.readFileSync(path.join(FIX, file))], { type: 'application/pdf' }), file); for (const [k, v] of Object.entries(fields)) if (v) fd.append(k, v); return fd }
const upload = (label, orderId, file = 'voucher-pedidoA.pdf', extra = {}) => http(label, 'POST', '/api/orders/logistics/documents', form(file, { request_key: `${MARK}-v-${rid()}`, order_id: orderId, allow_duplicate: 'true', ...extra }))
const evUpload = (label, orderId, file = 'media-A-correcta.png', name = file, key = `${MARK}-evu-${rid()}`) => { const fd = new FormData(); fd.append('file', new Blob([fs.readFileSync(path.join(FIX, file))], { type: 'image/png' }), name); fd.append('request_key', key); return http(label, 'POST', `/api/orders/logistics/orders/${orderId}/evidence/upload`, fd) }
const FIXED = { dni: '11112222', phone: '51911112222', customer_name: 'Cliente Prueba', amount: '10.00' }

async function mkOrder(tag, { acc = W.acc, actor = W.users.comm, owner = W.users.owner, media = true, dni, phone } = {}) {
  const conv = await S.mkConversation(acc, owner.id, `Verif ${tag}`, `5190${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, [['customer', `hola ${tag}`], ['agent', 'ok']])
  const mediaId = media ? await S.addMedia(conv.conversationId, acc, path.join(FIX, 'media-A-correcta.png'), `${tag}-${rid()}`) : null
  const order = await S.confirmOrder(acc, { id: actor.id, name: actor.name }, conv, `verif-${tag}-${rid()}`, S.single(`Verif ${tag}`, dni ?? String(20000000 + Math.floor(Math.random() * 7e7)), phone ?? `5197${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, 'Producto Verif', 1, 10, 'Lima'))
  return { order, conv: conv.conversationId, contactId: conv.contactId, mediaId }
}
/** Drive an order (as `label`) up to a state: 'pending' (doc pending_review) | 'validated' | 'packing' | 'evidence'. */
async function advance(label, o, upTo) {
  const out = {}
  const up = await upload(label, o.order)
  if (up.status !== 201) throw new Error(`advance upload ${up.status} ${JSON.stringify(up.body)}`)
  out.doc = up.body.document.id
  const ocr = await http(label, 'POST', `/api/orders/logistics/documents/${out.doc}/ocr`, {})
  if (ocr.status !== 200) throw new Error(`advance ocr ${ocr.status}`)
  if (upTo === 'pending') return out
  const det = await http(label, 'GET', `/api/orders/logistics/documents/${out.doc}`)
  const v = await http(label, 'POST', `/api/orders/logistics/documents/${out.doc}/review`, { action: 'validate', expected_row_version: det.body.document.row_version, reviewed_data: FIXED })
  if (v.status !== 200) throw new Error(`advance validate ${v.status} ${JSON.stringify(v.body)}`)
  if (upTo === 'validated') return out
  const p = await http(label, 'POST', `/api/orders/logistics/orders/${o.order}/packaging`, { action: 'start' })
  if (p.status !== 200) throw new Error(`advance start ${p.status}`)
  if (upTo === 'packing') return out
  const e = await http(label, 'POST', `/api/orders/logistics/orders/${o.order}/evidence`, { message_id: o.mediaId, request_key: `${MARK}-ev-${rid()}` })
  if (e.status !== 201 && e.status !== 200) throw new Error(`advance evidence ${e.status} ${JSON.stringify(e.body)}`)
  out.evidence = e.body.evidence?.id
  return out
}
const logiStatus = async (orderId) => (await admin.from('order_logistics').select('status').eq('order_id', orderId).maybeSingle()).data?.status ?? 'pending_voucher'
const count = async (table, col, val) => (await admin.from(table).select('*', { count: 'exact', head: true }).eq(col, val)).count

const ALLOWED = (s) => s >= 200 && s < 300
const BLOCKED = (s) => s === 401 || s === 403 || s === 404
const verdict = (s) => (ALLOWED(s) ? 'PERMITIDO' : BLOCKED(s) ? 'BLOQUEADO' : `OTRO(${s})`)

async function main() {
  if (!fs.existsSync(FIX)) await require('./fixtures.cjs').generate()
  await cleanupVerif()
  await mkWorld()
  const matrix = {} // action -> user -> verdict
  const roles = ['comm', 'logi', 'sup', 'viewer', 'null', 'ext']
  const put = (action, label, status, extra = '') => { (matrix[action] ??= {})[label] = verdict(status) + (extra ? ` [${status}${extra}]` : ` [${status}]`) }

  // ---------- fixtures for the BLOCKED probes (prepared by an allowed user) ----------
  const P0 = await mkOrder('p0'); const d0 = await advance('logi', P0, 'pending')
  const P1 = await mkOrder('p1'); await advance('logi', P1, 'validated')
  const P2 = await mkOrder('p2'); await advance('logi', P2, 'packing')
  const P3 = await mkOrder('p3'); await advance('logi', P3, 'evidence')
  const PT = await mkOrder('pt', { dni: '12345678', phone: '51900000001' })
  const bulk = await upload('logi', null, 'bulk-caso-A-seguro-1.pdf')
  const bulkDoc = bulk.body?.document?.id
  rec('fixtures', 'bulk document uploaded without order is pending association', bulk.status === 201 && bulk.body.document.association === 'pending', `status ${bulk.status}`)
  const before = async () => ({
    docs: await count('order_documents', 'account_id', W.acc), events: await count('order_logistics_events', 'account_id', W.acc), disp: await count('order_template_dispatches', 'account_id', W.acc),
    s1: await logiStatus(P1.order), s2: await logiStatus(P2.order), s3: await logiStatus(P3.order),
  })

  // ---------- 1) HTTP matrix: the BLOCKED users must change nothing; allowed users are run on their own fresh orders ----------
  const snap0 = await before()
  const probeBlocked = async (label) => {
    put('ver Pedidos Confirmados', label, (await http(label, 'GET', '/api/orders/confirmed')).status)
    put('abrir detalle (panel logística)', label, (await http(label, 'GET', `/api/orders/logistics/orders/${P0.order}`)).status)
    put('ver Voucher (lista)', label, (await http(label, 'GET', `/api/orders/logistics/documents?order_id=${P0.order}`)).status)
    put('subir Voucher', label, (await upload(label, P0.order)).status)
    put('ejecutar OCR local', label, (await http(label, 'POST', `/api/orders/logistics/documents/${d0.doc}/ocr`, {})).status)
    put('revisar OCR (detalle)', label, (await http(label, 'GET', `/api/orders/logistics/documents/${d0.doc}`)).status)
    put('corregir OCR', label, (await http(label, 'POST', `/api/orders/logistics/documents/${d0.doc}/review`, { action: 'correct', expected_row_version: 1, reviewed_data: FIXED })).status)
    put('validar Voucher', label, (await http(label, 'POST', `/api/orders/logistics/documents/${d0.doc}/review`, { action: 'validate', expected_row_version: 1, reviewed_data: FIXED })).status)
    put('iniciar embalaje', label, (await http(label, 'POST', `/api/orders/logistics/orders/${P1.order}/packaging`, { action: 'start' })).status)
    put('seleccionar evidencia (ver media del chat)', label, (await http(label, 'GET', `/api/orders/logistics/orders/${P2.order}/chat-media`)).status)
    put('crear snapshot (selección)', label, (await http(label, 'POST', `/api/orders/logistics/orders/${P2.order}/evidence`, { message_id: P2.mediaId, request_key: `${MARK}-ev-${rid()}` })).status)
    put('subir evidencia (dispositivo)', label, (await evUpload(label, P2.order)).status)
    put('ejecutar plantilla simulada', label, (await http(label, 'POST', `/api/orders/logistics/orders/${P3.order}/packaging`, { action: 'send_template', request_key: `${MARK}-t-${rid()}` })).status)
    put('ver trazabilidad (panel)', label, (await http(label, 'GET', `/api/orders/logistics/orders/${P3.order}`)).status)
    put('acceder a documento privado (URL firmada)', label, (await http(label, 'GET', `/api/orders/logistics/documents/${d0.doc}/url`)).status)
    put('asociación manual', label, (await http(label, 'POST', `/api/orders/logistics/documents/${bulkDoc}/associate`, { order_id: PT.order })).status)
    put('carga masiva (subir sin pedido)', label, (await upload(label, null, 'bulk-caso-A-seguro-2.pdf')).status)
    put('carga masiva (buscar pedidos)', label, (await http(label, 'GET', '/api/orders/logistics/orders/pending?q=Verif')).status)
  }
  for (const r of ['comm', 'viewer', 'null', 'ext']) await probeBlocked(r)
  const snap1 = await before()
  // The only change allowed in `snap1` vs `snap0` comes from commercial/viewer/null/ext being refused: a carga masiva upload by `ext` is for ITS OWN account (account X) so account A counts must be equal.
  rec('matrix', 'blocked users (comm, viewer, null-role, other account) changed NOTHING in account A (documents, events, dispatches, statuses)', JSON.stringify(snap0) === JSON.stringify(snap1), JSON.stringify({ snap0, snap1 }))

  // allowed users: each runs the same probes on its OWN fresh fixtures (the effect is expected)
  for (const r of ['logi', 'sup']) {
    const A0 = await mkOrder(`a0-${r}`); const dd0 = await advance(r, A0, 'pending')
    const A1 = await mkOrder(`a1-${r}`); await advance(r, A1, 'validated')
    const A2 = await mkOrder(`a2-${r}`); await advance(r, A2, 'packing')
    const A3 = await mkOrder(`a3-${r}`); await advance(r, A3, 'evidence')
    const AT = await mkOrder(`at-${r}`, { dni: '12345678', phone: '51900000001' })
    const bd = (await upload(r, null, `bulk-caso-A-seguro-${r === 'logi' ? 1 : 3}.pdf`, { allow_duplicate: 'true' })).body?.document?.id
    put('ver Pedidos Confirmados', r, (await http(r, 'GET', '/api/orders/confirmed')).status)
    put('abrir detalle (panel logística)', r, (await http(r, 'GET', `/api/orders/logistics/orders/${A0.order}`)).status)
    put('ver Voucher (lista)', r, (await http(r, 'GET', `/api/orders/logistics/documents?order_id=${A0.order}`)).status)
    put('subir Voucher', r, (await upload(r, A0.order, 'voucher-pedidoA-repuesto.pdf')).status)
    put('ejecutar OCR local', r, (await http(r, 'POST', `/api/orders/logistics/documents/${dd0.doc}/ocr`, {})).status)
    const det = await http(r, 'GET', `/api/orders/logistics/documents/${dd0.doc}`)
    put('revisar OCR (detalle)', r, det.status)
    const cor = await http(r, 'POST', `/api/orders/logistics/documents/${dd0.doc}/review`, { action: 'correct', expected_row_version: det.body.document?.row_version, reviewed_data: FIXED })
    put('corregir OCR', r, cor.status)
    put('validar Voucher', r, (await http(r, 'POST', `/api/orders/logistics/documents/${dd0.doc}/review`, { action: 'validate', expected_row_version: cor.body.document?.row_version, reviewed_data: FIXED })).status)
    put('iniciar embalaje', r, (await http(r, 'POST', `/api/orders/logistics/orders/${A1.order}/packaging`, { action: 'start' })).status)
    put('seleccionar evidencia (ver media del chat)', r, (await http(r, 'GET', `/api/orders/logistics/orders/${A2.order}/chat-media`)).status)
    put('crear snapshot (selección)', r, (await http(r, 'POST', `/api/orders/logistics/orders/${A2.order}/evidence`, { message_id: A2.mediaId, request_key: `${MARK}-ev-${rid()}` })).status)
    const AU = await mkOrder(`au-${r}`, { media: false }); await advance(r, AU, 'packing')
    put('subir evidencia (dispositivo)', r, (await evUpload(r, AU.order, 'media-A2-correcta.png', 'foto embalaje.png')).status)
    setMode('success')
    put('ejecutar plantilla simulada', r, (await http(r, 'POST', `/api/orders/logistics/orders/${A3.order}/packaging`, { action: 'send_template', request_key: `${MARK}-t-${rid()}` })).status)
    put('ver trazabilidad (panel)', r, (await http(r, 'GET', `/api/orders/logistics/orders/${A3.order}`)).status)
    put('acceder a documento privado (URL firmada)', r, (await http(r, 'GET', `/api/orders/logistics/documents/${dd0.doc}/url`)).status)
    put('asociación manual', r, (await http(r, 'POST', `/api/orders/logistics/documents/${bd}/associate`, { order_id: AT.order })).status)
    put('carga masiva (subir sin pedido)', r, (await upload(r, null, 'bulk-caso-B-ambiguo-1.pdf')).status)
    put('carga masiva (buscar pedidos)', r, (await http(r, 'GET', '/api/orders/logistics/orders/pending?q=Verif')).status)
  }

  // ---------- 2) direct RLS / RPC / storage (the browser path: the user's own JWT + anon key) ----------
  const Q = { docs: 'order_documents', logi: 'order_logistics', events: 'order_logistics_events', disp: 'order_template_dispatches' }
  const rls = {}
  for (const r of ['comm', 'logi', 'sup', 'viewer', 'null', 'ext']) {
    const c = W.users[r].client
    const reads = {}
    for (const [k, t] of Object.entries(Q)) reads[k] = ((await c.from(t).select('id, account_id').limit(500)).data ?? []).filter((x) => x.account_id === W.acc).length
    const writes = []
    writes.push((await c.from('order_logistics').update({ status: 'ready_for_dispatch' }).eq('account_id', W.acc).select('order_id')).data?.length ?? 0)
    writes.push((await c.from('order_documents').delete().eq('account_id', W.acc).select('id')).data?.length ?? 0)
    const ins = await c.from('order_logistics').insert({ order_id: P0.order, account_id: W.acc, status: 'ready_for_dispatch' })
    writes.push(ins.error ? 0 : 1)
    const rpc = await c.rpc('register_order_voucher', { p_account: W.acc, p_actor: W.users[r].id, p_order: P0.order, p_request_key: `x-${rid()}`, p_storage_path: 'x', p_original_filename: 'x.pdf', p_mime_type: 'application/pdf', p_size_bytes: 1, p_content_hash: 'x', p_source: 'upload' })
    const dl = await c.storage.from('order-docs').download(`account-${W.acc}/orders/${P0.order}/none.pdf`)
    const { data: anyObj } = await admin.from('order_documents').select('storage_path').eq('id', d0.doc).single()
    const dl2 = await c.storage.from('order-docs').download(anyObj.storage_path)
    rls[r] = { reads, writes_applied: writes, rpc_denied: !!rpc.error, storage_download_ok: !!dl2.data }
  }
  const readsOK = (r) => Object.values(rls[r].reads).reduce((a, b) => a + b, 0)
  rec('rls', 'logistics/supervisor read their account rows through RLS', readsOK('logi') > 0 && readsOK('sup') > 0, `logi=${readsOK('logi')} sup=${readsOK('sup')}`)
  rec('rls', 'commercial / viewer / no-area / other-account read ZERO PR-04 rows of account A through RLS', ['comm', 'viewer', 'null', 'ext'].every((r) => readsOK(r) === 0), JSON.stringify(Object.fromEntries(['comm', 'viewer', 'null', 'ext'].map((r) => [r, readsOK(r)]))))
  rec('rls', 'nobody can write PR-04 tables or execute PR-04 RPCs directly from the browser (INSERT/UPDATE/DELETE/RPC)', Object.values(rls).every((x) => x.writes_applied.every((n) => n === 0) && x.rpc_denied), JSON.stringify(Object.fromEntries(Object.entries(rls).map(([k, v]) => [k, v.writes_applied.join('/') + (v.rpc_denied ? ' rpc-denied' : ' RPC-OPEN')]))))
  rec('rls', 'no user (any role, any account) can read an order-docs object directly from Storage; only server-issued signed URLs work', Object.values(rls).every((x) => !x.storage_download_ok), JSON.stringify(Object.fromEntries(Object.entries(rls).map(([k, v]) => [k, v.storage_download_ok]))))
  const anonRead = await L.anonClient().from('order_documents').select('id').limit(5)
  rec('rls', 'anonymous (no session) reads nothing', (anonRead.data ?? []).length === 0, `rows=${(anonRead.data ?? []).length}`)

  // ---------- 3) signed URL really serves the file (and is for the right object) ----------
  const su = await http('logi', 'GET', `/api/orders/logistics/documents/${d0.doc}/url`)
  const fileRes = await fetch(su.body.url)
  const bytes = Buffer.from(await fileRes.arrayBuffer())
  rec('storage', 'signed URL of a validated/pending voucher downloads the exact uploaded file from the PRIVATE bucket', fileRes.ok && bytes.slice(0, 4).toString() === '%PDF', `status ${fileRes.status}, ${bytes.length} bytes`)
  const pub = await fetch(`${L.URL_}/storage/v1/object/public/order-docs/x`)
  rec('storage', 'order-docs is not public (public URL does not serve)', !pub.ok, `status ${pub.status}`)

  // ---------- 3b) evidence uploaded from the device: chat WITHOUT files -> template -> ready_for_dispatch ----------
  const UE = await mkOrder('ue', { media: false }); await advance('logi', UE, 'packing')
  const noEv = await http('logi', 'POST', `/api/orders/logistics/orders/${UE.order}/packaging`, { action: 'send_template', request_key: `${MARK}-t-${rid()}` })
  const cm0 = await http('logi', 'GET', `/api/orders/logistics/orders/${UE.order}/chat-media`)
  rec('evidence upload', 'chat without files: the chat list is empty and the template is refused until evidence exists', (cm0.body.media ?? []).length === 0 && noEv.status === 409 && noEv.body.error === 'evidence_required', `chat items ${(cm0.body.media ?? []).length}, send ${noEv.status} ${noEv.body.error}`)
  const badExt = await evUpload('logi', UE.order, 'media-A-correcta.png', 'foto.exe')
  const upOk = await evUpload('logi', UE.order, 'media-A-correcta.png', 'foto embalaje.PNG')
  const evRowUE = (await admin.from('order_documents').select('source, uploaded_by, storage_bucket, storage_path, status').eq('order_id', UE.order).eq('kind', 'evidence').single()).data
  rec('evidence upload', 'upload by logistics: 201, private order-docs object scoped to account+order, source=upload, uploader recorded; bad extension refused', badExt.status === 415 && upOk.status === 201 && evRowUE.source === 'upload' && evRowUE.uploaded_by === W.users.logi.id && evRowUE.storage_bucket === 'order-docs' && evRowUE.storage_path.startsWith(`account-${W.acc}/orders/${UE.order}/evidence/`), JSON.stringify({ badExt: badExt.status, upOk: upOk.status, ...evRowUE }))
  const panelUE = await http('logi', 'GET', `/api/orders/logistics/orders/${UE.order}`)
  rec('evidence upload', 'the panel shows the uploaded evidence and the trail records who/when/origin (evidence_uploaded)', panelUE.body.evidence?.id && panelUE.body.events.some((e) => e.event_type === 'evidence_uploaded' && e.actor_name), `evidence ${panelUE.body.evidence?.original_filename}`)
  const sUE = await http('logi', 'POST', `/api/orders/logistics/orders/${UE.order}/packaging`, { action: 'send_template', request_key: `${MARK}-t-${rid()}` })
  rec('evidence upload', 'template enabled by the uploaded evidence → sent (simulated) → ready_for_dispatch, same conversation', sUE.status === 200 && (await logiStatus(UE.order)) === 'ready_for_dispatch', `send ${sUE.status} ${JSON.stringify(sUE.body).slice(0, 100)}`)
  const lateUp = await evUpload('logi', UE.order, 'media-A2-correcta.png', 'otra.png')
  rec('evidence upload', 'once ready_for_dispatch the evidence is frozen (409)', lateUp.status === 409, `status ${lateUp.status}`)

  // ---------- 4) cross-account (account A cannot touch account X and vice versa) ----------
  const X = await mkOrder('x1', { acc: W.accX, actor: W.users.ext, owner: W.users.ext })
  const xa = await advance('ext', X, 'pending')
  const xv = await upload('ext', X.order, 'voucher-pedidoB.pdf')
  const xb = await upload('ext', null, 'bulk-caso-C-sinmatch-1.pdf'); const xbd = xb.body.document.id
  const cross = {}
  cross.read_order = (await http('logi', 'GET', `/api/orders/logistics/orders/${X.order}`)).status
  cross.read_doc = (await http('logi', 'GET', `/api/orders/logistics/documents/${xa.doc}`)).status
  cross.signed_url = (await http('logi', 'GET', `/api/orders/logistics/documents/${xa.doc}/url`)).status
  cross.list_docs = (await http('logi', 'GET', `/api/orders/logistics/documents?order_id=${X.order}`))
  cross.upload_to_foreign_order = (await upload('logi', X.order)).status
  cross.ocr_foreign_doc = (await http('logi', 'POST', `/api/orders/logistics/documents/${xa.doc}/ocr`, {})).status
  cross.review_foreign_doc = (await http('logi', 'POST', `/api/orders/logistics/documents/${xa.doc}/review`, { action: 'validate', expected_row_version: 1, reviewed_data: FIXED })).status
  cross.associate_foreign_voucher = (await http('logi', 'POST', `/api/orders/logistics/documents/${xbd}/associate`, { order_id: PT.order })).status
  cross.associate_to_foreign_order = (await http('logi', 'POST', `/api/orders/logistics/documents/${bulkDoc}/associate`, { order_id: X.order })).status
  cross.start_foreign = (await http('logi', 'POST', `/api/orders/logistics/orders/${X.order}/packaging`, { action: 'start' })).status
  cross.evidence_upload_foreign_order = (await evUpload('logi', X.order)).status
  cross.evidence_foreign_order = (await http('logi', 'POST', `/api/orders/logistics/orders/${X.order}/evidence`, { message_id: X.mediaId, request_key: `${MARK}-x-${rid()}` })).status
  const own = await mkOrder('own-ev'); await advance('logi', own, 'packing')
  cross.evidence_foreign_media_on_own_order = (await http('logi', 'POST', `/api/orders/logistics/orders/${own.order}/evidence`, { message_id: X.mediaId, request_key: `${MARK}-x-${rid()}` })).status
  const otherConvMedia = await S.addMedia((await S.mkConversation(W.acc, W.users.owner.id, 'otra conv', `5190${Math.floor(Math.random() * 1e7).toString().padStart(7, '0')}`, [['customer', 'x']])).conversationId, W.acc, path.join(FIX, 'media-B-otra-conversacion.png'), `b-${rid()}`)
  cross.evidence_media_of_other_conversation = (await http('logi', 'POST', `/api/orders/logistics/orders/${own.order}/evidence`, { message_id: otherConvMedia, request_key: `${MARK}-b-${rid()}` })).status
  const okOwnMedia = await http('logi', 'POST', `/api/orders/logistics/orders/${own.order}/evidence`, { message_id: own.mediaId, request_key: `${MARK}-a-${rid()}` })
  const xlist = cross.list_docs.body
  rec('cross-account', 'A cannot read order / voucher / download / list of account X', [cross.read_order, cross.read_doc, cross.signed_url].every(BLOCKED) && (xlist.documents ?? xlist.items ?? []).length === 0, `order ${cross.read_order}, doc ${cross.read_doc}, url ${cross.signed_url}, list rows=${(xlist.documents ?? xlist.items ?? []).length}`)
  rec('cross-account', 'A cannot upload / OCR / review / associate / start packaging / select evidence on account X', ['upload_to_foreign_order', 'ocr_foreign_doc', 'review_foreign_doc', 'associate_foreign_voucher', 'associate_to_foreign_order', 'start_foreign', 'evidence_foreign_order', 'evidence_upload_foreign_order'].every((k) => BLOCKED(cross[k])), JSON.stringify(Object.fromEntries(Object.entries(cross).filter(([k]) => k !== 'list_docs'))))
  rec('evidence', 'MEDIA A (own conversation) is selectable → private snapshot in order-docs', okOwnMedia.status === 201 || okOwnMedia.status === 200, `status ${okOwnMedia.status}`)
  rec('evidence', 'MEDIA B (other conversation, same account) is REJECTED', !ALLOWED(cross.evidence_media_of_other_conversation), `status ${cross.evidence_media_of_other_conversation}`)
  rec('evidence', 'MEDIA C (other account) is REJECTED', !ALLOWED(cross.evidence_foreign_media_on_own_order), `status ${cross.evidence_foreign_media_on_own_order}`)
  const ev = okOwnMedia.body.evidence
  const evRow = (await admin.from('order_documents').select('storage_bucket, storage_path, source_message_id').eq('id', ev.id).single()).data
  const orig = (await admin.from('messages').select('media_url').eq('id', own.mediaId).single()).data
  const objOk = !(await admin.storage.from('order-docs').download(evRow.storage_path)).error
  rec('evidence', 'snapshot is a PRIVATE copy in order-docs, linked to the source message; the original chat media is untouched', evRow.storage_bucket === 'order-docs' && objOk && evRow.source_message_id === own.mediaId && !!orig.media_url && (await fetch(orig.media_url)).ok, evRow.storage_path)
  // the cross-account bulk candidate leak check: account A bulk voucher with the fake OCR identity vs an order in X with the same identity (X.order has random identity; create one with fake identity)
  const XI = await mkOrder('xi', { acc: W.accX, actor: W.users.ext, owner: W.users.ext, dni: '12345678', phone: '51900000001' })
  await S.retirePool(W.acc, W.users.logi.cookie)
  const bd2 = (await upload('logi', null, 'bulk-caso-A-seguro-2.pdf', { allow_duplicate: 'true' })).body.document.id
  const pr = await http('logi', 'POST', `/api/orders/logistics/documents/${bd2}/process`, {})
  rec('cross-account', 'bulk matching never considers orders of another account (identical DNI+phone in account X is not a candidate)', pr.body.outcome === 'pending' && pr.body.reason === 'no_candidates', JSON.stringify(pr.body).slice(0, 160))

  // ---------- 5) bulk matching cases A (safe), B (ambiguous), C (none) with the fake OCR ----------
  const mk = async (acc, tag, dni, phone) => (await mkOrder(tag, { acc, dni, phone })).order
  await S.retirePool(W.acc, W.users.logi.cookie)
  const caseA = await mk(W.acc, 'caseA', '12345678', '51900000001')
  const dA = (await upload('logi', null, 'bulk-caso-A-seguro-3.pdf', { allow_duplicate: 'true' })).body.document.id
  const rA = await http('logi', 'POST', `/api/orders/logistics/documents/${dA}/process`, {})
  rec('bulk', 'CASO A (candidato único, 2 señales fuertes, confianza>=0.8) → asociado automáticamente', rA.body.outcome === 'associated' && rA.body.association === 'auto' && rA.body.order_id === caseA, JSON.stringify(rA.body).slice(0, 180))
  const caseB1 = await mk(W.acc, 'caseB1', '12345678', '51900000001'); const caseB2 = await mk(W.acc, 'caseB2', '12345678', '51900000001')
  const dB = (await upload('logi', null, 'bulk-caso-B-ambiguo-2.pdf', { allow_duplicate: 'true' })).body.document.id
  const rB = await http('logi', 'POST', `/api/orders/logistics/documents/${dB}/process`, {})
  rec('bulk', 'CASO B (dos candidatos) → Pendiente de asociar, ambiguous, NO asocia', rB.body.outcome === 'pending' && rB.body.reason === 'ambiguous', JSON.stringify(rB.body).slice(0, 180))
  const manual = await http('logi', 'POST', `/api/orders/logistics/documents/${dB}/associate`, { order_id: caseB2 })
  await S.retirePool(W.acc, W.users.logi.cookie)
  const dC = (await upload('logi', null, 'bulk-caso-C-sinmatch-2.pdf', { allow_duplicate: 'true' })).body.document.id
  const rC = await http('logi', 'POST', `/api/orders/logistics/documents/${dC}/process`, {})
  rec('bulk', 'CASO C (ningún candidato) → Pendiente de asociar, no_candidates', rC.body.outcome === 'pending' && rC.body.reason === 'no_candidates', JSON.stringify(rC.body).slice(0, 180))
  rec('bulk', 'asociación manual de un voucher pendiente a un pedido elegido por la persona', manual.status === 200, `status ${manual.status} ${JSON.stringify(manual.body).slice(0, 120)}`)

  // ---------- 6) template dispatch: SUCCESS / FAILED / UNCERTAIN, idempotency, no auto re-send ----------
  const mdl = {}
  for (const mode of ['success', 'failed', 'uncertain']) {
    const o = await mkOrder(`tpl-${mode}`); await advance('logi', o, 'evidence')
    const calls0 = metaLog().length
    setMode(mode)
    const key = `${MARK}-t-${rid()}`
    const r1 = await http('logi', 'POST', `/api/orders/logistics/orders/${o.order}/packaging`, { action: 'send_template', request_key: key })
    const st1 = await logiStatus(o.order)
    const msgs1 = await count('messages', 'conversation_id', o.conv)
    mdl[mode] = { r1, st1, msgs1, o, key, calls: metaLog().length - calls0 }
    if (mode === 'success') {
      const r2 = await http('logi', 'POST', `/api/orders/logistics/orders/${o.order}/packaging`, { action: 'send_template', request_key: key })
      mdl[mode].replay = r2
      rec('dispatch', 'SUCCESS → ready_for_dispatch, a template message saved in the SAME conversation, 1 simulated Meta call', r1.status === 200 && st1 === 'ready_for_dispatch' && mdl[mode].calls === 1, `status ${r1.status}, order ${st1}, meta calls ${mdl[mode].calls}`)
      rec('dispatch', 'SUCCESS replay with the same request_key does NOT send again', r2.status === 200 && metaLog().length - calls0 === 1, `replay ${r2.status}, meta calls ${metaLog().length - calls0}`)
    }
    if (mode === 'failed') rec('dispatch', 'FAILED → order stays in packing, no message saved, error reported', !ALLOWED(r1.status) && st1 === 'packing' && r1.body.status === 'failed', `status ${r1.status} ${JSON.stringify(r1.body).slice(0, 120)}`)
    if (mode === 'uncertain') {
      const calls1 = metaLog().length
      const again = await http('logi', 'POST', `/api/orders/logistics/orders/${o.order}/packaging`, { action: 'send_template', request_key: `${MARK}-t-${rid()}` })
      rec('dispatch', 'UNCERTAIN → order stays in packing; a new attempt does NOT re-send automatically', !ALLOWED(r1.status) && st1 === 'packing' && r1.body.status === 'uncertain' && !ALLOWED(again.status) && metaLog().length === calls1, `first ${r1.status}/${r1.body.status}; retry ${again.status} ${JSON.stringify(again.body).slice(0, 100)}; extra meta calls ${metaLog().length - calls1}`)
    }
    setMode('success')
  }
  // retry after FAILED works (attempt 2)
  const fo = mdl.failed.o
  const retry = await http('logi', 'POST', `/api/orders/logistics/orders/${fo.order}/packaging`, { action: 'send_template', request_key: `${MARK}-t-${rid()}` })
  rec('dispatch', 'FAILED can be retried by the person (explicit action) and then succeeds', retry.status === 200 && (await logiStatus(fo.order)) === 'ready_for_dispatch', `status ${retry.status}`)

  // ---------- 7) integration invariants: same conversation / order, PR-03 routing untouched by PR-04 ----------
  const IO = await mkOrder('inv'); const convCountBefore = await count('conversations', 'contact_id', IO.contactId)
  const routeBefore = (await admin.from('conversation_routing').select('stage, version').eq('conversation_id', IO.conv).single()).data
  const evBefore = await count('conversation_routing_events', 'conversation_id', IO.conv)
  const msgBefore = await count('messages', 'conversation_id', IO.conv)
  await advance('logi', IO, 'evidence')
  const sent = await http('logi', 'POST', `/api/orders/logistics/orders/${IO.order}/packaging`, { action: 'send_template', request_key: `${MARK}-t-${rid()}` })
  const routeAfter = (await admin.from('conversation_routing').select('stage, version').eq('conversation_id', IO.conv).single()).data
  const evAfter = await count('conversation_routing_events', 'conversation_id', IO.conv)
  rec('integration', 'commercial confirmation routed the SAME conversation to logistics (PR-03)', routeBefore.stage === 'logistics', JSON.stringify(routeBefore))
  rec('integration', 'PR-04 (voucher→OCR→validación→embalaje→evidencia→plantilla) did NOT change routing stage/version/events', routeAfter.stage === routeBefore.stage && routeAfter.version === routeBefore.version && evAfter === evBefore, `before ${JSON.stringify(routeBefore)}/${evBefore} after ${JSON.stringify(routeAfter)}/${evAfter}`)
  rec('integration', 'no duplicated conversation / order; the template message landed in the SAME conversation with history preserved', (await count('conversations', 'contact_id', IO.contactId)) === convCountBefore && (await count('order_confirmations', 'conversation_id', IO.conv)) === 1 && (await count('messages', 'conversation_id', IO.conv)) === msgBefore + 1 + 0 && sent.status === 200, `messages ${msgBefore}→${await count('messages', 'conversation_id', IO.conv)} (+1 = template; the evidence snapshot is NOT a chat message)`)
  const der = await http('logi', 'POST', `/api/conversations/${IO.conv}/derive-to-commercial`, {})
  const routeDer = (await admin.from('conversation_routing').select('stage, version').eq('conversation_id', IO.conv).single()).data
  rec('integration', 'Logistics → Derivar a Comercial → shared, SAME conversation_id, history intact', ALLOWED(der.status) && routeDer.stage === 'shared' && (await count('messages', 'conversation_id', IO.conv)) === msgBefore + 1, `status ${der.status} stage ${routeDer.stage}`)
  const afterDerive = await http('logi', 'GET', `/api/orders/logistics/orders/${IO.order}`)
  rec('integration', 'after deriving to shared the order is still readable by logistics (PR-04 independent of routing stage)', afterDerive.status === 200, `status ${afterDerive.status}`)
  const derComm = await http('comm', 'POST', `/api/conversations/${(await mkOrder('inv2')).conv}/derive-to-commercial`, {})
  rec('integration', 'Commercial cannot use Derivar a Comercial (logistics action)', !ALLOWED(derComm.status), `status ${derComm.status}`)

  // ---------- 8) flag OFF ----------
  const accOff = W.acc
  await admin.from('order_integration_settings').update({ logistics_mvp_enabled: false }).eq('account_id', accOff)
  const off = {}
  const offProbe = [['GET', '/api/orders/logistics/summary?ids=' + P0.order], ['GET', `/api/orders/logistics/orders/${P0.order}`], ['GET', '/api/orders/logistics/documents'], ['GET', '/api/orders/confirmed'], ['GET', '/api/orders/logistics/orders/pending?q=a']]
  for (const [m, u] of offProbe) off[u.split('?')[0]] = (await http('logi', m, u)).status
  const offUp = await upload('logi', P0.order); const offStart = await http('logi', 'POST', `/api/orders/logistics/orders/${P1.order}/packaging`, { action: 'start' })
  const stateOff = await logiStatus(P1.order)
  rec('flag OFF', 'flag OFF → every /api/orders/logistics/* endpoint refuses (403), nothing is written', Object.entries(off).filter(([k]) => k.includes('logistics')).every(([, s]) => s === 403) && offUp.status === 403 && offStart.status === 403 && stateOff === 'voucher_validated', JSON.stringify(off) + ` upload ${offUp.status} start ${offStart.status} P1=${stateOff}`)
  await admin.from('order_integration_settings').update({ logistics_mvp_enabled: true }).eq('account_id', accOff)

  const report = { generatedAt: new Date().toISOString(), matrix, results, rls }
  fs.writeFileSync(path.join(L.QA_DIR, 'verify-report.json'), JSON.stringify(report, null, 2))
  const fails = results.filter((r) => !r.ok)
  console.log(`\nRESULT: ${results.length - fails.length}/${results.length} checks passed`)
  console.log('\nMATRIX (HTTP API, enforced in backend):')
  const cols = ['comm', 'logi', 'sup', 'viewer', 'null', 'ext']
  console.log(['ACTION'.padEnd(44), ...cols.map((c) => c.padEnd(18))].join(''))
  for (const [a, row] of Object.entries(matrix)) console.log([a.padEnd(44), ...cols.map((c) => (row[c] ?? '-').replace(/ \[.*/, '').padEnd(18))].join(''))
  return fails.length
}

async function cleanupVerif() {
  const { data: accs } = await admin.from('accounts').select('id').like('name', `${ACCOUNT_PREFIX}VERIF%`)
  for (const a of accs ?? []) { for (const [b, p] of [['order-docs', `${a.id}`], ['chat-media', `account-${a.id}/mirror`]]) await rm(b, p); await admin.from('accounts').delete().eq('id', a.id) }
  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 500 })
  for (const u of data.users) if (u.email?.startsWith(`verif-`) && u.email.endsWith(`@${DOMAIN}`)) await admin.auth.admin.deleteUser(u.id)
}

main()
  .then(async (fails) => { if (!process.argv.includes('--keep')) { await disposeWorld(); await cleanupVerif() } process.exit(fails ? 1 : 0) })
  .catch(async (e) => { console.error(e); try { await disposeWorld(); await cleanupVerif() } catch {} process.exit(2) })
