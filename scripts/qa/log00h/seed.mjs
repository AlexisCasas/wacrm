// Builds the synthetic world on an empty database: two accounts, four roles in each, catalogue, orders, payments and chats.
// Writes the identifiers (no credentials) to the results and the full world, with passwords, to a private file that is never published.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import { sql, sqlRows } from './lib/db.mjs'
import { seedChecks } from './lib/seed-checks.mjs'
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
    const [signupAccount] = sqlRows(`signup profile ${key}`, `select account_id from public.profiles where user_id = :'user';`, { user: id }, 1)
    if (area === 'OWN') {
      world.accounts[acc] = signupAccount
      sqlRows(`owner ${key}`, `
        update public.accounts set name = :'account_name' where id = :'account';
        update public.profiles set full_name = :'name' where user_id = :'user' returning user_id;
      `, { account: signupAccount, account_name: `QA Cuenta ${acc}`, name, user: id }, 1)
    } else {
      // Two statements on purpose: moving a profile to another account clears its operational area (database trigger).
      sqlRows(`membership ${key}`, `
        update public.profiles set full_name = :'name', account_id = :'account', account_role = :'account_role' where user_id = :'user';
        update public.profiles set operational_role = :'operational_role' where user_id = :'user' returning user_id;
      `, { name, account: world.accounts[acc], account_role: accountRole, operational_role: operationalRole, user: id }, 1)
      sqlRows(`leftover account ${key}`, `
        delete from public.accounts a where a.id = :'leftover' and not exists (select 1 from public.profiles p where p.account_id = a.id) returning a.id;
      `, { leftover: signupAccount }, 1)
    }
    world.users[key] = { id, email, password, name }
  }
}

// ---- settings. InkaClick delivery OFF, no WhatsApp configuration at all, customer messages OFF ----
for (const acc of ['A', 'B']) {
  sqlRows(`integration settings ${acc}`, `
    insert into public.order_integration_settings (account_id, enabled, confirm_enabled, multiproduct_enabled, product_tags_required, logistics_mvp_enabled)
      values (:'account', false, true, true, false, true)
      on conflict (account_id) do update set enabled = false, confirm_enabled = true, multiproduct_enabled = true, product_tags_required = false, logistics_mvp_enabled = true
      returning account_id;
  `, { account: world.accounts[acc] }, 1)
}
// O3 is confirmed BEFORE payments are switched on: it stays untracked (historical)
world.orders.O3 = await mkOrder(world, 'A', { label: 'O3', total: 80 })
for (const acc of ['A', 'B']) {
  sqlRows(`payment and shipment settings ${acc}`, `
    insert into public.order_payment_settings (account_id, order_payments_enabled) values (:'account', true)
      on conflict (account_id) do update set order_payments_enabled = true;
    insert into public.order_shipment_settings (account_id, shalom_tracking_enabled, destination_customer_message_enabled) values (:'account', true, false)
      on conflict (account_id) do update set shalom_tracking_enabled = true, destination_customer_message_enabled = false
      returning account_id;
  `, { account: world.accounts[acc] }, 1)
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
// filler so that "Pedidos confirmados" needs a second page (50 orders per page)
for (let i = 1; i <= 40; i += 1) O[`F${i}`] = await mkOrder(world, 'A', { label: `F${i}`, total: 10 + i })

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
sql('fault triggers', readFileSync(new URL('./faults.sql', import.meta.url), 'utf8'))

// ---- the seed proves itself ----
const stages = {}
for (const [k, id] of Object.entries(world.conversations)) stages[k] = (await routingState(id)).stage
const summary = seedChecks(world, stages)
saveWorld(world)
writeFileSync(`${process.env.QA_RESULTS}/seed.json`, JSON.stringify({
  summary, accounts: world.accounts,
  users: Object.fromEntries(Object.entries(world.users).map(([k, u]) => [k, { id: u.id, name: u.name }])),
  orders: Object.fromEntries(Object.entries(O).map(([k, o]) => [k, { orderId: o.orderId, conversationId: o.conversationId }])),
  conversations: world.conversations,
}, null, 2))
console.log(JSON.stringify(summary, null, 2))
if (!summary.ok) process.exit(1)
