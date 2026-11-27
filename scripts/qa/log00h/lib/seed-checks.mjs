// What the synthetic world must look like after seeding, read back from the database. Any difference stops the run.
import { sql } from './db.mjs'

const AREAS = 'agent:commercial,agent:logistics,agent:supervisor,owner:-,viewer:logistics'
const EXPECTED_STAGES = { 'CV-COM': 'commercial', 'CV-LOG': 'logistics', 'CV-LOG0': 'logistics', 'CV-SH': 'shared', 'CV-MULTI': 'logistics', CVB: 'logistics' }
// payments the seed leaves behind, per order: status list in alphabetical order
const EXPECTED_PAYMENTS = { O9: 'confirmed', O10: 'recorded', O11: 'confirmed', O12: 'rejected,voided', O14: 'confirmed' }

const ORPHANS = {
  profile_without_account: 'select count(*) from public.profiles p left join public.accounts a on a.id = p.account_id where a.id is null',
  account_without_owner_profile: 'select count(*) from public.accounts a where not exists (select 1 from public.profiles p where p.user_id = a.owner_user_id and p.account_id = a.id)',
  conversation_contact_mismatch: 'select count(*) from public.conversations c left join public.contacts k on k.id = c.contact_id and k.account_id = c.account_id where k.id is null',
  message_without_conversation: 'select count(*) from public.messages m left join public.conversations c on c.id = m.conversation_id where c.id is null',
  routing_account_mismatch: 'select count(*) from public.conversation_routing r left join public.conversations c on c.id = r.conversation_id and c.account_id = r.account_id where c.id is null',
  order_conversation_mismatch: 'select count(*) from public.order_confirmations o left join public.conversations c on c.id = o.conversation_id and c.account_id = o.account_id and c.contact_id = o.contact_id where c.id is null',
  line_order_mismatch: 'select count(*) from public.order_confirmation_items i left join public.order_confirmations o on o.id = i.order_id and o.account_id = i.account_id where o.id is null',
  payment_order_mismatch: 'select count(*) from public.order_payments y left join public.order_confirmations o on o.id = y.order_id and o.account_id = y.account_id where o.id is null',
  paid_total_mismatch: "select count(*) from public.order_financials f where f.paid_confirmed <> coalesce((select sum(y.amount) from public.order_payments y where y.order_id = f.order_id and y.status = 'confirmed'), 0)",
}

export function seedChecks(world, stages) {
  const checks = []
  const check = (area, id, expected, observed) => checks.push({ area, id, expected, observed, ok: JSON.stringify(expected) === JSON.stringify(observed) })
  const count = (query) => Number(sql('check', `${query};`))

  const accounts = [world.accounts.A, world.accounts.B]
  check('ACCOUNTS', 'accounts', 2, count('select count(*) from public.accounts'))
  check('ACCOUNTS', 'whatsapp_config_rows', 0, count('select count(*) from public.whatsapp_config'))

  check('USERS', 'auth_users', 10, count('select count(*) from auth.users'))
  check('USERS', 'profiles', 10, count('select count(*) from public.profiles'))
  for (const [i, account] of accounts.entries()) {
    const areas = sql('areas', `select string_agg(account_role::text || ':' || coalesce(operational_role::text, '-'), ',' order by (account_role::text || ':' || coalesce(operational_role::text, '-')) collate "C") from public.profiles where account_id = :'account';`, { account })
    check('USERS', `roles_of_account_${'AB'[i]}`, AREAS, areas)
  }

  const orders = Object.values(world.orders)
  const chats = new Set([...Object.values(world.conversations), ...orders.map((o) => o.conversationId)])
  check('CONVERSATIONS', 'conversations', chats.size, count('select count(*) from public.conversations'))
  check('CONVERSATIONS', 'contacts', chats.size, count('select count(*) from public.contacts'))
  check('CONVERSATIONS', 'messages', chats.size * 2, count('select count(*) from public.messages'))
  check('CONVERSATIONS', 'stages', EXPECTED_STAGES, stages)

  check('ORDERS', 'orders', orders.length, count('select count(*) from public.order_confirmations'))
  check('ORDERS', 'historical_order_without_financials', 0, Number(sql('historical', `select count(*) from public.order_financials where order_id = :'order';`, { order: world.orders.O3.orderId })))
  check('ORDERS', 'cancelled_orders', 1, count('select count(*) from public.order_cancellations'))
  check('ORDERS', 'finalized_orders', 1, count('select count(*) from public.order_finalizations'))

  for (const [key, expected] of Object.entries(EXPECTED_PAYMENTS)) {
    const observed = sql('payments', `select coalesce(string_agg(status, ',' order by status collate "C"), '') from public.order_payments where order_id = :'order';`, { order: world.orders[key].orderId })
    check('PAYMENTS', `payments_${key}`, expected, observed)
  }
  check('PAYMENTS', 'payments', Object.values(EXPECTED_PAYMENTS).join(',').split(',').length, count('select count(*) from public.order_payments'))

  for (const [id, query] of Object.entries(ORPHANS)) {
    const area = id.startsWith('payment') || id.startsWith('paid') ? 'PAYMENTS' : id.startsWith('order') || id.startsWith('line') ? 'ORDERS' : id.startsWith('profile') || id.startsWith('account') ? 'ACCOUNTS' : 'CONVERSATIONS'
    check(area, `integrity_${id}`, 0, count(query))
  }
  return { ok: checks.every((c) => c.ok), failed: checks.filter((c) => !c.ok).map((c) => c.id), checks }
}
