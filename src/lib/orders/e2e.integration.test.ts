// End-to-end QA of "Confirmar pedido" against an ISOLATED stack (see scripts/qa/orders-e2e/README.md): a WACRM database + PostgREST, an
// InkaClick-replica database + PostgREST, and the real Supabase edge runtime serving the real `wacrm-confirmed-orders` function. SYNTHETIC data only.
// Skipped unless QA_E2E=1, so the normal suite never needs Docker. It drives the real route handlers and the real outbox code.
import { execFileSync } from 'node:child_process'
import { beforeAll, describe, expect, it, vi } from 'vitest'

const E2E = process.env.QA_E2E === '1'
const CRON_SECRET = 'qa-cron-secret'

const sql = (db: 'wacrm' | 'inka', query: string): string =>
  execFileSync('docker', ['exec', '-i', 'qa-pg', 'psql', '-U', 'supabase_admin', '-d', db, '-At', '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding: 'utf8' }).trim()
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim()

let ACCOUNT = ''
let USER = ''
let CONTACT = ''
let CONVERSATION = ''
let SELLER = ''   // the commercial seller: a different member of the same account

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({
    supabase: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { full_name: 'Asesor QA' } }) }) }) }) }) },
    accountId: ACCOUNT,
    userId: USER,
  }),
  toErrorResponse: (e: Error) => new Response(JSON.stringify({ error: e.message }), { status: 500 }),
}))

const order = (key: string, over: Record<string, unknown> = {}) => ({
  request_key: key, seller_user_id: SELLER, contact_id: CONTACT, conversation_id: CONVERSATION, customer_name: 'Cliente Sintetico', phone: '900000011',
  product: 'Nivel laser', quantity: 2, price: '150,5', destination: 'Arequipa', department: 'arequipa', order_description: 'color rojo https://example.invalid/f.jpg',
  dni: '12345678', ...over,
})

async function confirm(body: unknown) {
  const { POST } = await import('@/app/api/orders/confirm/route')
  const res = await POST(new Request('http://x/api/orders/confirm', { method: 'POST', body: JSON.stringify(body) }))
  return { status: res.status, body: await res.json() }
}
async function cron(secret = CRON_SECRET) {
  const { GET } = await import('@/app/api/orders/cron/route')
  const res = await GET(new Request('http://x/api/orders/cron', { headers: { 'x-cron-secret': secret } }))
  return { status: res.status, body: await res.json() }
}
const inkaRows = (ext?: string) => Number(sql('inka', `select count(*) from confirmed_orders where source='wacrm'${ext ? ` and external_order_id='${ext}'` : ''}`))
const status = (id: string) => sql('wacrm', `select delivery_status||'|'||attempts||'|'||coalesce(last_error_code,'') from order_confirmations where id='${id}'`)

async function waitForReceiver() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(process.env.INKACLICK_ORDERS_URL!, { method: 'GET' })
      if (r.status === 401) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('receiver did not come back')
}

describe.skipIf(!E2E)('Confirmar pedido: WACRM -> outbox -> InkaClick (isolated E2E)', () => {
  let first = ''

  beforeAll(() => {
    // Safety: this suite truncates tables. It only ever runs against the throwaway QA stack on loopback.
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '')) throw new Error('QA_E2E must point at the isolated loopback stack')
    sql('wacrm', 'truncate order_confirmation_deliveries, order_confirmations')
    sql('inka', 'truncate wacrm_order_events, confirmed_orders, customers cascade')
    process.env.AUTOMATION_CRON_SECRET = CRON_SECRET
    process.env.INKACLICK_ORDERS_ENABLED = 'true'
    // One statement per step: the signup trigger creates the account/profile, which a single CTE statement would not see.
    USER = sql('wacrm', `insert into auth.users (id, email) values (gen_random_uuid(), 'qa-' || substr(gen_random_uuid()::text,1,8) || '@example.invalid') returning id`).split('\n')[0]
    ACCOUNT = sql('wacrm', `select account_id from profiles where user_id='${USER}'`)
    CONTACT = sql('wacrm', `insert into contacts (user_id, account_id, phone, name) values ('${USER}', '${ACCOUNT}', '51900000011', 'Cliente Sintetico') returning id`).split('\n')[0]
    CONVERSATION = sql('wacrm', `insert into conversations (user_id, account_id, contact_id) values ('${USER}', '${ACCOUNT}', '${CONTACT}') returning id`).split('\n')[0]
    sql('wacrm', `update profiles set full_name='Titular QA' where user_id='${USER}'`)
    // The seller is just another member: sign up, then join the account (what redeem_invitation does). No catalogue, no seeding of sellers.
    SELLER = sql('wacrm', `insert into auth.users (id, email) values (gen_random_uuid(), 'qa-seller-' || substr(gen_random_uuid()::text,1,8) || '@example.invalid') returning id`).split('\n')[0]
    sql('wacrm', `update profiles set account_id='${ACCOUNT}', account_role='agent', full_name='Vendedor QA' where user_id='${SELLER}'`)
    // Feature ON and delivery ON for this account (two independent switches).
    sql('wacrm', `insert into order_integration_settings (account_id, enabled, confirm_enabled) values ('${ACCOUNT}', true, true)`)
  })

  it('1. creates an order from the form endpoint and stores it in the outbox (pending, nothing sent yet)', async () => {
    const r = await confirm(order('qa-order-1'))
    expect(r.status).toBe(201)
    first = r.body.order_id
    expect(r.body.delivery_status).toBe('pending')
    expect(status(first)).toBe('pending|0|')
    expect(inkaRows()).toBe(0)
    // Seller (commercial) and the person who pressed the button are different things.
    expect(sql('wacrm', `select confirmed_by_name||'|'||seller_name||'|'||price||'|'||department||'|'||agency from order_confirmations where id='${first}'`)).toBe('Asesor QA|Vendedor QA|150.50|Arequipa|Shalom')
    expect(sql('wacrm', `select (confirmed_by='${USER}')||'|'||(seller_user_id='${SELLER}')||'|'||(seller_id is null) from order_confirmations where id='${first}'`)).toBe('true|true|true')
  })

  it('2. a double submit with the same request_key is the same order', async () => {
    const [a, b] = await Promise.all([confirm(order('qa-order-1')), confirm(order('qa-order-1'))])
    expect([a.body.order_id, b.body.order_id]).toEqual([first, first])
    expect(Number(sql('wacrm', `select count(*) from order_confirmations where request_key='qa-order-1'`))).toBe(1)
  })

  it('3. the cron refuses a wrong secret and delivers exactly one row to InkaClick with the right data', async () => {
    expect((await cron('wrong')).status).toBe(401)
    const r = await cron()
    expect(r.body).toMatchObject({ enabled: true, claimed: 1, sent: 1, rejected: 0, dead: 0 })
    expect(status(first)).toBe('sent|1|')
    expect(inkaRows(first)).toBe(1)
    expect(sql('inka', `select source||'|'||estado_pedido||'|'||agencia||'|'||vendedor||'|'||precio||'|'||cantidad_productos||'|'||telefono||'|'||coalesce(departamento,'')||'|'||pago_restante||'|'||duplicate_key from confirmed_orders where external_order_id='${first}'`))
      .toBe(`wacrm|Pedido confirmado|Shalom|Vendedor QA|150.50|2|51900000011|Arequipa|150.50|wacrm_${first}`)
    expect(sql('inka', `select count(*) from customers where telefono_normalized='51900000011'`)).toBe('1')
  })

  it('4. reconciliation turns sent into acknowledged only when InkaClick holds the order', async () => {
    const { runOrderOutbox, readInkaclickConfig } = await import('@/lib/orders/outbox')
    const { supabaseAdmin } = await import('@/lib/flows/admin-client')
    const before = await runOrderOutbox(supabaseAdmin(), readInkaclickConfig(), { now: () => Date.now() })
    expect(before.reconciled).toBe(0) // too fresh: sent less than a minute ago
    const later = await runOrderOutbox(supabaseAdmin(), readInkaclickConfig(), { now: () => Date.now() + 120_000 })
    expect(later.reconciled).toBe(1)
    expect(status(first)).toBe('acknowledged|1|')
    expect(sql('wacrm', `select inkaclick_order_id from order_confirmations where id='${first}'`)).toBe(sql('inka', `select id from confirmed_orders where external_order_id='${first}'`))
  })

  it('5. re-sending the same order (lost response) is idempotent: same InkaClick row, still exactly one', async () => {
    const inkaId = sql('inka', `select id from confirmed_orders where external_order_id='${first}'`)
    sql('wacrm', `update order_confirmations set delivery_status='pending', next_attempt_at=now() where id='${first}'`)
    const r = await cron()
    expect(r.body).toMatchObject({ claimed: 1, sent: 1 })
    expect(inkaRows(first)).toBe(1)
    expect(sql('inka', `select id from confirmed_orders where external_order_id='${first}'`)).toBe(inkaId)
    expect(sql('inka', `select string_agg(outcome, ',' order by received_at) from wacrm_order_events where external_order_id='${first}'`)).toBe('created,replayed')
  })

  it('6. receiver down: the order is kept, retried later with backoff, and delivered once it is back', async () => {
    const r = await confirm(order('qa-order-2', { product: 'Tripode' }))
    expect(r.status).toBe(201)
    const second = r.body.order_id
    docker('stop', 'qa-edge-off')
    try {
      const down = await cron()
      expect(down.body).toMatchObject({ claimed: 1, sent: 0, retried: 1 })
      expect(status(second)).toBe('pending|1|network_error')
      expect(Number(sql('wacrm', `select extract(epoch from next_attempt_at - now())::int from order_confirmations where id='${second}'`))).toBeGreaterThan(10)
      expect(inkaRows(second)).toBe(0)
      expect(sql('wacrm', `select outcome from order_confirmation_deliveries where order_id='${second}' and attempt=1`)).toBe('retry')
      // Not due yet: another tick leaves it alone.
      expect((await cron()).body.claimed).toBe(0)
    } finally {
      docker('start', 'qa-edge-off')
    }
    await waitForReceiver()
    sql('wacrm', `update order_confirmations set next_attempt_at=now() where id='${second}'`)
    expect((await cron()).body).toMatchObject({ claimed: 1, sent: 1 })
    expect(status(second)).toBe('sent|2|')
    expect(inkaRows(second)).toBe(1)
  })

  it('7. a second order of the same contact is a second, independent order in both systems', async () => {
    expect(Number(sql('wacrm', `select count(*) from order_confirmations where contact_id='${CONTACT}'`))).toBe(2)
    expect(inkaRows()).toBe(2)
    expect(sql('inka', `select total_pedidos from customers where telefono_normalized='51900000011'`)).toBe('2')
  })

  it('8. a receiver rejection (4xx) is not retried: failed, visible, with only a safe code stored', async () => {
    const r = await confirm(order('qa-order-3'))
    const { runOrderOutbox } = await import('@/lib/orders/outbox')
    const { supabaseAdmin } = await import('@/lib/flows/admin-client')
    const out = await runOrderOutbox(supabaseAdmin(), { url: process.env.INKACLICK_ORDERS_URL!, token: 'wrong-token' })
    expect(out).toMatchObject({ claimed: 1, rejected: 1, sent: 0 })
    expect(status(r.body.order_id)).toBe('failed|1|unauthorized')
    expect(sql('wacrm', `select coalesce(error_detail,'') from order_confirmation_deliveries where order_id='${r.body.order_id}'`)).not.toMatch(/Cliente|900000011|12345678/)
    expect((await cron()).body.claimed).toBe(0)
    expect(inkaRows(r.body.order_id)).toBe(0)
  })

  it('9. with the account switch off the order is held and never sent', async () => {
    sql('wacrm', `update order_integration_settings set enabled=false where account_id='${ACCOUNT}'`)
    const r = await confirm(order('qa-order-4'))
    expect(r.body.delivery_status).toBe('held')
    expect((await cron()).body.claimed).toBe(0)
    sql('wacrm', `update order_integration_settings set enabled=true where account_id='${ACCOUNT}'`)
    expect((await cron()).body.claimed).toBe(0) // switching on does not release held orders
    expect(status(r.body.order_id)).toBe('held|0|')
    expect(inkaRows(r.body.order_id)).toBe(0)
  })

  it('10. with the global switch off the cron does nothing at all', async () => {
    const r = await confirm(order('qa-order-5'))
    process.env.INKACLICK_ORDERS_ENABLED = 'false'
    try {
      expect((await cron()).body).toMatchObject({ enabled: false, claimed: 0 })
      expect(status(r.body.order_id)).toBe('pending|0|')
    } finally {
      process.env.INKACLICK_ORDERS_ENABLED = 'true'
    }
  })

  it('12. the selector lists the real members of the account (owner included), from the profiles, and only when the feature is on', async () => {
    const { GET } = await import('@/app/api/orders/sellers/route')
    const body = await (await GET()).json()
    expect(body.enabled).toBe(true)
    expect(body.sellers.map((s: { name: string }) => s.name).sort()).toEqual(['Titular QA', 'Vendedor QA'])
    expect(body.sellers.find((s: { name: string }) => s.name === 'Vendedor QA').id).toBe(SELLER)
    // A rename reaches the selector immediately and leaves the orders already confirmed alone.
    sql('wacrm', `update profiles set full_name='Vendedor QA Renombrado' where user_id='${SELLER}'`)
    expect((await (await GET()).json()).sellers.map((s: { name: string }) => s.name)).toContain('Vendedor QA Renombrado')
    expect(sql('wacrm', `select count(*) from order_confirmations where seller_name='Vendedor QA'`)).not.toBe('0')
    expect(sql('wacrm', `select count(*) from order_confirmations where seller_name='Vendedor QA Renombrado'`)).toBe('0')
    sql('wacrm', `update profiles set full_name='Vendedor QA' where user_id='${SELLER}'`)
  })

  it('13. with the feature switched off the account gets no roster and cannot confirm, even with delivery on; delivery-off + feature-on still holds', async () => {
    sql('wacrm', `update order_integration_settings set confirm_enabled=false where account_id='${ACCOUNT}'`)
    try {
      const { GET } = await import('@/app/api/orders/sellers/route')
      expect(await (await GET()).json()).toEqual({ enabled: false, sellers: [] })
      const before = sql('wacrm', `select count(*) from order_confirmations`)
      const r = await confirm(order('qa-order-off'))
      expect(r.status).toBe(403)
      expect(r.body).toEqual({ error: 'feature_disabled' })
      expect(sql('wacrm', `select count(*) from order_confirmations`)).toBe(before)
    } finally {
      sql('wacrm', `update order_integration_settings set confirm_enabled=true where account_id='${ACCOUNT}'`)
    }
    sql('wacrm', `update order_integration_settings set enabled=false where account_id='${ACCOUNT}'`)
    try {
      const r = await confirm(order('qa-order-pilot'))
      expect(r.status).toBe(201)
      expect(r.body.delivery_status).toBe('held')
    } finally {
      sql('wacrm', `update order_integration_settings set enabled=true where account_id='${ACCOUNT}'`)
    }
  })

  it('11. ManyChat-style rows are untouched: the pre-existing writer path still works next to WACRM rows', async () => {
    sql('inka', `insert into confirmed_orders (manychat_contact_id, nombre_completo, telefono, producto, precio, source, duplicate_key) values ('mc-qa','Manychat Sintetico','51900000099','X',10,'manychat','mc_qa_2026-10-31T10:00:00-05:00')`)
    expect(sql('inka', `select count(*) from confirmed_orders where source='manychat' and external_order_id is null`)).toBe('1')
    expect(inkaRows()).toBe(2)
  })
})
