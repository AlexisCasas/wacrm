import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Outbound side of BSUID support: addressing in the Meta request, the recipient resolver, and every sender that used to
// require `contact.phone` (Flows text / media / voice note / buttons / list, and the inbox / AI path). Meta is a fetch
// stub: nothing leaves the process.
const h = vi.hoisted(() => ({ db: null as unknown as import('@/test/in-memory-db').InMemoryDb }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.db.client }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'plain-token', encrypt: (v: string) => v, isLegacyFormat: () => false }))
vi.mock('@/lib/media/voice-note-path', async (orig) => ({ ...(await orig<object>()), isVoiceNoteUrlForAccount: () => true }))

import { createInMemoryDb } from '@/test/in-memory-db'
import { resolveContactTarget } from './recipient'
import { sendInteractiveButtons, sendInteractiveList, sendMediaMessage, sendReactionMessage, sendTemplateMessage, sendTextMessage } from './meta-api'
import { engineSendInteractiveButtons, engineSendInteractiveList, engineSendMedia, engineSendText } from '@/lib/flows/meta-send'
import { sendMessageToConversation } from './send-message'

const ACC = 'aaaaaaaa-0000-4000-8000-00000000000a'
const OTHER_ACC = 'bbbbbbbb-0000-4000-8000-00000000000b'
const BSUID = 'PE.QA0000000000001'
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

function world(opts: { phone?: string; bsuid?: string; blocked?: boolean } = {}) {
  h.db = createInMemoryDb({
    whatsapp_config: [{ id: 'cfg', account_id: ACC, user_id: 'owner', phone_number_id: 'pn-1', access_token: 'enc', status: 'connected' }],
  })
  const contact = { id: 'contact-1', account_id: ACC, user_id: 'owner', phone: opts.phone ?? '', phone_optional: !opts.phone, name: 'Ana', blocked: Boolean(opts.blocked) }
  h.db.tables.contacts.push(contact)
  if (opts.bsuid) h.db.tables.contact_identities.push({ id: 'i1', account_id: ACC, contact_id: 'contact-1', kind: 'bsuid', value: opts.bsuid, superseded_at: null })
  h.db.tables.conversations.push({ id: 'conv-1', account_id: ACC, user_id: 'owner', contact_id: 'contact-1', status: 'open' })
  return contact
}
const base = { accountId: ACC, userId: 'owner', conversationId: 'conv-1', contactId: 'contact-1' }

beforeEach(() => { vi.restoreAllMocks(); vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {}); stubMeta() })
afterEach(() => { vi.unstubAllGlobals() })

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
  it('a valid phone wins and costs no extra query', async () => {
    world({ phone: PHONE, bsuid: BSUID })
    h.db.failReads.add('contact_identities')
    expect(await resolveContactTarget(h.db.client as never, ACC, { id: 'contact-1', phone: '+51 900 000 001' })).toEqual({ kind: 'phone', phone: PHONE })
  })
  it('no phone → the ACTIVE BSUID of this account', async () => {
    world({ bsuid: BSUID })
    expect(await resolveContactTarget(h.db.client as never, ACC, { id: 'contact-1', phone: '' })).toEqual({ kind: 'bsuid', bsuid: BSUID })
  })
  it('a superseded BSUID is never used to send', async () => {
    world({ bsuid: BSUID })
    h.db.tables.contact_identities[0].superseded_at = '2026-10-25T00:00:00Z'
    await expect(resolveContactTarget(h.db.client as never, ACC, { id: 'contact-1', phone: '' })).rejects.toThrow('contact not found for this account')
  })
  it('an identity of another account is invisible', async () => {
    world({ bsuid: BSUID })
    await expect(resolveContactTarget(h.db.client as never, OTHER_ACC, { id: 'contact-1', phone: '' })).rejects.toThrow('contact not found for this account')
  })
  it('keeps the previous errors when there is no BSUID', async () => {
    world({ phone: PHONE })
    await expect(resolveContactTarget(h.db.client as never, ACC, { id: 'contact-1', phone: '' })).rejects.toThrow('contact not found for this account')
    await expect(resolveContactTarget(h.db.client as never, ACC, { id: 'contact-1', phone: '12' })).rejects.toThrow('contact phone invalid: 12')
  })
  it('an invalid stored phone falls back to the BSUID instead of failing', async () => {
    world({ bsuid: BSUID })
    expect(await resolveContactTarget(h.db.client as never, ACC, { id: 'contact-1', phone: '12' })).toEqual({ kind: 'bsuid', bsuid: BSUID })
  })
})

describe('Flows senders: contact without a phone', () => {
  it('text: sent to the BSUID, stored in the thread, contact phone untouched', async () => {
    world({ bsuid: BSUID })
    const out = await engineSendText({ ...base, text: 'Hola Ana' })
    expect(out.whatsapp_message_id).toBe('wamid.OUT1')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ recipient: BSUID, type: 'text' })
    expect('to' in calls[0]).toBe(false)
    expect(h.db.tables.messages).toHaveLength(1)
    expect(h.db.tables.messages[0]).toMatchObject({ conversation_id: 'conv-1', sender_type: 'bot', content_text: 'Hola Ana', message_id: 'wamid.OUT1' })
    expect(h.db.tables.contacts[0].phone).toBe('')
  })

  it('a rejection by Meta is attempted ONCE (no prefix variants), keeps the contact intact, stores nothing and reports the error', async () => {
    world({ bsuid: BSUID })
    metaMode = 'not_allowed'
    await expect(engineSendText({ ...base, text: 'x' })).rejects.toThrow(/131030|not in allowed list/)
    expect(calls).toHaveLength(1)
    expect(h.db.tables.contacts[0].phone).toBe('')
    expect(h.db.tables.messages).toHaveLength(0)
  })

  it('a retry after the failure sends exactly one stored message (no duplicates)', async () => {
    world({ bsuid: BSUID })
    metaMode = 'not_allowed'
    await expect(engineSendText({ ...base, text: 'x' })).rejects.toThrow()
    metaMode = 'ok'
    await engineSendText({ ...base, text: 'x' })
    expect(h.db.tables.messages).toHaveLength(1)
  })

  it('image and voice note use `recipient` too (audio por producto path)', async () => {
    world({ bsuid: BSUID })
    process.env.FLOW_MEDIA_AUDIO_SCOPE = 'all'
    await engineSendMedia({ ...base, kind: 'image', link: 'https://cdn.test/a.png', caption: 'foto' })
    await engineSendMedia({ ...base, kind: 'audio', link: 'https://cdn.test/a.ogg', voice: true })
    delete process.env.FLOW_MEDIA_AUDIO_SCOPE
    expect(calls.map((c) => c.type)).toEqual(['image', 'audio'])
    expect(calls.every((c) => c.recipient === BSUID && !('to' in c))).toBe(true)
    expect(h.db.tables.messages.map((m) => m.content_type)).toEqual(['image', 'audio'])
  })

  it('buttons and list use `recipient`', async () => {
    world({ bsuid: BSUID })
    await engineSendInteractiveButtons({ ...base, kind: 'buttons', bodyText: 'elige', buttons: [{ id: 'a', title: 'A' }] } as never)
    await engineSendInteractiveList({ ...base, kind: 'list', bodyText: 'elige', buttonLabel: 'ver', sections: [{ title: 'S', rows: [{ id: 'r1', title: 'R' }] }] } as never)
    expect(calls).toHaveLength(2)
    expect(calls.every((c) => c.recipient === BSUID && !('to' in c))).toBe(true)
  })

  it('a blocked contact receives nothing', async () => {
    world({ bsuid: BSUID, blocked: true })
    await expect(engineSendText({ ...base, text: 'x' })).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  it('a contact with neither phone nor BSUID fails before calling Meta, as before', async () => {
    world({})
    await expect(engineSendText({ ...base, text: 'x' })).rejects.toThrow('contact not found for this account')
    expect(calls).toHaveLength(0)
  })

  it('REGRESSION: a phone contact is addressed with `to`, and a rejected number is still healed by variants', async () => {
    world({ phone: PHONE })
    await engineSendText({ ...base, text: 'hola' })
    expect(calls[0]).toMatchObject({ to: PHONE })
    expect('recipient' in calls[0]).toBe(false)
    calls.length = 0
    metaMode = 'not_allowed'
    await expect(engineSendText({ ...base, text: 'otra' })).rejects.toThrow()
    expect(calls.length).toBeGreaterThan(1) // variants were tried
  })
})

describe('inbox / AI path (sendMessageToConversation)', () => {
  it('replies to a BSUID contact in the same conversation and stores the message', async () => {
    world({ bsuid: BSUID })
    const out = await sendMessageToConversation(h.db.client as never, ACC, { conversationId: 'conv-1', messageType: 'text', contentText: 'Respuesta' } as never)
    expect(calls[0]).toMatchObject({ recipient: BSUID, type: 'text' })
    expect('to' in calls[0]).toBe(false)
    expect(JSON.stringify(out)).toContain('wamid.OUT1')
    expect(h.db.tables.messages.some((m) => m.conversation_id === 'conv-1' && m.content_text === 'Respuesta')).toBe(true)
    expect(h.db.tables.contacts[0].phone).toBe('')
  })
  it('a phone contact is unchanged', async () => {
    world({ phone: PHONE })
    await sendMessageToConversation(h.db.client as never, ACC, { conversationId: 'conv-1', messageType: 'text', contentText: 'Respuesta' } as never)
    expect(calls[0]).toMatchObject({ to: PHONE })
  })
  it('no phone and no BSUID is a 400, not a Meta call', async () => {
    world({})
    await expect(sendMessageToConversation(h.db.client as never, ACC, { conversationId: 'conv-1', messageType: 'text', contentText: 'x' } as never)).rejects.toMatchObject({ status: 400 })
    expect(calls).toHaveLength(0)
  })
  it('a Meta rejection keeps the trace (502) and does not change the contact', async () => {
    world({ bsuid: BSUID })
    metaMode = 'not_allowed'
    await expect(sendMessageToConversation(h.db.client as never, ACC, { conversationId: 'conv-1', messageType: 'text', contentText: 'x' } as never)).rejects.toMatchObject({ status: 502 })
    expect(calls).toHaveLength(1)
    expect(h.db.tables.contacts[0].phone).toBe('')
  })
})
