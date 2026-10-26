import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Outbound side of BSUID support: addressing in the Meta request, the recipient resolver, and every sender that used to
// require `contact.phone` (Flows text / media / voice note / buttons / list, and the inbox / AI path). Meta is a fetch
// stub: nothing leaves the process.
const h = vi.hoisted(() => ({ db: null as unknown as import('@/test/in-memory-db').InMemoryDb }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.db.client }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'plain-token', encrypt: (v: string) => v, isLegacyFormat: () => false }))
vi.mock('@/lib/media/voice-note-path', async (orig) => ({ ...(await orig<object>()), isVoiceNoteUrlForAccount: () => true }))

import { createInMemoryDb } from '@/test/in-memory-db'
import { resetBsuidScopeCache } from './bsuid-flow-auth'
import { BsuidSendBlockedError, resolveContactTarget } from './recipient'
import { sendInteractiveButtons, sendInteractiveList, sendMediaMessage, sendReactionMessage, sendTemplateMessage, sendTextMessage } from './meta-api'
import { engineSendInteractiveButtons, engineSendInteractiveList, engineSendMedia, engineSendText } from '@/lib/flows/meta-send'
import { sendMessageToConversation } from './send-message'

const ACC = 'aaaaaaaa-0000-4000-8000-00000000000a'
const OTHER_ACC = 'bbbbbbbb-0000-4000-8000-00000000000b'
const BSUID = 'PE.QA0000000000001'
const PN = '1000000000000001'
const WABA = '3000000000000001'
const PILOT = 'WHATSAPP_BSUID_PILOT'
const PHONE = '51900000001'

type Body = Record<string, unknown>
let calls: Body[]
let metaMode: 'ok' | 'not_allowed'

function stubMeta() {
  calls = []
  metaMode = 'ok'
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)))
    if (metaMode === 'not_allowed') {
      return { ok: false, status: 400, headers: { get: () => null }, json: async () => ({ error: { message: '(#131030) Recipient phone number not in allowed list', code: 131030 } }) } as unknown as Response
    }
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.OUT${calls.length}` }] }) } as unknown as Response
  }))
}

function world(opts: { phone?: string; bsuid?: string; blocked?: boolean; authorized?: number; pilot?: boolean } = {}) {
  h.db = createInMemoryDb({
    whatsapp_config: [{ id: 'cfg', account_id: ACC, user_id: 'owner', phone_number_id: PN, waba_id: WABA, access_token: 'enc', status: 'connected' }],
  })
  if (opts.pilot !== false) process.env[PILOT] = `${ACC}:${PN}:${WABA}`; else delete process.env[PILOT]
  const contact = { id: 'contact-1', account_id: ACC, user_id: 'owner', phone: opts.phone ?? '', phone_optional: !opts.phone, name: 'Ana', blocked: Boolean(opts.blocked) }
  h.db.tables.contacts.push(contact)
  if (opts.bsuid) h.db.tables.contact_identities.push({ id: 'i1', account_id: ACC, contact_id: 'contact-1', kind: 'bsuid', value: opts.bsuid, superseded_at: null, send_authorized_remaining: opts.authorized ?? 0 })
  h.db.tables.conversations.push({ id: 'conv-1', account_id: ACC, user_id: 'owner', contact_id: 'contact-1', status: 'open' })
  seedAgent()
  return contact
}
const base = { accountId: ACC, userId: 'owner', conversationId: 'conv-1', contactId: 'contact-1' }
const remaining = () => h.db.tables.contact_identities[0]?.send_authorized_remaining
const audit = (event: string) => h.db.tables.contact_identity_audit.filter((a) => a.event === event)
const AGENT = 'agent-user-1'
const manual = { origin: 'manual_reply' as const, actor: { userId: AGENT } }
// A signed-in user's client as PostgREST gives it: migration 077 REVOKEs these functions from anon/authenticated and GRANTs them to service_role only,
// so through this client they fail exactly like production did (HTTP 403, 42501). The earlier tests used one client for both roles and could not see it.
const SERVICE_ROLE_ONLY = new Set(['consume_bsuid_send', 'authorize_bsuid_send', 'revoke_bsuid_send', 'audit_bsuid_event', 'resolve_bsuid_contact', 'link_contact_bsuid'])
let deniedForUser: string[]
function userSession() {
  const real = h.db.client as unknown as { from: (t: string) => unknown; rpc: (n: string, a: Record<string, unknown>) => Promise<unknown>; storage: unknown }
  return { ...real, from: real.from, storage: real.storage, rpc: async (name: string, args: Record<string, unknown>) => {
    if (SERVICE_ROLE_ONLY.has(name)) { deniedForUser.push(name); return { data: null, error: { code: '42501', message: `permission denied for function ${name}` } } }
    return real.rpc(name, args)
  } }
}
function seedAgent(role = 'agent', account = ACC, userId = AGENT) { h.db.tables.profiles = [...(h.db.tables.profiles ?? []), { id: `p-${userId}`, user_id: userId, account_id: account, account_role: role }] }

beforeEach(() => { deniedForUser = []; vi.restoreAllMocks(); vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {}); stubMeta() })
afterEach(() => { vi.unstubAllGlobals(); delete process.env[PILOT]; delete process.env.FLOW_MEDIA_AUDIO_SCOPE })

describe('Meta request addressing', () => {
  const common = { phoneNumberId: 'pn-1', accessToken: 't' }
  const senders: Array<[string, (to: string | { bsuid: string }) => Promise<unknown>]> = [
    ['text', (to) => sendTextMessage({ ...common, to, text: 'hola' })],
    ['image', (to) => sendMediaMessage({ ...common, to, kind: 'image', link: 'https://cdn.test/a.png' })],
    ['voice note', (to) => sendMediaMessage({ ...common, to, kind: 'audio', link: 'https://cdn.test/a.ogg', voice: true })],
    ['template', (to) => sendTemplateMessage({ ...common, to, templateName: 'hello', language: 'es', params: [] })],
    ['reaction', (to) => sendReactionMessage({ ...common, to, targetMessageId: 'wamid.X', emoji: '👍' })],
    ['buttons', (to) => sendInteractiveButtons({ ...common, to, bodyText: 'elige', buttons: [{ id: 'a', title: 'A' }] })],
    ['list', (to) => sendInteractiveList({ ...common, to, bodyText: 'elige', buttonLabel: 'ver', sections: [{ title: 'S', rows: [{ id: 'r1', title: 'R' }] }] })],
  ]
  it.each(senders)('%s to a BSUID uses `recipient` and never `to`', async (_n, send) => {
    await send({ bsuid: BSUID })
    expect(calls[0]).toMatchObject({ messaging_product: 'whatsapp', recipient: BSUID })
    expect('to' in calls[0]).toBe(false)
  })
  it.each(senders)('%s to a phone keeps `to` and never `recipient`', async (_n, send) => {
    await send(PHONE)
    expect(calls[0]).toMatchObject({ to: PHONE })
    expect('recipient' in calls[0]).toBe(false)
  })
})


describe('resolveContactTarget', () => {
  const resolve = (origin: 'manual_reply' | 'automated', account = ACC, phone = '') => resolveContactTarget(userSession() as never, account, { id: 'contact-1', phone }, origin === 'manual_reply' ? manual : { origin })

  it('a valid phone wins, needs no pilot, costs no extra query and ignores the origin', async () => {
    world({ phone: PHONE, bsuid: BSUID, pilot: false })
    h.db.failReads.add('contact_identities')
    expect(await resolve('automated', ACC, '+51 900 000 001')).toEqual({ kind: 'phone', phone: PHONE })
  })
  it('no phone + switch on + authorized manual reply → the ACTIVE BSUID, and one authorization is consumed', async () => {
    world({ bsuid: BSUID, authorized: 1 })
    expect(await resolve('manual_reply')).toEqual({ kind: 'bsuid', bsuid: BSUID })
    expect(remaining()).toBe(0)
    expect(audit('send_consumed')).toHaveLength(1)
  })
  it('switch OFF: a BSUID is never addressed, even with an authorization on the row (previous behaviour)', async () => {
    world({ bsuid: BSUID, authorized: 1, pilot: false })
    await expect(resolve('manual_reply')).rejects.toMatchObject({ code: 'bsuid_disabled' })
    expect(remaining()).toBe(1)
  })
  it('automatic origins are refused even when the contact is authorized, and the authorization is NOT spent', async () => {
    world({ bsuid: BSUID, authorized: 1 })
    await expect(resolve('automated')).rejects.toMatchObject({ code: 'bsuid_automated_blocked' })
    expect(remaining()).toBe(1)
    expect(audit('send_blocked')).toHaveLength(1)
  })
  it('an unauthorized contact is refused and the refusal is audited', async () => {
    world({ bsuid: BSUID, authorized: 0 })
    await expect(resolve('manual_reply')).rejects.toBeInstanceOf(BsuidSendBlockedError)
    await expect(resolve('manual_reply')).rejects.toMatchObject({ code: 'bsuid_not_authorized' })
    expect(audit('send_blocked')).toHaveLength(2)
  })
  it('"a single manual reply": the second attempt is refused', async () => {
    world({ bsuid: BSUID, authorized: 1 })
    await resolve('manual_reply')
    await expect(resolve('manual_reply')).rejects.toMatchObject({ code: 'bsuid_not_authorized' })
  })
  it('concurrent attempts with one authorization: exactly one passes', async () => {
    world({ bsuid: BSUID, authorized: 1 })
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => resolve('manual_reply')))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  })
  it('a failing authorization check fails CLOSED', async () => {
    world({ bsuid: BSUID, authorized: 1 })
    h.db.failReads.add('rpc:consume_bsuid_send')
    await expect(resolve('manual_reply')).rejects.toMatchObject({ code: 'bsuid_check_failed' })
  })
  it('a missing config row or a config without WABA fails closed', async () => {
    world({ bsuid: BSUID, authorized: 1 })
    h.db.tables.whatsapp_config[0].waba_id = null
    await expect(resolve('manual_reply')).rejects.toMatchObject({ code: 'bsuid_disabled' })
    h.db.tables.whatsapp_config.length = 0
    await expect(resolve('manual_reply')).rejects.toMatchObject({ code: 'bsuid_disabled' })
  })
  it('a superseded BSUID is never used to send', async () => {
    world({ bsuid: BSUID, authorized: 1 })
    h.db.tables.contact_identities[0].superseded_at = '2026-10-25T00:00:00Z'
    await expect(resolve('manual_reply')).rejects.toThrow('contact not found for this account')
  })
  it('an identity of another account is invisible: no send, no consumption', async () => {
    world({ bsuid: BSUID, authorized: 1 })
    await expect(resolve('manual_reply', OTHER_ACC)).rejects.toThrow('contact not found for this account')
    expect(remaining()).toBe(1)
  })
  it('keeps the previous errors when there is no BSUID', async () => {
    world({ phone: PHONE })
    await expect(resolve('manual_reply', ACC, '')).rejects.toThrow('contact not found for this account')
    await expect(resolve('manual_reply', ACC, '12')).rejects.toThrow('contact phone invalid: 12')
  })
})

describe('Flows, automations, AI and audio engines: a BSUID contact is never reached automatically', () => {
  it.each([
    ['text', () => engineSendText({ ...base, text: 'Hola' })],
    ['AI reply', () => engineSendText({ ...base, text: 'Hola', aiGenerated: true })],
    ['image', () => engineSendMedia({ ...base, kind: 'image', link: 'https://cdn.test/a.png' })],
    ['voice note (audio por producto path)', () => { process.env.FLOW_MEDIA_AUDIO_SCOPE = 'all'; return engineSendMedia({ ...base, kind: 'audio', link: 'https://cdn.test/a.ogg', voice: true }) }],
    ['buttons', () => engineSendInteractiveButtons({ ...base, kind: 'buttons', bodyText: 'elige', buttons: [{ id: 'a', title: 'A' }] } as never)],
    ['list', () => engineSendInteractiveList({ ...base, kind: 'list', bodyText: 'elige', buttonLabel: 'ver', sections: [{ title: 'S', rows: [{ id: 'r1', title: 'R' }] }] } as never)],
  ])('%s is blocked before Meta, even for an AUTHORIZED contact; nothing is stored and the authorization survives', async (_n, send) => {
    world({ bsuid: BSUID, authorized: 1 })
    await expect(send()).rejects.toThrow('BSUID send blocked: bsuid_automated_blocked')
    expect(calls).toHaveLength(0)
    expect(h.db.tables.messages).toHaveLength(0)
    expect(h.db.tables.contacts[0].phone).toBe('')
    expect(remaining()).toBe(1)
  })
  it('a blocked contact receives nothing (block status is checked first)', async () => {
    world({ bsuid: BSUID, authorized: 1, blocked: true })
    await expect(engineSendText({ ...base, text: 'x' })).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
  it('a contact with neither phone nor BSUID fails before calling Meta, as before', async () => {
    world({})
    await expect(engineSendText({ ...base, text: 'x' })).rejects.toThrow('contact not found for this account')
    expect(calls).toHaveLength(0)
  })
  it('REGRESSION: phone contacts are addressed with `to`, with or without the switch, and a rejected number is still healed by variants', async () => {
    for (const pilot of [true, false]) {
      world({ phone: PHONE, pilot })
      calls.length = 0
      await engineSendText({ ...base, text: 'hola' })
      expect(calls[0]).toMatchObject({ to: PHONE })
      expect('recipient' in calls[0]).toBe(false)
    }
    calls.length = 0
    metaMode = 'not_allowed'
    await expect(engineSendText({ ...base, text: 'otra' })).rejects.toThrow()
    expect(calls.length).toBeGreaterThan(1)
  })
})

describe('inbox (the only path that may reach a BSUID during the pilot)', () => {
  const send = (extra: Record<string, unknown> = {}, text = 'Respuesta') =>
    sendMessageToConversation(userSession() as never, ACC, { conversationId: 'conv-1', messageType: 'text', contentText: text, ...extra } as never)

  it('an authorized manual reply goes to the BSUID with `recipient`, is stored in the same conversation, and uses up the authorization', async () => {
    world({ bsuid: BSUID, authorized: 1 })
    const out = await send(manual)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ recipient: BSUID, type: 'text' })
    expect('to' in calls[0]).toBe(false)
    expect(JSON.stringify(out)).toContain('wamid.OUT1')
    expect(h.db.tables.messages.some((m) => m.conversation_id === 'conv-1' && m.content_text === 'Respuesta')).toBe(true)
    expect(h.db.tables.contacts[0].phone).toBe('')
    expect(remaining()).toBe(0)
    expect(audit('send_consumed')).toHaveLength(1)
  })
  it('the second manual reply is refused until the operator authorizes again', async () => {
    world({ bsuid: BSUID, authorized: 1 })
    await send(manual)
    await expect(send(manual, 'otra')).rejects.toMatchObject({ code: 'bsuid_send_blocked', status: 403 })
    expect(calls).toHaveLength(1)
  })
  it('image, voice note and text all use `recipient` when the operator grants three replies', async () => {
    world({ bsuid: BSUID, authorized: 3 })
    await send(manual)
    await sendMessageToConversation(userSession() as never, ACC, { conversationId: 'conv-1', messageType: 'image', mediaUrl: 'https://cdn.test/a.png', ...manual } as never)
    await sendMessageToConversation(userSession() as never, ACC, { conversationId: 'conv-1', messageType: 'audio', mediaUrl: 'https://cdn.test/a.ogg', voiceNote: true, ...manual } as never)
    expect(calls.map((c) => c.type)).toEqual(['text', 'image', 'audio'])
    expect(calls.every((c) => c.recipient === BSUID && !('to' in c))).toBe(true)
  })
  it('the public API / any caller that does not say "manual_reply" is refused (default origin is automated)', async () => {
    world({ bsuid: BSUID, authorized: 1 })
    await expect(send()).rejects.toMatchObject({ code: 'bsuid_send_blocked', status: 403 })
    expect(calls).toHaveLength(0)
    expect(remaining()).toBe(1)
  })
  it('an unauthorized contact is refused with 403 and audited', async () => {
    world({ bsuid: BSUID, authorized: 0 })
    await expect(send(manual)).rejects.toMatchObject({ status: 403 })
    expect(calls).toHaveLength(0)
    expect(audit('send_blocked')).toHaveLength(1)
  })
  it('switch OFF: a leftover BSUID contact cannot be written to at all', async () => {
    world({ bsuid: BSUID, authorized: 1, pilot: false })
    await expect(send(manual)).rejects.toMatchObject({ status: 403 })
    expect(calls).toHaveLength(0)
  })
  it('a Meta rejection keeps the trace (502), changes no contact and does NOT give the authorization back', async () => {
    world({ bsuid: BSUID, authorized: 1 })
    metaMode = 'not_allowed'
    await expect(send(manual)).rejects.toMatchObject({ status: 502 })
    expect(calls).toHaveLength(1)
    expect(h.db.tables.contacts[0].phone).toBe('')
    expect(h.db.tables.messages).toHaveLength(0)
    expect(remaining()).toBe(0)
  })
  it('a retry after an explicit new authorization sends exactly one stored message', async () => {
    world({ bsuid: BSUID, authorized: 1 })
    metaMode = 'not_allowed'
    await expect(send(manual)).rejects.toThrow()
    h.db.tables.contact_identities[0].send_authorized_remaining = 1
    metaMode = 'ok'
    await send(manual)
    expect(h.db.tables.messages).toHaveLength(1)
  })
  it('REGRESSION: a phone contact is unchanged for every origin', async () => {
    world({ phone: PHONE })
    await send(manual); await send()
    expect(calls.every((c) => c.to === PHONE && !('recipient' in c))).toBe(true)
  })
  it('no phone and no BSUID is a 400, not a Meta call', async () => {
    world({})
    await expect(send(manual)).rejects.toMatchObject({ status: 400 })
    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// P0 hotfix: a manual reply from the Inbox runs under the AGENT's session (RLS client), which cannot execute the service-role-only
// functions. The credit must be spent, and the block audited, by the server's privileged client — after the caller is verified again.
// ---------------------------------------------------------------------------------------------------------------------
describe('manual reply from the Inbox under an authenticated agent session (hotfix bsuid_check_failed)', () => {
  const send = (extra: Record<string, unknown> = {}, client: unknown = userSession()) =>
    sendMessageToConversation(client as never, ACC, { conversationId: 'conv-1', messageType: 'text', contentText: 'Hola', ...extra } as never)

  it('A. an agent of Keyler with 1 credit: the credit is consumed atomically and Meta gets exactly one request with `recipient`', async () => {
    world({ bsuid: BSUID, authorized: 1 })
    const out = await send(manual)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ messaging_product: 'whatsapp', recipient_type: 'individual', recipient: BSUID, type: 'text' })
    expect(JSON.stringify(out)).toContain('wamid.OUT1')
    expect(remaining()).toBe(0)
    expect(audit('send_consumed')).toHaveLength(1)
    expect(deniedForUser).toEqual([]) // the agent's own session never tried to run a privileged function
  })
  it('B. a second attempt with 0 credits is blocked and Meta is not called', async () => {
    world({ bsuid: BSUID, authorized: 1 })
    await send(manual)
    await expect(send(manual)).rejects.toMatchObject({ code: 'bsuid_send_blocked', status: 403, message: expect.stringContaining('bsuid_not_authorized') })
    expect(calls).toHaveLength(1)
    expect(audit('send_blocked')).toHaveLength(1) // the block IS audited even though the caller was an RLS client
  })
  it('C. a viewer (below agent) is blocked: no credit spent, no Meta call', async () => {
    world({ bsuid: BSUID, authorized: 1 })
    h.db.tables.profiles = [{ id: 'pv', user_id: AGENT, account_id: ACC, account_role: 'viewer' }]
    await expect(send(manual)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('bsuid_not_authorized') })
    expect(calls).toHaveLength(0); expect(remaining()).toBe(1)
  })
  it('C2. a user with no profile row, or an unknown role, is blocked', async () => {
    world({ bsuid: BSUID, authorized: 1 })
    h.db.tables.profiles = []
    await expect(send(manual)).rejects.toMatchObject({ status: 403 })
    h.db.tables.profiles = [{ id: 'px', user_id: AGENT, account_id: ACC, account_role: 'superuser' }]
    await expect(send(manual)).rejects.toMatchObject({ status: 403 })
    expect(calls).toHaveLength(0); expect(remaining()).toBe(1)
  })
  it('C3. `manual_reply` WITHOUT the verified actor (what a Flow, automation, AI or API path would have to forge) is blocked', async () => {
    world({ bsuid: BSUID, authorized: 1 })
    await expect(send({ origin: 'manual_reply' })).rejects.toMatchObject({ status: 403, message: expect.stringContaining('bsuid_automated_blocked') })
    expect(calls).toHaveLength(0); expect(remaining()).toBe(1)
  })
  it('D. an agent of ANOTHER account, or a contact of another account, is blocked and spends nothing', async () => {
    world({ bsuid: BSUID, authorized: 1 })
    h.db.tables.profiles = [{ id: 'po', user_id: AGENT, account_id: OTHER_ACC, account_role: 'admin' }]
    await expect(send(manual)).rejects.toMatchObject({ status: 403 })
    // a Keyler agent asking for the same contact id inside ANOTHER account's context: the contact is not in that account
    h.db.tables.profiles = [{ id: 'pk', user_id: AGENT, account_id: OTHER_ACC, account_role: 'agent' }]
    h.db.tables.whatsapp_config.push({ id: 'cfg2', account_id: OTHER_ACC, user_id: 'o2', phone_number_id: 'pn2', waba_id: 'w2', access_token: 'enc', status: 'connected' })
    process.env[PILOT] = `${ACC}:${PN}:${WABA},${OTHER_ACC}:pn2:w2`
    await expect(resolveContactTarget(userSession() as never, OTHER_ACC, { id: 'contact-1', phone: '' }, manual)).rejects.toBeInstanceOf(Error)
    expect(calls).toHaveLength(0); expect(remaining()).toBe(1)
  })
  it('E. Rossy (account outside the pilot): a phone contact behaves as before; a BSUID-only contact stays disabled', async () => {
    world({ phone: PHONE, pilot: false })
    await send(manual); await send()
    expect(calls.every((c) => c.to === PHONE && !('recipient' in c))).toBe(true)
    world({ bsuid: BSUID, authorized: 1, pilot: false })
    await expect(send(manual)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('bsuid_disabled') })
    expect(remaining()).toBe(1)
  })
  it('F. Flows / automations (engine senders) can never spend the credit, even for the right contact', async () => {
    world({ bsuid: BSUID, authorized: 1 })
    await expect(engineSendText({ ...base, accountId: ACC, text: 'x' } as never)).rejects.toBeInstanceOf(BsuidSendBlockedError)
    expect(calls).toHaveLength(0); expect(remaining()).toBe(1)
  })
  it('G. if the privileged consume call itself errors, the send fails CLOSED: no Meta call, nothing stored, credit untouched', async () => {
    world({ bsuid: BSUID, authorized: 1 })
    h.db.failReads.add('rpc:consume_bsuid_send')
    await expect(send(manual)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('bsuid_check_failed') })
    expect(calls).toHaveLength(0); expect(h.db.tables.messages).toHaveLength(0); expect(remaining()).toBe(1)
  })
  it('G2. if the membership / ownership read fails, it fails closed too', async () => {
    world({ bsuid: BSUID, authorized: 1 })
    h.db.failReads.add('profiles')
    await expect(send(manual)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('bsuid_check_failed') })
    expect(calls).toHaveLength(0); expect(remaining()).toBe(1)
  })
  it('H. a Meta error is not retried and the credit is not refunded', async () => {
    world({ bsuid: BSUID, authorized: 1 })
    metaMode = 'not_allowed'
    await expect(send(manual)).rejects.toMatchObject({ status: 502 })
    expect(calls).toHaveLength(1); expect(remaining()).toBe(0)
    metaMode = 'ok'
    await expect(send(manual)).rejects.toMatchObject({ status: 403 })
    expect(calls).toHaveLength(1)
  })
  it('I. the traditional phone send is unchanged: `to`, no `recipient`, no credit logic, no privileged call', async () => {
    world({ phone: PHONE })
    await send(manual)
    expect(calls[0]).toMatchObject({ to: PHONE }); expect('recipient' in calls[0]).toBe(false)
    expect(h.db.rpcCalls.filter((r) => r.name === 'consume_bsuid_send')).toHaveLength(0)
  })
  it('J. the BSUID goes in `recipient` only, never as a phone `to` and never with a phone-looking value', async () => {
    world({ bsuid: BSUID, authorized: 1 })
    await send(manual)
    expect(calls[0].recipient).toBe(BSUID)
    expect('to' in calls[0]).toBe(false)
    expect(String(calls[0].recipient)).not.toMatch(/^\d+$/)
  })
  it('K. a blocked or failed send is an error to the caller (403/502) and stores NO message, so it can never look like a delivered reply', async () => {
    world({ bsuid: BSUID, authorized: 0 })
    await expect(send(manual)).rejects.toMatchObject({ status: 403 })
    expect(h.db.tables.messages).toHaveLength(0)
  })
  it('the privileged client is the one that spends the credit (the agent session is denied the function, as in production)', async () => {
    world({ bsuid: BSUID, authorized: 1 })
    const session = userSession() as unknown as { rpc: (n: string, a: Record<string, unknown>) => Promise<{ error: { code: string } | null }> }
    expect((await session.rpc('consume_bsuid_send', { p_account_id: ACC, p_contact_id: 'contact-1', p_origin: 'manual_reply' })).error?.code).toBe('42501')
    expect(remaining()).toBe(1)
  })
})


// ---------------------------------------------------------------------------------------------------------------------
// P0 incident (2026-10-26): human agents must be able to answer hidden-number customers of an account that has switched on
// bsuid_pilot_scopes.agents_reply_without_credit (migration 080), WITHOUT a credit — and only through a verified agent / manual_reply.
// ---------------------------------------------------------------------------------------------------------------------
describe('agent replies without credit (per-number policy, migration 080)', () => {
  const OLD = 'bbbbbbbb-0000-4000-8000-00000000000b'
  const mk = (o: { policy?: boolean; env?: boolean; lastCustomerHoursAgo?: number | null; role?: string; phone?: string; superseded?: boolean; bsuid?: boolean } = {}) => {
    world({ bsuid: o.bsuid === false ? undefined : BSUID, phone: o.phone, pilot: o.env === true, role: o.role } as never)
    h.db.tables.bsuid_pilot_scopes = o.env === true ? [] : [{ account_id: ACC, phone_number_id: PN, waba_id: WABA, enabled: true, agents_reply_without_credit: o.policy ?? true, max_agent_replies_per_contact_hour: 60 }]
    resetBsuidScopeCache()
    if (o.superseded) h.db.tables.contact_identities[0].superseded_at = '2026-10-26T00:00:00Z'
    if (o.lastCustomerHoursAgo !== null) h.db.tables.messages.push({ id: 'cm1', conversation_id: 'conv-1', sender_type: 'customer', created_at: new Date(h.db.now() - (o.lastCustomerHoursAgo ?? 0.2) * 3_600_000).toISOString() })
    if (o.role) h.db.tables.profiles = [{ id: 'pv', user_id: AGENT, account_id: ACC, account_role: o.role }]
  }
  const reply = (text = 'Sí estimado', extra: Record<string, unknown> = {}) =>
    sendMessageToConversation(userSession() as never, ACC, { conversationId: 'conv-1', messageType: 'text', contentText: text, ...manual, ...extra } as never)

  it('THE INCIDENT: an agent answers a hidden-number customer with no credit; it goes to Meta by `recipient`, is stored, and no credit is spent', async () => {
    mk()
    const out = await reply('Sí estimado')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ messaging_product: 'whatsapp', recipient: BSUID, type: 'text' })
    expect('to' in calls[0]).toBe(false)
    expect(JSON.stringify(out)).toContain('wamid.OUT1')
    expect(h.db.tables.messages.filter((m) => m.content_text === 'Sí estimado')).toHaveLength(1)
    expect(remaining()).toBe(0)
    expect(audit('send_consumed')).toHaveLength(0)
    expect(audit('send_policy_allowed')).toHaveLength(1)
  })
  it('several replies in a row are allowed (a real conversation), each audited', async () => {
    mk(); await reply('uno'); await reply('dos'); await reply('tres')
    expect(calls).toHaveLength(3); expect(audit('send_policy_allowed')).toHaveLength(3)
  })
  it('closed by default: with the policy off (Keyler: credit-based pilot) the same reply is refused, and a granted credit still works', async () => {
    mk({ policy: false })
    await expect(reply()).rejects.toMatchObject({ status: 403, message: expect.stringContaining('bsuid_not_authorized') })
    expect(calls).toHaveLength(0)
    h.db.tables.contact_identities[0].send_authorized_remaining = 1
    await reply('with a credit'); expect(calls).toHaveLength(1); expect(remaining()).toBe(0)
  })
  it('an account in the pilot only through the ENVIRONMENT variable (no DB scope row) keeps the credit rule', async () => {
    mk({ env: true })
    await expect(reply()).rejects.toMatchObject({ status: 403 })
    expect(calls).toHaveLength(0)
  })
  it('the 24-hour customer-service window: refused when the customer wrote more than 24 h ago or never', async () => {
    mk({ lastCustomerHoursAgo: 25 }); await expect(reply()).rejects.toMatchObject({ status: 403 })
    mk({ lastCustomerHoursAgo: null }); await expect(reply()).rejects.toMatchObject({ status: 403 })
    expect(calls).toHaveLength(0)
  })
  it('a viewer, a user of another account and a call without the verified actor are refused even with the policy on', async () => {
    mk({ role: 'viewer' }); await expect(reply()).rejects.toMatchObject({ status: 403 })
    mk(); h.db.tables.profiles = [{ id: 'po', user_id: AGENT, account_id: OLD, account_role: 'admin' }]; await expect(reply()).rejects.toMatchObject({ status: 403 })
    mk(); await expect(reply('x', { actor: undefined })).rejects.toMatchObject({ status: 403 })
    expect(calls).toHaveLength(0)
  })
  it('the public API, the AI and automations cannot use it: their origin is `automated` (the default), refused before any credit or policy is consulted', async () => {
    mk()
    await expect(reply('x', { origin: 'automated', actor: undefined })).rejects.toMatchObject({ status: 403 })
    expect(calls).toHaveLength(0)
    expect(h.db.rpcCalls.filter((r) => r.name === 'consume_bsuid_send')).toHaveLength(0)
  })
  it('a contact whose BSUID was replaced: the reply goes to the NEW active id; a contact with no active id is refused', async () => {
    mk()
    h.db.tables.contact_identities[0].superseded_at = '2026-10-26T00:00:00Z'
    h.db.tables.contact_identities.push({ id: 'i2', account_id: ACC, contact_id: 'contact-1', kind: 'bsuid', value: 'PE.NEW0000000000009', superseded_at: null, send_authorized_remaining: 0 })
    await reply(); expect(calls[0].recipient).toBe('PE.NEW0000000000009')
    mk({ superseded: true }); await expect(reply()).rejects.toMatchObject({ status: 400 })   // no active id and no phone: nothing to address (same as before)
  })
  it('a contact that had a PHONE and later received a BSUID keeps the phone route: no policy, no credit, no `recipient`', async () => {
    mk({ phone: PHONE })
    await reply('hola'); expect(calls[0]).toMatchObject({ to: PHONE }); expect('recipient' in calls[0]).toBe(false)
    expect(h.db.rpcCalls.filter((r) => r.name === 'consume_bsuid_send')).toHaveLength(0)
  })
  it('the per-contact hourly cap of agent replies refuses the excess', async () => {
    mk(); h.db.tables.bsuid_pilot_scopes[0].max_agent_replies_per_contact_hour = 2
    await reply('1'); await reply('2')
    await expect(reply('3')).rejects.toMatchObject({ status: 403 })
    expect(calls).toHaveLength(2)
  })
  it('a Meta error is not retried and spends nothing; switching the policy off (kill switch) refuses at once', async () => {
    mk(); metaMode = 'not_allowed'
    await expect(reply()).rejects.toMatchObject({ status: 502 })
    expect(calls).toHaveLength(1); expect(remaining()).toBe(0)
    metaMode = 'ok'; h.db.tables.bsuid_pilot_scopes[0].agents_reply_without_credit = false
    await expect(reply()).rejects.toMatchObject({ status: 403 })
    expect(calls).toHaveLength(1)
  })
})
