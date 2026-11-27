// Synthetic world of the LOG-00H QA: clients, factories (through the real database functions wherever one exists) and snapshots.
// LOCAL ONLY: refuses anything but the throwaway local Supabase. Every name, phone and document number here is invented.
import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

import { createClient } from '@supabase/supabase-js'

export const SUPABASE_URL = process.env.LOCAL_URL
if (SUPABASE_URL !== 'http://127.0.0.1:55321') throw new Error(`refusing to run against ${SUPABASE_URL}`)

const noSession = { auth: { persistSession: false, autoRefreshToken: false } }
export const admin = createClient(SUPABASE_URL, process.env.LOCAL_SERVICE, noSession)
export const anonClient = () => createClient(SUPABASE_URL, process.env.LOCAL_ANON, noSession)

export const PRIVATE_DIR = `${process.env.QA_DIR}/private`
export const WORLD_FILE = `${PRIVATE_DIR}/world.json`
export const saveWorld = (world) => writeFileSync(WORLD_FILE, JSON.stringify(world, null, 2), { mode: 0o600 })
export const loadWorld = () => JSON.parse(readFileSync(WORLD_FILE, 'utf8'))

/** Unwraps a supabase-js answer; a database error is an exception with its message. */
export async function must(query, what) {
  const { data, error } = await query
  if (error) throw new Error(`${what}: ${error.code ?? ''} ${error.message}`)
  return data
}
export async function rpc(name, args) {
  const data = await must(admin.rpc(name, args), name)
  if (data && !Array.isArray(data) && data.ok === false) throw new Error(`${name} refused: ${data.reason}`)
  return data
}

export async function signedIn(world, userKey) {
  const user = world.users[userKey]
  const client = anonClient()
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password })
  if (error) throw new Error(`sign in ${userKey}: ${error.message}`)
  return client
}

export const money = (n) => Number(n).toFixed(2)
const rid = () => randomBytes(4).toString('hex')
export const fakePhone = () => `51900${String(randomInt(0, 1_000_000)).padStart(6, '0')}`

/** A contact + chat with a couple of invented messages. */
export async function mkConversation(world, accKey, label) {
  const acc = world.accounts[accKey]
  const phone = fakePhone()
  const name = `Contacto QA ${label}`
  // Restricted tables are seeded only through the local postgres connection in this disposable database.
  const ownerId = world.users[`${accKey}-OWN`].id
  const contactId = randomUUID()
  const conversationId = randomUUID()
  const now = new Date().toISOString()
  const literal = (value) => "'" + String(value).replace(/'/g, "''") + "'"
  const sql = [
    `insert into public.contacts (id, user_id, account_id, phone, name) values (${literal(contactId)}::uuid, ${literal(ownerId)}::uuid, ${literal(acc)}::uuid, ${literal(phone)}, ${literal(name)});`,
    `insert into public.conversations (id, user_id, account_id, contact_id, last_message_text, last_message_at) values (${literal(conversationId)}::uuid, ${literal(ownerId)}::uuid, ${literal(acc)}::uuid, ${literal(contactId)}::uuid, ${literal(`Mensaje sintético ${label}`)}, ${literal(now)}::timestamptz);`,
    `insert into public.messages (conversation_id, sender_type, content_type, content_text, status) values (${literal(conversationId)}::uuid, 'customer', 'text', ${literal(`Hola, consulta sintética ${label}`)}, 'delivered'), (${literal(conversationId)}::uuid, 'agent', 'text', 'Respuesta sintética de QA', 'read');`
  ].join('\n')
  execFileSync('psql', [process.env.QA_DB_URL, '-X', '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'inherit' })
  return { conversationId, contactId, phone, label }
}

/** Chat placed directly in the logistics stage without any tracked order (the historical case). */
export async function toLogisticsStage(world, accKey, conversationId) {
  await must(admin.from('conversation_routing').insert({
    conversation_id: conversationId, account_id: world.accounts[accKey], stage: 'logistics', updated_by: world.users[`${accKey}-LOG`].id, version: 1,
  }), 'routing')
}

export async function mkCatalog(world, accKey, label) {
  const key = `qa-${label}-${rid()}`.toLowerCase()
  const name = `QA Producto ${label} ${rid()}`
  const row = await must(admin.from('audio_guide_products').insert({ account_id: world.accounts[accKey], product_key: key, display_name: name }).select('id').single(), 'catalog')
  return { id: row.id, name }
}
export const setCatalogActive = (id, active) => must(admin.from('audio_guide_products').update({ active }).eq('id', id), 'catalog active')

/**
 * Confirms an order through create_order_confirmation (routing and financial row follow, as in the product).
 * Without `items` it is an order without lines ("legacy"): `product`, `quantity`, `total`.
 */
export async function mkOrder(world, accKey, spec = {}) {
  const label = spec.label ?? rid()
  const conv = spec.conversation ?? (await mkConversation(world, accKey, label))
  const seller = world.users[`${accKey}-COM`]
  const items = spec.items?.map((l) => ({ product_name: l.product_name, quantity: String(l.quantity), unit_price: money(l.unit_price), ...(l.catalog_product_id ? { catalog_product_id: l.catalog_product_id } : {}) }))
  const total = items ? items.reduce((s, l) => s + Number(l.quantity) * Number(l.unit_price), 0) : (spec.total ?? 100)
  const fields = {
    customer_name: spec.customer_name ?? `Cliente QA ${label} ${rid()}`,
    dni: spec.dni ?? `000000${String(randomInt(10, 99))}`,
    phone: conv.phone,
    product: items ? items.map((l) => `${l.quantity} x ${l.product_name}`).join('\n') : (spec.product ?? `Producto QA ${label}`),
    quantity: String(items ? items.reduce((s, l) => s + Number(l.quantity), 0) : (spec.quantity ?? 1)),
    price: money(total),
    destination: spec.destination ?? 'Destino QA',
    agency: spec.agency ?? 'Shalom',
    order_description: spec.order_description ?? '',
    ...(items ? { items } : {}),
  }
  const data = await must(admin.rpc('create_order_confirmation', {
    p_account: world.accounts[accKey], p_contact: conv.contactId, p_conversation: conv.conversationId, p_actor: seller.id, p_actor_name: seller.name,
    p_request_key: `qa-${label}-${rid()}`, p_seller: seller.id, p_fields: fields,
  }), 'create_order_confirmation')
  const row = Array.isArray(data) ? data[0] : data
  return { orderId: row.order_id, conversationId: conv.conversationId, contactId: conv.contactId, account: accKey, customer_name: fields.customer_name, product: fields.product, conversation: conv }
}

const actor = (world, order, area) => ({ p_account: world.accounts[order.account], p_actor: world.users[`${order.account}-${area}`].id })

export const correctTotal = (world, order, total, reason = 'corrección sintética') =>
  rpc('correct_order_total', { ...actor(world, order, 'SUP'), p_order: order.orderId, p_new_total: money(total), p_reason: reason })
export const editOrder = (world, order, fields, reason = 'preparación QA') =>
  rpc('edit_order_confirmation', { ...actor(world, order, 'LOG'), p_order: order.orderId, p_fields: fields, p_reason: reason })
export const cancelOrder = (world, order, reason = 'anulación sintética') =>
  rpc('cancel_order_confirmation', { ...actor(world, order, 'SUP'), p_order: order.orderId, p_reason: reason, p_ack_paid: true })

export async function registerPayment(world, order, amount, { kind = 'advance', requestKey = `qa-pay-${randomUUID()}` } = {}) {
  return rpc('register_order_payment', {
    ...actor(world, order, 'LOG'), p_order: order.orderId, p_request_key: requestKey, p_amount: money(amount), p_kind: kind, p_method: 'yape', p_operation_number: null,
    p_paid_at: new Date(Date.now() - 3_600_000).toISOString(), p_evidence: null, p_notes: null, p_source: 'manual',
  })
}
export const confirmPayment = (world, order, paymentId) =>
  rpc('confirm_order_payment', { ...actor(world, order, 'LOG'), p_payment: paymentId, p_expected_version: null, p_overpayment_reason: null })
export const rejectPayment = (world, order, paymentId) =>
  rpc('reject_order_payment', { ...actor(world, order, 'LOG'), p_payment: paymentId, p_expected_version: null, p_reason: 'comprobante ilegible (sintético)' })
export const voidPayment = (world, order, paymentId) =>
  rpc('void_order_payment', { ...actor(world, order, 'SUP'), p_payment: paymentId, p_expected_version: null, p_reason: 'error sintético' })
export async function payAndConfirm(world, order, amount, kind) {
  const r = await registerPayment(world, order, amount, { kind })
  await confirmPayment(world, order, r.payment_id)
  return r.payment_id
}

/** Leaves an order in ready_for_dispatch (same rows as the repository's PR-05 test support), then delivers and pays it: finalized. */
export async function finalize(world, order, total) {
  const account = world.accounts[order.account]
  const who = world.users[`${order.account}-LOG`].id
  const now = new Date().toISOString()
  const mkDoc = async (kind) => {
    const id = randomUUID()
    const base = {
      id, account_id: account, order_id: order.orderId, kind, association: 'direct', request_key: `qa-${kind}-${rid()}`,
      storage_path: `account-${account}/orders/${order.orderId}/${kind}s/${id}/f.pdf`, original_filename: 'qa.pdf', mime_type: 'application/pdf', size_bytes: 10,
      content_hash: randomBytes(32).toString('hex'), uploaded_by: who,
    }
    const row = kind === 'voucher'
      ? { ...base, status: 'validated', source: 'upload', version: 1, reviewed_data: { dni: '00000001' }, validated_by: who, validated_at: now }
      : { ...base, status: 'active', source: 'upload' }
    await must(admin.from('order_documents').insert(row), `document ${kind}`)
    return id
  }
  const voucher = await mkDoc('voucher')
  const evidence = await mkDoc('evidence')
  const dispatch = randomUUID()
  await must(admin.from('order_template_dispatches').insert({
    id: dispatch, account_id: account, order_id: order.orderId, request_key: `qa-d-${rid()}`, status: 'claimed', evidence_document_id: evidence,
    template_name: 'qa_template', template_language: 'es', actor_user_id: who, conversation_id: order.conversationId,
  }), 'dispatch claimed')
  await must(admin.from('order_template_dispatches').update({ status: 'sending', sending_at: now }).eq('id', dispatch), 'dispatch sending')
  await must(admin.from('order_template_dispatches').update({ status: 'sent', wamid: `wamid.QASYNTHETIC${rid()}`, finished_at: now }).eq('id', dispatch), 'dispatch sent')
  await must(admin.from('order_logistics').insert({
    order_id: order.orderId, account_id: account, status: 'ready_for_dispatch', voucher_document_id: voucher, validated_at: now, validated_by: who, evidence_document_id: evidence,
    packaging_started_at: now, packaging_started_by: who, packaging_completed_at: now, packaging_completed_by: who, completed_dispatch_id: dispatch,
  }), 'logistics ready')
  await rpc('mark_order_delivered_manual', { p_account: account, p_actor: who, p_order: order.orderId, p_note: 'entrega sintética' })
  await payAndConfirm(world, order, total, 'full')
}

/** Everything the tests compare before and after. */
export async function snapshot(orderId) {
  const one = async (table, columns, extra) => {
    let q = admin.from(table).select(columns).eq('order_id', orderId)
    if (extra) q = extra(q)
    return must(q, table)
  }
  const order = await must(admin.from('order_confirmations').select('customer_name, dni, phone, destination, agency, department, order_description, product, quantity, price').eq('id', orderId).single(), 'order')
  const [items, payments, financials, edits, corrections] = await Promise.all([
    one('order_confirmation_items', 'line_number, product_name, quantity, unit_price, item_type, catalog_product_id', (q) => q.order('line_number')),
    one('order_payments', 'amount, status, kind, request_key', (q) => q.order('created_at')),
    one('order_financials', 'paid_confirmed, financial_status'),
    one('order_edits', 'reason, changes', (q) => q.order('created_at')),
    one('order_total_corrections', 'old_total, new_total', (q) => q.order('created_at')),
  ])
  return {
    order: { ...order, price: Number(order.price) },
    items: items.map((i) => ({ ...i, unit_price: Number(i.unit_price) })),
    payments: payments.map((p) => ({ ...p, amount: Number(p.amount) })),
    financial: financials[0] ? { paid: Number(financials[0].paid_confirmed), status: financials[0].financial_status } : null,
    edits: edits.map((e) => ({ reason: e.reason, fields: Object.keys(e.changes ?? {}).sort() })),
    corrections: corrections.map((c) => ({ from: Number(c.old_total), to: Number(c.new_total) })),
  }
}

export async function routingState(conversationId) {
  const rows = await must(admin.from('conversation_routing').select('stage, version').eq('conversation_id', conversationId), 'routing')
  const events = await must(admin.from('conversation_routing_events').select('from_stage, to_stage, reason').eq('conversation_id', conversationId).order('created_at'), 'routing events')
  return { stage: rows[0]?.stage ?? 'commercial', version: rows[0]?.version ?? null, events }
}
