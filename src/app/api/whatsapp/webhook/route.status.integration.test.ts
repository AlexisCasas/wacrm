// Isolated end-to-end QA of WhatsApp STATUS webhooks (PR-A): tenant isolation and monotonic transitions.
// Drives the REAL route handler (valid HMAC signature) against the throwaway QA Postgres (see scripts/qa/orders-e2e/README.md for the stack).
// Skipped unless QA_E2E=1; refuses to run unless NEXT_PUBLIC_SUPABASE_URL is a loopback address. SYNTHETIC data only: no real send, no Meta call.
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const E2E = process.env.QA_E2E === '1'
const SECRET = 'qa-synthetic-meta-app-secret'

const h = vi.hoisted(() => ({
  after: [] as (() => Promise<void> | void)[],
  dispatch: vi.fn(async () => undefined),
}))

vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => {
    h.after.push(cb)
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) =>
      new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: { 'content-type': 'application/json' } }),
  },
}))
// The outbound dispatcher is not under test: we assert WHICH account it is asked to notify and with WHAT.
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: h.dispatch }))

const sql = (query: string): string =>
  execFileSync('docker', ['exec', '-i', 'qa-pg', 'psql', '-U', 'supabase_admin', '-d', 'wacrm', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding: 'utf8' }).trim()
const one = (query: string) => sql(query).split('\n')[0]

interface Tenant { account: string; user: string; phone: string; waba: string; contact: string; conv: string }
let A: Tenant
let B: Tenant

function tenant(tag: string, phone: string, waba: string): Tenant {
  const user = one(`insert into auth.users (id, email) values (gen_random_uuid(), '${tag}-'||substr(gen_random_uuid()::text,1,8)||'@example.invalid') returning id`)
  const account = one(`select account_id from profiles where user_id='${user}'`)
  sql(`insert into whatsapp_config (user_id, account_id, phone_number_id, waba_id, access_token, status) values ('${user}','${account}','${phone}','${waba}','qa-not-a-token','connected')`)
  const contact = one(`insert into contacts (user_id, account_id, phone, name) values ('${user}','${account}','5190000${phone.slice(-4)}','Cliente Sintetico ${tag}') returning id`)
  const conv = one(`insert into conversations (user_id, account_id, contact_id) values ('${user}','${account}','${contact}') returning id`)
  return { account, user, phone, waba, contact, conv }
}

/** An OUTBOUND message of the tenant, as the send route stores it (status sent). */
function outbound(t: Tenant, wamid: string, status = 'sent', sender = 'agent') {
  return one(`insert into messages (conversation_id, sender_type, content_type, content_text, message_id, status) values ('${t.conv}','${sender}','text','mensaje sintetico','${wamid}','${status}') returning id`)
}
const statusOf = (t: Tenant, wamid: string) => one(`select m.status from messages m join conversations c on c.id=m.conversation_id where c.account_id='${t.account}' and m.message_id='${wamid}'`)

let seq = 0
const wamid = (tag: string) => `wamid.QA${tag}${Date.now().toString(36)}${++seq}`

function payload(t: { phone: string; waba: string }, statuses: { id: string; status: string; ts?: number }[]) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: t.waba,
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '51900000000', phone_number_id: t.phone },
          statuses: statuses.map((s) => ({ id: s.id, status: s.status, timestamp: String(s.ts ?? Math.floor(Date.now() / 1000)), recipient_id: '51900000001' })),
        },
      }],
    }],
  }
}

async function deliver(body: unknown): Promise<number> {
  const raw = JSON.stringify(body)
  const signature = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex')
  const { POST } = await import('./route')
  h.after.length = 0
  const res = await POST(new Request('http://x/api/whatsapp/webhook', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': signature, 'content-type': 'application/json' } }))
  for (const cb of h.after.splice(0)) await cb()
  return res.status
}
const status = (t: Tenant, id: string, s: string, ts?: number) => deliver(payload(t, [{ id, status: s, ts }]))
type Call = [unknown, string, string, { whatsapp_message_id: string; conversation_id: string; status: string }]
const notified = () => (h.dispatch.mock.calls as unknown as Call[]).map((c) => ({ account: c[1], event: c[2], status: c[3].status, conv: c[3].conversation_id, wamid: c[3].whatsapp_message_id }))

describe.skipIf(!E2E)('WhatsApp status webhooks: tenant isolation and monotonic transitions (isolated E2E)', () => {
  beforeAll(() => {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '')) throw new Error('QA_E2E must point at the isolated loopback stack')
    process.env.META_APP_SECRET = SECRET
    // Unique business-number ids per run: whatsapp_config.phone_number_id is UNIQUE and the suite must be re-runnable on the same stack.
    const run = String(Date.now()).slice(-9)
    A = tenant('pra-a', `1${run}0001`, `2${run}0001`)
    B = tenant('pra-b', `1${run}0002`, `2${run}0002`)
  })
  beforeEach(() => { h.dispatch.mockClear() })

  it('S1 a message_id collision across accounts: a status from account A updates ONLY A (and notifies only A)', async () => {
    const w = wamid('col')
    outbound(B, w)            // B's row first: an unscoped `.limit(1)` would pick it and notify B
    outbound(A, w)
    expect(await status(A, w, 'delivered')).toBe(200)
    expect(statusOf(A, w)).toBe('delivered')
    expect(statusOf(B, w)).toBe('sent')                       // untouched
    const n = notified()
    expect(n).toHaveLength(1)
    expect(n[0]).toMatchObject({ account: A.account, event: 'message.status_updated', status: 'delivered', conv: A.conv })
  })

  it('S2 the same collision from account B updates ONLY B', async () => {
    const w = wamid('col2')
    outbound(A, w); outbound(B, w)
    expect(await status(B, w, 'read')).toBe(200)
    expect(statusOf(B, w)).toBe('read'); expect(statusOf(A, w)).toBe('sent')
    expect(notified().map((x) => x.account)).toEqual([B.account])
  })

  it('S3 a status from a number that belongs to no account is rejected and changes nothing', async () => {
    const w = wamid('ghost'); outbound(A, w)
    expect(await deliver(payload({ phone: '999999999999999', waba: '888888888888888' }, [{ id: w, status: 'delivered' }]))).toBe(401)
    expect(statusOf(A, w)).toBe('sent'); expect(notified()).toHaveLength(0)
  })

  it('S4 out-of-order redelivery never regresses (read -> delivered -> sent) and only the effective change is notified', async () => {
    const w = wamid('ooo'); outbound(A, w)
    await status(A, w, 'read'); await status(A, w, 'delivered'); await status(A, w, 'sent')
    expect(statusOf(A, w)).toBe('read')
    expect(notified().map((x) => x.status)).toEqual(['read'])
  })

  it('S5 an identical redelivery is a no-op (one notification for three deliveries)', async () => {
    const w = wamid('rep'); outbound(A, w)
    await status(A, w, 'delivered'); await status(A, w, 'delivered'); await status(A, w, 'delivered')
    expect(statusOf(A, w)).toBe('delivered'); expect(notified()).toHaveLength(1)
  })

  it('S6 forward path sent -> delivered -> read notifies every real step in order', async () => {
    const w = wamid('fwd'); outbound(A, w, 'sending')
    await status(A, w, 'sent'); await status(A, w, 'delivered'); await status(A, w, 'read')
    expect(statusOf(A, w)).toBe('read'); expect(notified().map((x) => x.status)).toEqual(['sent', 'delivered', 'read'])
  })

  it('S7 failed: accepted from sent, never overrides delivered/read, terminal afterwards', async () => {
    const f1 = wamid('f1'); outbound(A, f1); await status(A, f1, 'failed'); expect(statusOf(A, f1)).toBe('failed')
    await status(A, f1, 'delivered'); await status(A, f1, 'read'); await status(A, f1, 'sent'); expect(statusOf(A, f1)).toBe('failed')   // late events after failed
    const f2 = wamid('f2'); outbound(A, f2); await status(A, f2, 'delivered'); await status(A, f2, 'failed'); expect(statusOf(A, f2)).toBe('delivered')
    const f3 = wamid('f3'); outbound(A, f3); await status(A, f3, 'read'); await status(A, f3, 'failed'); expect(statusOf(A, f3)).toBe('read')
  })

  it("S8 'played' (voice note) is mapped to read instead of violating the status CHECK", async () => {
    const w = wamid('ptt'); outbound(A, w, 'delivered', 'bot')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await status(A, w, 'played')
    expect(statusOf(A, w)).toBe('read')
    expect(errors.mock.calls.filter((c) => String(c[0]).includes('Error updating message status'))).toHaveLength(0)
    errors.mockRestore()
  })

  it("S9 an unknown status value is ignored without touching anything", async () => {
    const w = wamid('unk'); outbound(A, w)
    expect(await status(A, w, 'deleted')).toBe(200)
    expect(statusOf(A, w)).toBe('sent'); expect(notified()).toHaveLength(0)
  })

  it("S10 a status event never rewrites a CUSTOMER (inbound) message that happens to share the id", async () => {
    const w = wamid('inb'); outbound(A, w, 'delivered', 'customer')
    await status(A, w, 'read')
    expect(statusOf(A, w)).toBe('delivered'); expect(notified()).toHaveLength(0)
  })

  it('S11 broadcast recipients: scoped to the account, forward-only, replied is never regressed', async () => {
    const w = wamid('bc')
    const mk = (t: Tenant) => one(`insert into broadcasts (user_id, account_id, name, template_name) values ('${t.user}','${t.account}','qa','qa_template') returning id`)
    const bA = mk(A)
    const rA = one(`insert into broadcast_recipients (broadcast_id, contact_id, status, whatsapp_message_id) values ('${bA}','${A.contact}','sent','${w}') returning id`)
    const rs = () => sql(`select status||'|'||coalesce((delivered_at is not null)::text,'f')||'|'||coalesce((read_at is not null)::text,'f') from broadcast_recipients where id='${rA}'`)
    await status(B, w, 'read')                                  // another account's number names the same id
    expect(rs()).toBe('sent|false|false')
    await status(A, w, 'read'); expect(rs()).toBe('read|false|true')
    await status(A, w, 'delivered'); expect(rs()).toBe('read|false|true')   // no regression, no stray delivered_at
    sql(`update broadcast_recipients set status='replied' where id='${rA}'`)
    await status(A, w, 'read'); expect(rs().startsWith('replied|')).toBe(true)
  })
})
