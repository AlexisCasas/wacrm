// Builds the synthetic world on an empty database: two accounts, four roles in each, catalogue, orders, payments and chats.
// Writes the identifiers (no credentials) to the results and the full world, with passwords, to a private file that is never published.
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'

import {
  PRIVATE_DIR, admin, cancelOrder, correctTotal, editOrder, finalize, mkCatalog, mkConversation, mkOrder, must, payAndConfirm, registerPayment, rejectPayment,
  confirmPayment, routingState, saveWorld, setCatalogActive, signedIn, toLogisticsStage, voidPayment,
} from './lib/world.mjs'

mkdirSync(PRIVATE_DIR, { recursive: true, mode: 0o700 })
const world = { accounts: {}, users: {}, orders: {}, conversations: {}, catalog: {} }

// ---- users: the signup trigger gives each one an account; they are then moved into account A or B ----
const SPEC = [
  ['OWN', 'owner', null],
  ['SUP', 'agent', 'supervisor'],
  ['LOG', 'agent', 'logistics'],
  ['COM', 'agent', 'commercial'],
  ['RO', 'viewer', 'logistics'],
]
for (const acc of ['A', 'B']) {
  for (const [area, accountRole, operationalRole] of SPEC) {
    const key = `${acc}-${area}`
    const email = `${key.toLowerCase()}@log00h.example.invalid`
    const password = randomBytes(18).toString('base64url')
    const name = `QA ${acc} ${area}`
    const created = await must(admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: name } }), `user ${key}`)
    const id = created.user.id
    const profile = await must(admin.from('profiles').select('account_id').eq('user_id', id).single(), `profile ${key}`)
    if (area === 'OWN') {
      world.accounts[acc] = profile.account_id
      await must(admin.from('accounts').update({ name: `QA Cuenta ${acc}` }).eq('id', profile.account_id), 'account name')
      await must(admin.from('profiles').update({ full_name: name }).eq('user_id', id), 'owner name')
    } else {
      await must(admin.from('profiles').update({ full_name: name, account_id: world.accounts[acc], account_role: accountRole }).eq('user_id', id), `move ${key}`)
      await must(admin.from('profiles').update({ operational_role: operationalRole }).eq('user_id', id), `area ${key}`)
      const { error } = await admin.from('accounts').delete().eq('id', profile.account_id)
      if (error) console.warn(`leftover account of ${key} not removed: ${error.code}`)
    }
    world.users[key] = { id, email, password, name }
  }
}

// ---- settings. InkaClick delivery OFF, no WhatsApp configuration at all, customer messages OFF ----
for (const acc of ['A', 'B']) {
  await must(admin.from('order_integration_settings').upsert({
    account_id: world.accounts[acc], enabled: false, confirm_enabled: true, multiproduct_enabled: true, product_tags_required: false, logistics_mvp_enabled: true,
  }), `integration ${acc}`)
}
// O3 is confirmed BEFORE payments are switched on: it stays untracked (historical)
world.orders.O3 = await mkOrder(world, 'A', { label: 'O3', total: 80 })
for (const acc of ['A', 'B']) {
  await must(admin.from('order_payment_settings').upsert({ account_id: world.accounts[acc], order_payments_enabled: true }), `payments ${acc}`)
  await must(admin.from('order_shipment_settings').upsert({ account_id: world.accounts[acc], shalom_tracking_enabled: true, destination_customer_message_enabled: false }), `shipments ${acc}`)
}

// ---- catalogue ----
const c1 = (world.catalog.CAT1 = await mkCatalog(world, 'A', 'uno'))
const c2 = (world.catalog.CAT2 = await mkCatalog(world, 'A', 'dos'))
const cx = (world.catalog.CATX = await mkCatalog(world, 'A', 'inactivo'))

// ---- orders ----
const line = (product_name, quantity, unit_price, catalog_product_id) => ({ product_name, quantity, unit_price, catalog_product_id })
const O = world.orders
O.O1 = await mkOrder(world, 'A', { label: 'O1', total: 100, quantity: 3 })
O.O2 = await mkOrder(world, 'A', { label: 'O2', total: 120, quantity: 2 })
O.O4 = await mkOrder(world, 'A', { label: 'O4', items: [line(c1.name, 1, 100, c1.id)] })
await correctTotal(world, O.O4, 90)
O.O5 = await mkOrder(world, 'A', { label: 'O5', items: [line(c1.name, 1, 60, c1.id), line(c2.name, 2, 20, c2.id), line('Línea manual QA', 1, 15)] })
O.O6 = await mkOrder(world, 'A', { label: 'O6', items: [line(c1.name, 1, 50, c1.id), line(cx.name, 1, 30, cx.id)] })
await setCatalogActive(cx.id, false)
O.O7 = await mkOrder(world, 'A', { label: 'O7', items: [line(c1.name, 1, 70, c1.id)] })
await editOrder(world, O.O7, { items: [{ product_name: c1.name, quantity: '1', unit_price: '70.00', item_type: 'product', catalog_product_id: c1.id }, { product_name: 'Accesorio QA', quantity: '1', unit_price: '10.00', item_type: 'accessory' }] })
O.O8 = await mkOrder(world, 'A', { label: 'O8', total: 100 })
O.O9 = await mkOrder(world, 'A', { label: 'O9', total: 100 })
await payAndConfirm(world, O.O9, 40)
O.O10 = await mkOrder(world, 'A', { label: 'O10', total: 100 })
await registerPayment(world, O.O10, 30)
O.O11 = await mkOrder(world, 'A', { label: 'O11', total: 100 })
await payAndConfirm(world, O.O11, 100, 'full')
O.O12 = await mkOrder(world, 'A', { label: 'O12', total: 100 })
const rejected = await registerPayment(world, O.O12, 25)
await rejectPayment(world, O.O12, rejected.payment_id)
const voided = await registerPayment(world, O.O12, 35)
await confirmPayment(world, O.O12, voided.payment_id)
await voidPayment(world, O.O12, voided.payment_id)
O.O13 = await mkOrder(world, 'A', { label: 'O13', total: 100 })
await cancelOrder(world, O.O13)
O.O14 = await mkOrder(world, 'A', { label: 'O14', total: 100 })
await finalize(world, O.O14, 100)
const multi = await mkConversation(world, 'A', 'MULTI')
O.O15a = await mkOrder(world, 'A', { label: 'O15a', total: 40, conversation: multi })
O.O15b = await mkOrder(world, 'A', { label: 'O15b', total: 55, conversation: multi })
O.OB1 = await mkOrder(world, 'B', { label: 'OB1', items: [{ product_name: 'Producto B', quantity: 1, unit_price: 45 }] })
O.OB2 = await mkOrder(world, 'B', { label: 'OB2', total: 65 })
// filler so that "Pedidos confirmados" needs a second page
for (let i = 1; i <= 15; i += 1) O[`F${i}`] = await mkOrder(world, 'A', { label: `F${i}`, total: 10 + i })

// ---- chats in each stage ----
const com = await mkConversation(world, 'A', 'CV-COM')
const empty = await mkConversation(world, 'A', 'CV-LOG0')
await toLogisticsStage(world, 'A', empty.conversationId)
const shared = await mkOrder(world, 'A', { label: 'CV-SH', total: 20 })
const asLog = await signedIn(world, 'A-LOG')
await must(asLog.rpc('derive_conversation_to_commercial', { p_conversation_id: shared.conversationId }), 'derive')
world.conversations = { 'CV-COM': com.conversationId, 'CV-LOG': O.O1.conversationId, 'CV-LOG0': empty.conversationId, 'CV-SH': shared.conversationId, 'CV-MULTI': multi.conversationId, CVB: O.OB1.conversationId }
O.CVSH = shared

// ---- fault injection: QA database only, never a migration ----
execFileSync('psql', [process.env.QA_DB_URL, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', new URL('./faults.sql', import.meta.url).pathname], { stdio: 'inherit' })

// ---- the seed proves itself ----
const accounts = await must(admin.from('accounts').select('id'), 'accounts')
const whatsapp = await must(admin.from('whatsapp_config').select('id'), 'whatsapp_config')
const stages = {}
for (const [k, id] of Object.entries(world.conversations)) stages[k] = (await routingState(id)).stage
const expectStages = { 'CV-COM': 'commercial', 'CV-LOG': 'logistics', 'CV-LOG0': 'logistics', 'CV-SH': 'shared', 'CV-MULTI': 'logistics', CVB: 'logistics' }
const summary = {
  accounts: accounts.length, users: Object.keys(world.users).length, orders: Object.keys(O).length, whatsappConfigRows: whatsapp.length, stages,
  ok: accounts.length === 2 && whatsapp.length === 0 && JSON.stringify(stages) === JSON.stringify(expectStages),
}
saveWorld(world)
writeFileSync(`${process.env.QA_RESULTS}/seed.json`, JSON.stringify({
  summary, accounts: world.accounts,
  users: Object.fromEntries(Object.entries(world.users).map(([k, u]) => [k, { id: u.id, name: u.name }])),
  orders: Object.fromEntries(Object.entries(O).map(([k, o]) => [k, { orderId: o.orderId, conversationId: o.conversationId }])),
  conversations: world.conversations,
}, null, 2))
console.log(JSON.stringify(summary))
if (!summary.ok) process.exit(1)
