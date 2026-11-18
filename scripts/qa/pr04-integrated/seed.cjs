/* LOCAL ONLY. Reproducible synthetic QA world for the integrated manual test PR-01 + PR-02 + PR-03 + PR-04.
 *   node scripts/qa/pr04-integrated/seed.cjs create          wipe previous QA (only qa-pr04 data) and create everything
 *   node scripts/qa/pr04-integrated/seed.cjs scenario <safe|ambiguous|none>   (re)build the bulk-matching pool (see README)
 *   node scripts/qa/pr04-integrated/seed.cjs validated       needs the app running: creates "Pedido E" already in voucher_validated (through the real API)
 *   node scripts/qa/pr04-integrated/seed.cjs cleanup         removes ONLY the qa-pr04 data (accounts, users, storage objects)
 * Orders are created through the REAL create_order_confirmation RPC (so PR-03 routing applies), never by direct insert. */
const crypto = require('node:crypto')
const L = require('./lib.cjs')
const { admin, MARK, DOMAIN, ACCOUNT_PREFIX, encryptToken, fs, path } = L

const PASSWORD = 'QaLocal-2026!' // local synthetic users only (@qa-pr04.example.invalid)
const FAKE_OCR = { dni: '12345678', phone: '51900000001', name: 'Cliente Prueba', amount: '10.00' } // = DEFAULT_FAKE_FIELDS of the local fake OCR provider
const rid = () => crypto.randomBytes(4).toString('hex')
const must = (r, what) => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`)
  return r.data
}

// ------------------------------------------------------------------ cleanup (ONLY qa-pr04)
async function cleanup() {
  const { data: accs } = await admin.from('accounts').select('id, name').like('name', `${ACCOUNT_PREFIX}%`)
  const accountIds = (accs ?? []).map((a) => a.id)
  // storage objects under the QA accounts (order-docs / chat-media)
  for (const bucket of ['order-docs', 'chat-media']) {
    for (const id of accountIds) {
      const prefixes = bucket === 'chat-media' ? [`account-${id}/mirror`] : [`${id}`]
      for (const prefix of prefixes) await removeTree(bucket, prefix)
    }
  }
  for (const id of accountIds) {
    const r = await admin.from('accounts').delete().eq('id', id)
    if (r.error) console.warn('account delete', id, r.error.message)
  }
  // users by marker (listUsers is paginated)
  let page = 1
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw error
    for (const u of data.users) if (u.email && u.email.endsWith(`@${DOMAIN}`)) await admin.auth.admin.deleteUser(u.id)
    if (data.users.length < 200) break
    page++
  }
  if (fs.existsSync(L.STATE_FILE)) fs.unlinkSync(L.STATE_FILE)
  console.log(`cleanup: ${accountIds.length} QA account(s) removed`)
}

async function removeTree(bucket, prefix) {
  const { data } = await admin.storage.from(bucket).list(prefix, { limit: 1000 })
  const files = []
  for (const e of data ?? []) {
    if (e.id) files.push(`${prefix}/${e.name}`)
    else await removeTree(bucket, `${prefix}/${e.name}`)
  }
  if (files.length) await admin.storage.from(bucket).remove(files)
}

// ------------------------------------------------------------------ users / accounts
async function mkUser(label, fullName) {
  const email = `${label}@${DOMAIN}`
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: fullName } })
  if (error) throw error
  must(await admin.from('profiles').update({ full_name: fullName }).eq('user_id', data.user.id), 'profile name')
  const { data: prof } = await admin.from('profiles').select('account_id').eq('user_id', data.user.id).single()
  // the account the signup trigger created for this user: renamed so cleanup can find it even after the user moves to another account
  must(await admin.from('accounts').update({ name: `${ACCOUNT_PREFIX}autogen ${label}` }).eq('id', prof.account_id), 'autogen rename')
  return { id: data.user.id, email, password: PASSWORD, name: fullName, label }
}
async function placeUser(u, accountId, accountRole, operationalRole) {
  must(await admin.from('profiles').update({ account_id: accountId, account_role: accountRole }).eq('user_id', u.id), 'place user')
  must(await admin.from('profiles').update({ operational_role: operationalRole }).eq('user_id', u.id), 'operational role')
}

// ------------------------------------------------------------------ chat helpers
let phoneSeq = 0
const phone = () => `5190${String(9000000 + 100 * ++phoneSeq + Math.floor(Math.random() * 90)).padStart(7, '0')}`.slice(0, 11)

async function mkConversation(accountId, ownerId, contactName, contactPhone, history) {
  const c = must(await admin.from('contacts').insert({ user_id: ownerId, account_id: accountId, phone: contactPhone, name: contactName }).select('id').single(), 'contact')
  const conv = must(await admin.from('conversations').insert({ user_id: ownerId, account_id: accountId, contact_id: c.id }).select('id').single(), 'conversation')
  let t = Date.now() - history.length * 60_000
  for (const [who, text] of history) {
    must(await admin.from('messages').insert({ conversation_id: conv.id, sender_type: who, content_type: 'text', content_text: text, created_at: new Date((t += 60_000)).toISOString() }), 'message')
  }
  const last = history[history.length - 1]
  must(await admin.from('conversations').update({ last_message_at: new Date(t).toISOString(), last_message_text: last[1], unread_count: 0 }).eq('id', conv.id), 'conversation preview')
  return { contactId: c.id, conversationId: conv.id }
}
async function addMedia(conversationId, accountId, file, key) {
  const bytes = fs.readFileSync(file)
  const objectPath = `account-${accountId}/mirror/${MARK}-${key}.png`
  must(await admin.storage.from('chat-media').upload(objectPath, bytes, { contentType: 'image/png', upsert: true }), 'media upload')
  const url = admin.storage.from('chat-media').getPublicUrl(objectPath).data.publicUrl
  const row = must(await admin.from('messages').insert({ conversation_id: conversationId, sender_type: 'customer', content_type: 'image', media_url: url, media_type: 'image/png', content_text: `Foto ${key}` }).select('id').single(), 'media message')
  return row.id
}
async function confirmOrder(accountId, actor, conv, key, fields) {
  const { data, error } = await admin.rpc('create_order_confirmation', {
    p_account: accountId, p_contact: conv.contactId, p_conversation: conv.conversationId, p_actor: actor.id, p_actor_name: actor.name,
    p_request_key: `${MARK}-${key}`, p_seller: actor.id, p_fields: fields,
  })
  if (error) throw new Error(`create_order_confirmation ${key}: ${error.message}`)
  return (Array.isArray(data) ? data[0] : data).order_id
}
const single = (name, dni, ph, product, qty, price, destination) => ({ customer_name: name, dni, phone: ph, product, quantity: String(qty), price: String(price), destination })

// ------------------------------------------------------------------ retire the bulk pool through the REAL API (orders are immutable: identities cannot be edited)
// A pool order stops being a bulk candidate once its voucher is VALIDATED. Needs the app running (:3000) and a logistics/supervisor session cookie.
async function retirePool(accountId, cookie, ids) {
  let list = ids
  if (!list) {
    const { data } = await admin.from('order_confirmations').select('id').eq('account_id', accountId).eq('dni', FAKE_OCR.dni).eq('phone', FAKE_OCR.phone)
    list = (data ?? []).map((o) => o.id)
  }
  const api = async (method, url, body) => {
    const res = await fetch(L.APP_URL + url, { method, headers: { cookie, ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json().catch(() => ({})) }
  }
  let retired = 0
  for (const id of list) {
    const lg = (await admin.from('order_logistics').select('status').eq('order_id', id).maybeSingle()).data
    if (lg && lg.status !== 'pending_voucher') continue
    const { data: pend } = await admin.from('order_documents').select('id, row_version').eq('order_id', id).eq('kind', 'voucher').eq('status', 'pending_review')
    for (const d of pend ?? []) await api('POST', `/api/orders/logistics/documents/${d.id}/review`, { action: 'reject', expected_row_version: d.row_version })
    const fd = new FormData()
    fd.append('file', new Blob([fs.readFileSync(path.join(L.QA_DIR, 'fixtures', 'voucher-pedidoE.pdf'))], { type: 'application/pdf' }), 'voucher-pedidoE.pdf')
    fd.append('request_key', `${MARK}-retire-${rid()}`)
    fd.append('order_id', id)
    fd.append('allow_duplicate', 'true')
    const up = await api('POST', '/api/orders/logistics/documents', fd)
    if (up.status !== 201) throw new Error(`retire upload ${up.status} ${JSON.stringify(up.body)}`)
    const det = await api('GET', `/api/orders/logistics/documents/${up.body.document.id}`)
    const v = await api('POST', `/api/orders/logistics/documents/${up.body.document.id}/review`, { action: 'validate', expected_row_version: det.body.document.row_version, reviewed_data: { dni: FAKE_OCR.dni, phone: FAKE_OCR.phone, customer_name: 'Retirado', amount: '10.00' } })
    if (v.status !== 200) throw new Error(`retire validate ${v.status} ${JSON.stringify(v.body)}`)
    retired++
  }
  return retired
}

// ------------------------------------------------------------------ the bulk pool (scenario)
async function scenario(kind) {
  const st = L.readState()
  if (!st) throw new Error('no QA state: run `create` first')
  if (!['safe', 'ambiguous', 'none'].includes(kind)) throw new Error('scenario must be safe | ambiguous | none')
  const { acc } = st
  // earlier pool orders must stop being candidates: their vouchers are validated through the real API (needs the app running)
  const sess = await L.login(st.users.logistica.email, st.password)
  const { data: pool } = await admin.from('order_confirmations').select('id').eq('account_id', acc).like('request_key', `${MARK}-pool-%`)
  const retired = await retirePool(acc, sess.cookie, (pool ?? []).map((o) => o.id))
  if (retired) console.log(`retired ${retired} earlier pool order(s)`)
  const comm = st.users.comercial
  const make = async (suffix, dni, ph, customer) => {
    const conv = await mkConversation(acc, st.users.owner.id, customer, phone(), [['customer', 'Hola, ya pague mi pedido'], ['agent', 'Perfecto, confirmamos tu pedido']])
    return confirmOrder(acc, comm, conv, `pool-${kind}-${suffix}-${rid()}`, single(customer, dni, ph, 'Producto Pool', 1, 10, 'Lima'))
  }
  const ids = []
  if (kind === 'safe') ids.push(await make('1', FAKE_OCR.dni, FAKE_OCR.phone, 'Cliente Pool Seguro'))
  if (kind === 'ambiguous') {
    ids.push(await make('1', FAKE_OCR.dni, FAKE_OCR.phone, 'Cliente Pool Ambiguo 1'))
    ids.push(await make('2', FAKE_OCR.dni, FAKE_OCR.phone, 'Cliente Pool Ambiguo 2'))
  }
  if (kind === 'none') ids.push(await make('1', '99999999', '51999999999', 'Cliente Pool Sin Match'))
  st.scenario = { kind, orders: ids }
  L.writeState(st)
  console.log(`scenario ${kind}: pending orders in the pool -> ${ids.join(', ')}`)
  return ids
}

// ------------------------------------------------------------------ create
async function create() {
  await cleanup()
  const gen = await require('./fixtures.cjs').generate()

  const owner = await mkUser('qa-dueno', 'QA Dueño')
  const comercial = await mkUser('qa-comercial', 'Carlos Comercial')
  const logistica = await mkUser('qa-logistica', 'Laura Logística')
  const supervisor = await mkUser('qa-supervisor', 'Sergio Supervisor')
  const viewer = await mkUser('qa-viewer', 'Vera Viewer')
  const sinarea = await mkUser('qa-sinarea', 'Nora SinArea')
  const legacy = await mkUser('qa-legacy', 'Lucía Legacy')
  const externo = await mkUser('qa-externo', 'Eva Externa')

  const accOf = async (u) => (await admin.from('profiles').select('account_id').eq('user_id', u.id).single()).data.account_id
  const acc = await accOf(owner)
  const accB = await accOf(legacy)
  const accC = await accOf(externo)
  for (const [id, n] of [[acc, 'LOGISTICA (cuenta A, flag ON)'], [accB, 'LEGACY (cuenta B, flag OFF)'], [accC, 'EXTERNA (cuenta C, flag ON)']]) must(await admin.from('accounts').update({ name: `${ACCOUNT_PREFIX}${n}` }).eq('id', id), 'account name')

  await placeUser(owner, acc, 'owner', null)
  await placeUser(comercial, acc, 'agent', 'commercial')
  await placeUser(logistica, acc, 'agent', 'logistics')
  await placeUser(supervisor, acc, 'agent', 'supervisor')
  await placeUser(viewer, acc, 'viewer', 'logistics') // an area but read-only account role
  await placeUser(sinarea, acc, 'agent', null) // no operational area
  await placeUser(legacy, accB, 'owner', 'logistics') // an area, but the flag is OFF in its account
  await placeUser(externo, accC, 'owner', 'supervisor')

  for (const [a, on] of [[acc, true], [accB, false], [accC, true]]) must(await admin.from('order_integration_settings').upsert({ account_id: a, confirm_enabled: true, logistics_mvp_enabled: on, multiproduct_enabled: true }), 'settings')

  // Simulated WhatsApp connection + operational template (LOCAL QA values only; the token is a placeholder encrypted with the local key; nothing reaches Meta)
  const cfgOf = (a, u, n) => ({ user_id: u.id, account_id: a, phone_number_id: `${MARK.replace('-', '')}00000${n}`, waba_id: `${MARK.replace('-', '')}waba${n}`, access_token: encryptToken('qa-simulated-token-not-real'), status: 'connected' })
  must(await admin.from('whatsapp_config').insert(cfgOf(acc, owner, 1)), 'wa cfg A')
  must(await admin.from('whatsapp_config').insert(cfgOf(accB, legacy, 2)), 'wa cfg B')
  must(await admin.from('whatsapp_config').insert(cfgOf(accC, externo, 3)), 'wa cfg C')
  const TEMPLATE = { name: 'qa_pedido_embalado', language: 'es' }
  for (const [a, u] of [[acc, owner], [accC, externo]]) {
    must(await admin.from('message_templates').insert({ user_id: u.id, account_id: a, name: TEMPLATE.name, category: 'Utility', language: TEMPLATE.language, header_type: 'image', body_text: 'Hola {{1}}, tu pedido de {{2}} ya fue embalado y esta listo para despacho.', status: 'APPROVED' }), 'template')
    must(await admin.from('order_logistics_settings').upsert({ account_id: a, packaging_template_name: TEMPLATE.name, packaging_template_language: TEMPLATE.language, packaging_template_params: ['customer_name', 'product'] }), 'logistics settings')
  }

  const F = gen.files
  const st = { createdAt: new Date().toISOString(), password: PASSWORD, acc, accB, accC, users: { owner, comercial, logistica, supervisor, viewer, sinarea, legacy, externo }, fixtures: gen.dir, orders: {}, conv: {}, media: {}, template: TEMPLATE }
  L.writeState(st)

  // PASO B: a conversation WITHOUT an order (the Commercial confirms it live from the Inbox)
  const live = await mkConversation(acc, owner.id, 'Cliente En Vivo QA', '51900000100', [
    ['customer', 'Hola, quiero comprar el Producto Uno'], ['agent', 'Claro, te cuento los detalles'], ['customer', 'Dale, lo quiero. Mi DNI es 40404040'], ['agent', 'Perfecto, voy a confirmar tu pedido'],
  ])
  st.conv.live = live.conversationId
  st.contact = { live: live.contactId }

  // Pedido A (1 product): DNI/phone deliberately differ from the fake OCR values (name and amount match) so the review shows differences to correct
  const cA = await mkConversation(acc, owner.id, 'Cliente Pedido A', '51900000101', [['customer', 'Hola, hice el yape del pedido A'], ['agent', 'Gracias, lo revisamos'], ['customer', 'Te mando la foto del producto']])
  const mA = await addMedia(cA.conversationId, acc, F['media-A-correcta.png'], 'A-correcta')
  const mA2 = await addMedia(cA.conversationId, acc, F['media-A2-correcta.png'], 'A2-correcta')
  const oA = await confirmOrder(acc, comercial, cA, 'pedidoA', single('Cliente Prueba', '11112222', '51911112222', 'Producto Uno', 1, 10, 'Lima'))

  // Pedido B (multiproduct): everything differs from the fake OCR values
  const cB = await mkConversation(acc, owner.id, 'Ana Multi', '51900000102', [['customer', 'Quiero Alfa y Beta'], ['agent', 'Listo, 1 Alfa y 2 Beta'], ['customer', 'Gracias']])
  const mB1 = await addMedia(cB.conversationId, acc, F['media-A-correcta.png'], 'B-conv')
  const oB = await confirmOrder(acc, comercial, cB, 'pedidoB', {
    customer_name: 'Ana Multi', dni: '87654321', phone: '51900000002', product: '1 x Alfa\n2 x Beta', quantity: '3', price: '20.00', destination: 'Arequipa',
    items: [{ product_name: 'Alfa', quantity: '1', unit_price: '10.00' }, { product_name: 'Beta', quantity: '2', unit_price: '5.00' }],
  })

  // Pedido E: its voucher is validated by `validated` (needs the app running). MEDIA A (correct conv), MEDIA B (other conv, same account), MEDIA C (other account)
  const cE = await mkConversation(acc, owner.id, 'Cliente Embalaje', '51900000103', [['customer', 'Hola, ya pague'], ['agent', 'Recibido, vamos a embalar'], ['customer', 'Aqui la foto del producto que me enviaron']])
  const mEA = await addMedia(cE.conversationId, acc, F['media-A-correcta.png'], 'E-mediaA')
  const cX = await mkConversation(acc, owner.id, 'Otra Conversacion QA', '51900000104', [['customer', 'Esta es otra conversacion de la misma cuenta']])
  const mEB = await addMedia(cX.conversationId, acc, F['media-B-otra-conversacion.png'], 'X-mediaB')
  const oE = await confirmOrder(acc, comercial, cE, 'pedidoE', single('Cliente Embalaje', '50505050', '51950505050', 'Producto Embalaje', 1, 15, 'Cusco'))

  // Cuenta C (other account): Pedido D carries the SAME DNI/phone as the fake OCR, to prove a bulk voucher of account A never matches across accounts
  const cD = await mkConversation(accC, externo.id, 'Cliente Externo', '51900000200', [['customer', 'Hola desde otra cuenta']])
  const mC = await addMedia(cD.conversationId, accC, F['media-C-otra-cuenta.png'], 'D-mediaC')
  const oD = await confirmOrder(accC, externo, cD, 'pedidoD', single('Cliente Externo', FAKE_OCR.dni, FAKE_OCR.phone, 'Producto Externo', 1, 10, 'Piura'))

  // Cuenta B (legacy, flag OFF): one order + chat so Inbox / Pedidos Confirmados can be exercised
  const cL = await mkConversation(accB, legacy.id, 'Cliente Legacy', '51900000300', [['customer', 'Hola legacy'], ['agent', 'Hola, en que te ayudo']])
  const oL = await confirmOrder(accB, legacy, cL, 'legacy', single('Cliente Legacy', '70707070', '51970707070', 'Producto Legacy', 1, 12, 'Tacna'))

  Object.assign(st.orders, { A: oA, B: oB, E: oE, D: oD, L: oL })
  Object.assign(st.conv, { A: cA.conversationId, B: cB.conversationId, E: cE.conversationId, X: cX.conversationId, D: cD.conversationId, L: cL.conversationId })
  Object.assign(st.media, { A: mA, A2: mA2, B1: mB1, E_A: mEA, E_B_otherConversation: mEB, C_otherAccount: mC })
  L.writeState(st)
  await scenario('safe')
  console.log(JSON.stringify({ accounts: { A: acc, B: accB, C: accC }, orders: st.orders, conv: st.conv }, null, 2))
}

// ------------------------------------------------------------------ validated (Pedido E) through the real API as the logistics user
async function validated() {
  const st = L.readState()
  if (!st) throw new Error('run create first')
  const { login } = L
  const s = await login(st.users.logistica.email, st.password)
  const file = fs.readFileSync(path.join(st.fixtures, 'voucher-pedidoE.pdf'))
  const fd = new FormData()
  fd.append('file', new Blob([file], { type: 'application/pdf' }), 'voucher-pedidoE.pdf')
  fd.append('request_key', `${MARK}-validated-E`)
  fd.append('order_id', st.orders.E)
  const up = await fetch(`${L.APP_URL}/api/orders/logistics/documents`, { method: 'POST', headers: { cookie: s.cookie }, body: fd })
  const upBody = await up.json()
  if (!up.ok) throw new Error(`upload ${up.status} ${JSON.stringify(upBody)}`)
  const docId = upBody.document?.id ?? upBody.id
  const det = await (await fetch(`${L.APP_URL}/api/orders/logistics/documents/${docId}`, { headers: { cookie: s.cookie } })).json()
  const rv = det.document?.row_version ?? 1
  const rev = await fetch(`${L.APP_URL}/api/orders/logistics/documents/${docId}/review`, {
    method: 'POST', headers: { cookie: s.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'validate', expected_row_version: rv, reviewed_data: { dni: '50505050', phone: '51950505050', customer_name: 'Cliente Embalaje', amount: '15.00' } }),
  })
  const revBody = await rev.json()
  if (!rev.ok) throw new Error(`validate ${rev.status} ${JSON.stringify(revBody)}`)
  console.log('Pedido E -> voucher validated', JSON.stringify(revBody).slice(0, 200))
}

module.exports = { retirePool, mkConversation, addMedia, confirmOrder, single, PASSWORD, FAKE_OCR }
if (require.main === module) {
  const cmd = process.argv[2]
  ;({ create, scenario: () => scenario(process.argv[3]), validated, cleanup }[cmd] ?? (() => { throw new Error('usage: create | scenario <safe|ambiguous|none> | validated | cleanup') }))()
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1) })
}
