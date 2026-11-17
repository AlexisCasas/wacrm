/* eslint-disable @typescript-eslint/no-require-imports -- standalone CommonJS QA script (node), not part of the app bundle */
// LOCAL ONLY (refuses anything but http://127.0.0.1:55321). Env: LOCAL_URL, LOCAL_SERVICE, LOCAL_ANON (from `npx supabase status -o env`).
// End-to-end check of the handoff through the real stack (GoTrue login -> PostgREST -> Realtime postgres_changes).
// Synthetic users/account with random passwords that live only in this process; everything created is deleted at the end.
const { createRequire } = require('node:module')
const crypto = require('node:crypto')
const req = createRequire('C:/WACRM-LOCAL/package.json')
const { createClient } = req('@supabase/supabase-js')

const URL_ = process.env.LOCAL_URL
if (!/^http:\/\/127\.0\.0\.1:55321$/.test(URL_)) throw new Error('refusing to run against ' + URL_)
const admin = createClient(URL_, process.env.LOCAL_SERVICE, { auth: { persistSession: false } })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tag = 'rt' + crypto.randomBytes(3).toString('hex')
const created = { users: [], accounts: new Set() }
const results = []
const check = (name, ok, extra = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')) }

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
  const { error: fe } = await admin.from('order_integration_settings').upsert({ account_id: acc, logistics_mvp_enabled: true }); if (fe) throw fe

  const { data: contact } = await admin.from('contacts').insert({ user_id: owner.id, account_id: acc, phone: '5199' + Math.floor(Math.random() * 1e8), name: 'RT ' + tag }).select('id').single()
  const { data: conv } = await admin.from('conversations').insert({ user_id: owner.id, account_id: acc, contact_id: contact.id }).select('id').single()
  const send = async (sender, text) => { const { error } = await admin.from('messages').insert({ conversation_id: conv.id, sender_type: sender, content_type: 'text', content_text: text }); if (error) throw error }
  await send('customer', 'hola'); await send('agent', 'respuesta de comercial')

  for (const u of [sup, comm, logi, none]) {
    const { error } = await u.client.auth.signInWithPassword({ email: u.email, password: u.password }); if (error) throw error
  }

  // ---- subscriptions (opened BEFORE the handoff, like an Inbox that is already open) ----
  const events = { sup: [], comm: [], logi: [], none: [] }
  const channels = []
  for (const u of [sup, comm, logi, none]) {
    await new Promise((resolve, reject) => {
      const ch = u.client.channel('rt-' + u.label)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) => { if (p.new.conversation_id === conv.id) events[u.label].push(p.new.content_text) })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversations' }, (p) => { if (p.new.id === conv.id) events[u.label].push('conv-update') })
        .subscribe((status) => { if (status === 'SUBSCRIBED') resolve(); if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error(u.label + ' ' + status)) })
      channels.push(ch)
    })
  }
  await sleep(800)
  const got = async (fn) => { for (const k of Object.keys(events)) events[k] = []; await fn(); await sleep(2500); return Object.fromEntries(Object.entries(events).map(([k, v]) => [k, v.length > 0])) }
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

  // PostgREST reads as each user
  const sel = async (u, table, col) => { const { data, error } = await u.client.from(table).select('id').eq(col, table === 'conversations' ? conv.id : conv.id); return error ? 'ERR' : data.length }
  const readRow = async (u) => `${await sel(u, 'conversations', 'id')}/${await sel(u, 'messages', 'conversation_id')}`
  const matrix = async () => ({ sup: await readRow(sup), comm: await readRow(comm), logi: await readRow(logi), none: await readRow(none) })

  // ===== PRE (no order) =====
  let r = await matrix()
  check('PRE  PostgREST read (conv/messages): sup 1/2, comm 1/2, logi 0/0, none 0/0', eq(r, { sup: '1/2', comm: '1/2', logi: '0/0', none: '0/0' }), JSON.stringify(r))
  let ev = await got(() => send('customer', 'pre: mensaje nuevo del cliente'))
  check('PRE  Realtime: sup + comm receive, logi + none do NOT', eq(ev, { sup: true, comm: true, logi: false, none: false }), JSON.stringify(ev))

  // commercial sends a reply while PRE (real PostgREST insert as the user)
  const { error: insPre } = await comm.client.from('messages').insert({ conversation_id: conv.id, sender_type: 'agent', content_type: 'text', content_text: 'comercial responde (PRE)' })
  check('PRE  commercial can write a message', !insPre, insPre ? insPre.message : '')
  const { error: insLogiPre } = await logi.client.from('messages').insert({ conversation_id: conv.id, sender_type: 'agent', content_type: 'text', content_text: 'logistica NO deberia' })
  check('PRE  logistics cannot write a message', !!insLogiPre, insLogiPre ? insLogiPre.code : 'no error')

  // ===== HANDOFF: the order is persisted =====
  const { data: ord, error: oe } = await admin.from('order_confirmations').insert({ account_id: acc, conversation_id: conv.id, customer_name: 'RT cliente', phone: '900000000', product: 'Prod', quantity: 1, price: 10, destination: 'Lima', seller_name: 'Seller', confirmed_by_name: 'Seller', request_key: 'RT-' + tag, delivery_status: 'held' }).select('id').single()
  if (oe) throw oe
  // PR-03: the stage comes from conversation_routing, which create_order_confirmation writes with the order. This script inserts the order directly, so apply the same internal step.
  { const { error: re } = await admin.rpc('apply_order_confirmed_routing', { p_account: acc, p_conversation: conv.id, p_actor: null, p_actor_name: 'RT', p_order: ord.id }); if (re) throw re }
  r = await matrix()
  check('POST PostgREST read: sup 1/4, comm 0/0, logi 1/4 (the SAME conversation, whole history), none 0/0', eq(r, { sup: '1/4', comm: '0/0', logi: '1/4', none: '0/0' }), JSON.stringify(r))
  const { data: hist } = await logi.client.from('messages').select('content_text, sender_type').eq('conversation_id', conv.id).order('created_at')
  check('POST logistics reads the customer AND the commercial messages', hist && hist.some((m) => m.content_text === 'respuesta de comercial') && hist.some((m) => m.content_text === 'hola') && hist.some((m) => m.content_text === 'comercial responde (PRE)'), hist ? hist.length + ' msgs' : 'none')
  ev = await got(() => send('customer', 'post: el cliente vuelve a escribir'))
  check('POST Realtime (channels opened BEFORE the handoff): sup + logi receive, comm + none do NOT', eq(ev, { sup: true, comm: false, logi: true, none: false }), JSON.stringify(ev))
  const { error: insComm } = await comm.client.from('messages').insert({ conversation_id: conv.id, sender_type: 'agent', content_type: 'text', content_text: 'comercial NO deberia' })
  check('POST commercial cannot write', !!insComm, insComm ? insComm.code : 'no error')
  const { error: insLogi } = await logi.client.from('messages').insert({ conversation_id: conv.id, sender_type: 'agent', content_type: 'text', content_text: 'logistica responde (POST)' })
  check('POST logistics can write', !insLogi, insLogi ? insLogi.message : '')
  const { data: upd } = await comm.client.from('conversations').update({ unread_count: 0 }).eq('id', conv.id).select('id')
  check('POST commercial cannot update the conversation', !upd || upd.length === 0)
  const { data: upd2 } = await logi.client.from('conversations').update({ unread_count: 0 }).eq('id', conv.id).select('id')
  check('POST logistics can update the conversation (mark as read)', upd2 && upd2.length === 1)

  // ===== FLAG OFF: legacy =====
  await admin.from('order_integration_settings').update({ logistics_mvp_enabled: false }).eq('account_id', acc)
  r = await matrix()
  const n = (await admin.from('messages').select('id').eq('conversation_id', conv.id)).data.length
  check('OFF  everyone of the account reads it (legacy)', eq(r, { sup: `1/${n}`, comm: `1/${n}`, logi: `1/${n}`, none: `1/${n}` }), JSON.stringify(r))
  ev = await got(() => send('customer', 'off: legacy'))
  check('OFF  Realtime: every member receives (legacy)', eq(ev, { sup: true, comm: true, logi: true, none: true }), JSON.stringify(ev))
  await admin.from('order_integration_settings').update({ logistics_mvp_enabled: true }).eq('account_id', acc)

  for (const ch of channels) await ch.unsubscribe()
}

main()
  .catch((e) => { console.error('ERR', e && e.message ? e.message : e); results.push(false) })
  .finally(async () => {
    // cleanup of everything synthetic
    try {
      // Accounts first (cascades profiles/contacts/conversations/messages/orders), then the auth users.
      for (const a of created.accounts) { const { error } = await admin.from('accounts').delete().eq('id', a); if (error) console.error('cleanup account:', error.message) }
      for (const id of created.users) { const { error } = await admin.auth.admin.deleteUser(id); if (error) console.error('cleanup user:', error.message) }
    } catch (e) { console.error('cleanup', e.message) }
    console.log(results.every(Boolean) ? 'ALL REALTIME/RLS CHECKS PASSED' : 'SOME CHECKS FAILED')
    process.exit(results.every(Boolean) ? 0 : 1)
  })
