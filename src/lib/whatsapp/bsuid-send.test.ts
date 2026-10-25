import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Outbound side of BSUID support: addressing in the Meta request, the recipient resolver, and every sender that used to
// require `contact.phone` (Flows text / media / voice note / buttons / list, and the inbox / AI path). Meta is a fetch
// stub: nothing leaves the process.
const h = vi.hoisted(() => ({ db: null as unknown as import('@/test/in-memory-db').InMemoryDb }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.db.client }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'plain-token', encrypt: (v: string) => v, isLegacyFormat: () => false }))
vi.mock('@/lib/media/voice-note-path', async (orig) => ({ ...(await orig<object>()), isVoiceNoteUrlForAccount: () => true }))

import { createInMemoryDb } from '@/test/in-memory-db'
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
  return contact
}
const base = { accountId: ACC, userId: 'owner', conversationId: 'conv-1', contactId: 'contact-1' }
const remaining = () => h.db.tables.contact_identities[0]?.send_authorized_remaining
const audit = (event: string) => h.db.tables.contact_identity_audit.filter((a) => a.event === event)
const manual = { origin: 'manual_reply' as const }

beforeEach(() => { vi.restoreAllMocks(); vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {}); stubMeta() })
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
  const resolve = (origin: 'manual_reply' | 'automated', account = ACC, phone = '') => resolveContactTarget(h.db.client as never, account, { id: 'contact-1', phone }, { origin })

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
    sendMessageToConversation(h.db.client as never, ACC, { conversationId: 'conv-1', messageType: 'text', contentText: text, ...extra } as never)

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
    await sendMessageToConversation(h.db.client as never, ACC, { conversationId: 'conv-1', messageType: 'image', mediaUrl: 'https://cdn.test/a.png', origin: 'manual_reply' } as never)
    await sendMessageToConversation(h.db.client as never, ACC, { conversationId: 'conv-1', messageType: 'audio', mediaUrl: 'https://cdn.test/a.ogg', voiceNote: true, origin: 'manual_reply' } as never)
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
