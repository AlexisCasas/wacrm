// Synthetic world of the LOG-00H QA: clients, factories and snapshots.
// Plain rows are prepared through the local postgres connection (db.mjs). Orders and payments are created with the database functions the app server
// calls (service role + acting user, re-validated by the database). The service role is otherwise used only to READ what the tests compare.
// LOCAL ONLY: refuses anything but the throwaway local Supabase. Every name, phone and document number here is invented.
import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

import { createClient } from '@supabase/supabase-js'

import { sqlRows } from './db.mjs'

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
  const phone = fakePhone()
  const contactId = randomUUID()
  const conversationId = randomUUID()
  sqlRows(`conversation ${label}`, `
    insert into public.contacts (id, user_id, account_id, phone, name)
      values (:'contact', :'owner', :'account', :'phone', :'name');
    insert into public.conversations (id, user_id, account_id, contact_id, last_message_text, last_message_at)
      values (:'conversation', :'owner', :'account', :'contact', :'preview', now());
    insert into public.messages (conversation_id, sender_type, content_type, content_text, status)
      values (:'conversation', 'customer', 'text', :'question', 'delivered'),
             (:'conversation', 'agent', 'text', 'Respuesta sintética de QA', 'read')
      returning id;
  `, {
    contact: contactId, conversation: conversationId, owner: world.users[`${accKey}-OWN`].id, account: world.accounts[accKey], phone,
    name: `Contacto QA ${label}`, preview: `Mensaje sintético ${label}`, question: `Hola, consulta sintética ${label}`,
  }, 2)
  return { conversationId, contactId, phone, label }
}

/** Chat placed directly in the logistics stage without any tracked order (the historical case). */
export async function toLogisticsStage(world, accKey, conversationId) {
  sqlRows('initial routing', `
    insert into public.conversation_routing (conversation_id, account_id, stage, updated_by, version)
      values (:'conversation', :'account', 'logistics', :'who', 1)
      returning conversation_id;
  `, { conversation: conversationId, account: world.accounts[accKey], who: world.users[`${accKey}-LOG`].id }, 1)
}

export async function mkCatalog(world, accKey, label) {
  const id = randomUUID()
  const key = `qa-${label}-${rid()}`.toLowerCase()
  const name = `QA Producto ${label} ${rid()}`
  sqlRows(`catalogue ${label}`, `
    insert into public.audio_guide_products (id, account_id, product_key, display_name)
      values (:'id', :'account', :'key', :'name') returning id;
  `, { id, account: world.accounts[accKey], key, name }, 1)
  return { id, name }
}
export const setCatalogActive = async (id, active) => {
  sqlRows('catalogue active', `update public.audio_guide_products set active = :'active' where id = :'id' returning id;`, { id, active: String(active) }, 1)
}

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
  const voucher = randomUUID()
  const evidence = randomUUID()
  const dispatch = randomUUID()
  const path = (kind, id) => `account-${account}/orders/${order.orderId}/${kind}s/${id}/f.pdf`
  // The dispatch goes claimed -> sending -> sent: the database guards that state machine, so it is walked step by step.
  sqlRows('ready for dispatch', `
    insert into public.order_documents (id, account_id, order_id, kind, association, request_key, storage_path, original_filename, mime_type, size_bytes,
        content_hash, uploaded_by, status, source, version, reviewed_data, validated_by, validated_at)
      values (:'voucher', :'account', :'order', 'voucher', 'direct', :'voucher_key', :'voucher_path', 'qa.pdf', 'application/pdf', 10,
        :'voucher_hash', :'who', 'validated', 'upload', 1, '{"dni":"00000001"}'::jsonb, :'who', now());
    insert into public.order_documents (id, account_id, order_id, kind, association, request_key, storage_path, original_filename, mime_type, size_bytes,
        content_hash, uploaded_by, status, source)
      values (:'evidence', :'account', :'order', 'evidence', 'direct', :'evidence_key', :'evidence_path', 'qa.pdf', 'application/pdf', 10,
        :'evidence_hash', :'who', 'active', 'upload');
    insert into public.order_template_dispatches (id, account_id, order_id, request_key, status, evidence_document_id, template_name, template_language, actor_user_id, conversation_id)
      values (:'dispatch', :'account', :'order', :'dispatch_key', 'claimed', :'evidence', 'qa_template', 'es', :'who', :'conversation');
    update public.order_template_dispatches set status = 'sending', sending_at = now() where id = :'dispatch';
    update public.order_template_dispatches set status = 'sent', wamid = :'wamid', finished_at = now() where id = :'dispatch';
    insert into public.order_logistics (order_id, account_id, status, voucher_document_id, validated_at, validated_by, evidence_document_id,
        packaging_started_at, packaging_started_by, packaging_completed_at, packaging_completed_by, completed_dispatch_id)
      values (:'order', :'account', 'ready_for_dispatch', :'voucher', now(), :'who', :'evidence', now(), :'who', now(), :'who', :'dispatch')
      returning order_id;
  `, {
    account, who, voucher, evidence, dispatch, order: order.orderId, conversation: order.conversationId,
    voucher_key: `qa-voucher-${rid()}`, voucher_path: path('voucher', voucher), voucher_hash: randomBytes(32).toString('hex'),
    evidence_key: `qa-evidence-${rid()}`, evidence_path: path('evidence', evidence), evidence_hash: randomBytes(32).toString('hex'),
    dispatch_key: `qa-d-${rid()}`, wamid: `wamid.QASYNTHETIC${rid()}`,
  }, 1)
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
