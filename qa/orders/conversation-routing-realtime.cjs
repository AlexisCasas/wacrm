/* eslint-disable @typescript-eslint/no-require-imports -- standalone CommonJS QA script (node), not part of the app bundle */
// LOCAL ONLY (refuses anything but http://127.0.0.1:55321). Env: LOCAL_URL, LOCAL_SERVICE, LOCAL_ANON (from `npx supabase status -o env`).
// End-to-end check of the Comercial / Logistica / shared routing through the real stack (GoTrue login -> PostgREST -> Realtime postgres_changes).
// Synthetic users/account with random passwords that live only in this process; everything created is deleted at the end.
const { createRequire } = require('node:module')
const crypto = require('node:crypto')
const req = createRequire('C:/WACRM-LOCAL/package.json')
const { createClient } = req('@supabase/supabase-js')

const URL_ = process.env.LOCAL_URL
if (!/^http:\/\/127\.0\.0\.1:55321$/.test(URL_)) throw new Error('refusing to run against ' + URL_)
const admin = createClient(URL_, process.env.LOCAL_SERVICE, { auth: { persistSession: false } })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tag = 'rr' + crypto.randomBytes(3).toString('hex')
const created = { users: [], accounts: new Set() }
const results = []
const check = (name, ok, extra = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')) }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

async function mkUser(label) {
  const password = crypto.randomBytes(18).toString('base64url')
  const email = `${tag}-${label}@example.invalid`
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) throw error
  created.users.push(data.user.id)
  const client = createClient(URL_, process.env.LOCAL_ANON, { auth: { persistSession: false, autoRefreshToken: false } })
  return { label, id: data.user.id, email, password, client }
}

async function main() {
  const owner = await mkUser('owner')
  const sup = await mkUser('sup'); const comm = await mkUser('comm'); const logi = await mkUser('logi'); const none = await mkUser('none')
  const { data: ownerProfile } = await admin.from('profiles').select('account_id').eq('user_id', owner.id).single()
  const acc = ownerProfile.account_id
  for (const u of [owner, sup, comm, logi, none]) {
    const { data: p } = await admin.from('profiles').select('account_id').eq('user_id', u.id).single()
    created.accounts.add(p.account_id)
  }
  for (const [u, role] of [[sup, 'supervisor'], [comm, 'commercial'], [logi, 'logistics'], [none, null]]) {
    const { error } = await admin.from('profiles').update({ account_id: acc, account_role: 'agent' }).eq('user_id', u.id); if (error) throw error
    const { error: e2 } = await admin.from('profiles').update({ operational_role: role }).eq('user_id', u.id); if (e2) throw e2
  }
  const { error: fe } = await admin.from('order_integration_settings').upsert({ account_id: acc, confirm_enabled: true, logistics_mvp_enabled: true }); if (fe) throw fe

  const { data: contact } = await admin.from('contacts').insert({ user_id: owner.id, account_id: acc, phone: '5199' + Math.floor(Math.random() * 1e8), name: 'RR ' + tag }).select('id').single()
  const { data: conv } = await admin.from('conversations').insert({ user_id: owner.id, account_id: acc, contact_id: contact.id }).select('id').single()
  const send = async (sender, text) => { const { error } = await admin.from('messages').insert({ conversation_id: conv.id, sender_type: sender, content_type: 'text', content_text: text }); if (error) throw error }
  await send('customer', 'hola, quiero comprar'); await send('agent', 'respuesta de comercial')

  for (const u of [sup, comm, logi, none]) {
    const { error } = await u.client.auth.signInWithPassword({ email: u.email, password: u.password }); if (error) throw error
  }

  // ---- subscriptions opened BEFORE any transition (like an Inbox that is already open) ----
  const events = { sup: [], comm: [], logi: [], none: [] }
  const channels = []
  for (const u of [sup, comm, logi, none]) {
    await new Promise((resolve, reject) => {
      const ch = u.client.channel('rr-' + u.label)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) => { if (p.new.conversation_id === conv.id) events[u.label].push('msg:' + p.new.content_text) })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'conversation_routing' }, (p) => { if (p.new && p.new.conversation_id === conv.id) events[u.label].push('route:' + p.new.stage) })
        .subscribe((status) => { if (status === 'SUBSCRIBED') resolve(); if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error(u.label + ' ' + status)) })
      channels.push(ch)
    })
  }
  await sleep(800)
  const watch = async (fn) => { for (const k of Object.keys(events)) events[k] = []; await fn(); await sleep(2500); return events }
  const got = (ev, prefix) => Object.fromEntries(Object.entries(ev).map(([k, v]) => [k, v.some((x) => x.startsWith(prefix))]))

  const read = async (u) => {
    const c = await u.client.from('conversations').select('id').eq('id', conv.id)
    const m = await u.client.from('messages').select('id').eq('conversation_id', conv.id)
    return `${c.error ? 'ERR' : c.data.length}/${m.error ? 'ERR' : m.data.length}`
  }
  const matrix = async () => ({ sup: await read(sup), comm: await read(comm), logi: await read(logi), none: await read(none) })
  const routing = async () => (await admin.from('conversation_routing').select('stage, version').eq('conversation_id', conv.id)).data
  const nEvents = async () => (await admin.from('conversation_routing_events').select('id').eq('conversation_id', conv.id)).data.length
  const confirm = async (key) => {
    const { data, error } = await admin.rpc('create_order_confirmation', {
      p_account: acc, p_contact: contact.id, p_conversation: conv.id, p_actor: comm.id, p_actor_name: 'Comercial RR', p_request_key: key, p_seller: comm.id,
      p_fields: { customer_name: 'RR cliente', phone: '900000000', product: 'Prod', quantity: '1', price: '10.00', destination: 'Lima' },
    })
    if (error) throw error
    return data
  }

  // ===== CASE A: commercial stage =====
  let r = await matrix()
  check('A  commercial stage, reads (conv/messages): sup 1/2, comm 1/2, logi 0/0, none 0/0', eq(r, { sup: '1/2', comm: '1/2', logi: '0/0', none: '0/0' }), JSON.stringify(r))
  let ev = await watch(() => send('customer', 'pre: nuevo mensaje'))
  check('A  Realtime messages: sup + comm receive; logi + none do NOT', eq(got(ev, 'msg:'), { sup: true, comm: true, logi: false, none: false }), JSON.stringify(got(ev, 'msg:')))

  ev = await watch(() => confirm(tag + '-O1'))
  check('A  order 1 confirmed: routing row logistics v1 + 1 event (atomic with the order)', eq(await routing(), [{ stage: 'logistics', version: 1 }]) && (await nEvents()) === 1)
  r = await matrix()
  check('A  logistics stage, reads: sup 1/3, comm 0/0, logi 1/3 (same chat, whole history), none 0/0', eq(r, { sup: '1/3', comm: '0/0', logi: '1/3', none: '0/0' }), JSON.stringify(r))
  ev = await watch(() => send('customer', 'logistica: el cliente escribe'))
  check('A  Realtime (channels opened before the handoff): sup + logi receive; comm + none do NOT', eq(got(ev, 'msg:'), { sup: true, comm: false, logi: true, none: false }), JSON.stringify(got(ev, 'msg:')))
  const { error: insComm } = await comm.client.from('messages').insert({ conversation_id: conv.id, sender_type: 'agent', content_type: 'text', content_text: 'comercial NO deberia' })
  check('A  commercial cannot write once the chat is logistics', !!insComm, insComm ? insComm.code : 'no error')
  const { error: wr } = await logi.client.from('conversation_routing').update({ stage: 'commercial' }).eq('conversation_id', conv.id)
  check('A  a browser cannot write the routing table', !!wr, wr ? wr.code : 'no error')

  // ===== CASE B: logistics derives to commercial =====
  const bad = await comm.client.rpc('derive_conversation_to_commercial', { p_conversation_id: conv.id })
  check('B  commercial cannot derive', !!bad.error && bad.error.code === '42501', bad.error ? bad.error.code : 'no error')
  ev = await watch(async () => { const d = await logi.client.rpc('derive_conversation_to_commercial', { p_conversation_id: conv.id }); check('B  logistics derives: shared / changed', !d.error && eq(d.data, [{ stage: 'shared', changed: true }]), JSON.stringify(d.error || d.data)) })
  check('B  Realtime routing event reaches commercial (newly visible row), logistics and supervisor; not the user without area', eq(got(ev, 'route:'), { sup: true, comm: true, logi: true, none: false }), JSON.stringify(got(ev, 'route:')))
  const again = await logi.client.rpc('derive_conversation_to_commercial', { p_conversation_id: conv.id })
  check('B  derive again: idempotent (shared / not changed), no extra event', !again.error && eq(again.data, [{ stage: 'shared', changed: false }]) && (await nEvents()) === 2, JSON.stringify(again.error || again.data))
  const [d1, d2] = await Promise.all([logi.client.rpc('derive_conversation_to_commercial', { p_conversation_id: conv.id }), sup.client.rpc('derive_conversation_to_commercial', { p_conversation_id: conv.id })])
  check('B  concurrent derive calls: both answer shared, still 2 events', !d1.error && !d2.error && (await nEvents()) === 2)
  r = await matrix()
  check('B  shared stage, reads: sup, comm and logi all see the SAME chat with the same history', eq(r, { sup: '1/4', comm: '1/4', logi: '1/4', none: '0/0' }), JSON.stringify(r))
  ev = await watch(() => send('customer', 'shared: quiero comprar otro producto'))
  check('B  Realtime messages on shared: sup + comm + logi receive; none does NOT', eq(got(ev, 'msg:'), { sup: true, comm: true, logi: true, none: false }), JSON.stringify(got(ev, 'msg:')))
  const { error: insC2 } = await comm.client.from('messages').insert({ conversation_id: conv.id, sender_type: 'agent', content_type: 'text', content_text: 'comercial atiende la nueva venta' })
  check('B  commercial can answer on a shared chat', !insC2, insC2 ? insC2.message : '')
  const { error: insL2 } = await logi.client.from('messages').insert({ conversation_id: conv.id, sender_type: 'agent', content_type: 'text', content_text: 'logistica sigue con el pedido 1' })
  check('B  logistics can still answer on a shared chat', !insL2, insL2 ? insL2.message : '')

  // ===== CASE C: commercial confirms order 2 -> back to logistics =====
  await confirm(tag + '-O2')
  const st = await routing()
  check('C  order 2 confirmed: shared -> logistics (v3) in the same transaction', eq(st, [{ stage: 'logistics', version: 3 }]) && (await nEvents()) === 3, JSON.stringify(st))
  const retry = await confirm(tag + '-O2')
  check('C  retry of the same request_key changes nothing', (await nEvents()) === 3 && eq(await routing(), [{ stage: 'logistics', version: 3 }]), JSON.stringify(retry))
  const orders = (await admin.from('order_confirmations').select('id').eq('conversation_id', conv.id)).data.length
  check('C  both orders remain on the same conversation', orders === 2, String(orders))
  r = await matrix()
  const nMsgs = (await admin.from('messages').select('id').eq('conversation_id', conv.id)).data.length
  check('C  logistics stage again: sup + logi read everything, comm 0/0', eq(r, { sup: `1/${nMsgs}`, comm: '0/0', logi: `1/${nMsgs}`, none: '0/0' }), JSON.stringify(r))
  ev = await watch(() => send('customer', 'otra vez logistica'))
  check('C  Realtime: sup + logi receive; comm + none do NOT', eq(got(ev, 'msg:'), { sup: true, comm: false, logi: true, none: false }), JSON.stringify(got(ev, 'msg:')))
  const ledger = (await admin.from('conversation_routing_events').select('from_stage, to_stage, reason').eq('conversation_id', conv.id).order('created_at')).data
  check('C  audit trail', eq(ledger, [
    { from_stage: 'commercial', to_stage: 'logistics', reason: 'order_confirmed' },
    { from_stage: 'logistics', to_stage: 'shared', reason: 'derived_to_commercial' },
    { from_stage: 'shared', to_stage: 'logistics', reason: 'order_confirmed' },
  ]), JSON.stringify(ledger))

  // ===== CONCURRENCY / IDEMPOTENCE through the real stack (second chat, still commercial) =====
  const { data: contact2 } = await admin.from('contacts').insert({ user_id: owner.id, account_id: acc, phone: '5198' + Math.floor(Math.random() * 1e8), name: 'RR2 ' + tag }).select('id').single()
  const { data: conv2, error: conv2Err } = await admin.from('conversations').insert({ user_id: owner.id, account_id: acc, contact_id: contact2.id }).select('id').single()
  if (conv2Err) throw conv2Err
  const confirm2 = async (key, fields) => admin.rpc('create_order_confirmation', {
    p_account: acc, p_contact: contact2.id, p_conversation: conv2.id, p_actor: comm.id, p_actor_name: 'Comercial RR', p_request_key: key, p_seller: comm.id,
    p_fields: fields || { customer_name: 'RR cliente', phone: '900000000', product: 'Prod', quantity: '1', price: '10.00', destination: 'Lima' },
  })
  const state2 = async () => ({
    routing: (await admin.from('conversation_routing').select('stage, version').eq('conversation_id', conv2.id)).data,
    events: (await admin.from('conversation_routing_events').select('id').eq('conversation_id', conv2.id)).data.length,
    orders: (await admin.from('order_confirmations').select('id').eq('conversation_id', conv2.id)).data.length,
  })
  const badOrder = await confirm2(tag + '-BAD', { customer_name: 'x', phone: '900000000', product: 'Prod', quantity: '1', destination: 'Lima' })
  check('D  an order that fails leaves routing, events and orders untouched', !!badOrder.error && eq(await state2(), { routing: [], events: 0, orders: 0 }), badOrder.error ? badOrder.error.code : 'no error')
  const same = await Promise.all([1, 2, 3, 4].map(() => confirm2(tag + '-C1')))
  check('D  4 concurrent confirmations, SAME request_key: no error, ONE order, ONE transition', same.every((x) => !x.error) && eq(await state2(), { routing: [{ stage: 'logistics', version: 1 }], events: 1, orders: 1 }), JSON.stringify(await state2()))
  check('D  the 4 answers carry the same order id (1 created, 3 replays)', new Set(same.map((x) => x.data[0].order_id)).size === 1 && same.filter((x) => x.data[0].created).length === 1)
  const [dd1, dd2, dd3, dd4] = await Promise.all([logi, sup, logi, sup].map((u) => u.client.rpc('derive_conversation_to_commercial', { p_conversation_id: conv2.id })))
  check('D  4 concurrent derives (double click / 2 users): all succeed, exactly ONE changed', [dd1, dd2, dd3, dd4].every((x) => !x.error) && [dd1, dd2, dd3, dd4].filter((x) => x.data[0].changed).length === 1, JSON.stringify([dd1.error, dd2.error, dd3.error, dd4.error]))
  check('D  after the concurrent derives: shared v2, 2 events', eq((await state2()).routing, [{ stage: 'shared', version: 2 }]) && (await state2()).events === 2)
  const diff = await Promise.all([confirm2(tag + '-C2'), confirm2(tag + '-C3'), confirm2(tag + '-C2')])
  const s2 = await state2()
  check('D  concurrent confirmations on a shared chat (2 new keys + 1 replay): ONE shared->logistics transition, 3 orders', diff.every((x) => !x.error) && eq(s2.routing, [{ stage: 'logistics', version: 3 }]) && s2.events === 3 && s2.orders === 3, JSON.stringify(s2))
  const raced = await Promise.all([confirm2(tag + '-C4'), logi.client.rpc('derive_conversation_to_commercial', { p_conversation_id: conv2.id })])
  const s3 = await state2()
  const evs = (await admin.from('conversation_routing_events').select('from_stage, to_stage, reason').eq('conversation_id', conv2.id).order('created_at')).data
  const legal = eq(evs.map((e) => e.from_stage + '>' + e.to_stage), ['commercial>logistics', 'logistics>shared', 'shared>logistics']) || eq(evs.map((e) => e.from_stage + '>' + e.to_stage), ['commercial>logistics', 'logistics>shared', 'shared>logistics', 'logistics>shared']) || eq(evs.map((e) => e.from_stage + '>' + e.to_stage), ['commercial>logistics', 'logistics>shared', 'shared>logistics', 'logistics>shared', 'shared>logistics'])
  check('D  confirm racing derive: the history stays a legal chain (no duplicated or skipped transition)', !raced[0].error && legal && s3.orders === 4, JSON.stringify(evs))

  // ===== FLAG OFF: legacy =====
  await admin.from('order_integration_settings').update({ logistics_mvp_enabled: false }).eq('account_id', acc)
  r = await matrix()
  check('OFF everyone of the account reads it (legacy)', eq(r, { sup: `1/${nMsgs + 1}`, comm: `1/${nMsgs + 1}`, logi: `1/${nMsgs + 1}`, none: `1/${nMsgs + 1}` }), JSON.stringify(r))
  ev = await watch(() => send('customer', 'off: legacy'))
  check('OFF Realtime: every member receives (legacy)', eq(got(ev, 'msg:'), { sup: true, comm: true, logi: true, none: true }), JSON.stringify(got(ev, 'msg:')))
  const offDerive = await logi.client.rpc('derive_conversation_to_commercial', { p_conversation_id: conv.id })
  check('OFF derive is refused', !!offDerive.error && offDerive.error.code === '42501', offDerive.error ? offDerive.error.message : 'no error')

  for (const ch of channels) await ch.unsubscribe()
}

main()
  .catch((e) => { console.error('ERR', e && e.message ? e.message : e); results.push(false) })
  .finally(async () => {
    try {
      // Accounts first (cascades profiles/contacts/conversations/messages/orders/routing), then the auth users.
      for (const a of created.accounts) { const { error } = await admin.from('accounts').delete().eq('id', a); if (error) console.error('cleanup account:', error.message) }
      for (const id of created.users) { const { error } = await admin.auth.admin.deleteUser(id); if (error) console.error('cleanup user:', error.message) }
    } catch (e) { console.error('cleanup', e.message) }
    console.log(results.every(Boolean) ? 'ALL ROUTING REALTIME CHECKS PASSED' : 'SOME CHECKS FAILED')
    process.exit(results.every(Boolean) ? 0 : 1)
  })
