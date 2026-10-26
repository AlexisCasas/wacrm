import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// BSUID phase 3: Flow runs may serve a contact known only by a WhatsApp user id, under the DB-managed authorization of migration 078.
// Meta is a fetch stub: nothing leaves the process. The SQL of the two check functions is run against PostgreSQL by qa/bsuid; here the
// in-memory database mirrors it, so these tests exercise the application side: the origin, what is asked of the database, and fail-closed.
const h = vi.hoisted(() => ({ db: null as unknown as import('@/test/in-memory-db').InMemoryDb }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.db.client }))
vi.mock('@/lib/media/voice-note-path', async (orig) => ({ ...(await orig<object>()), isVoiceNoteUrlForAccount: () => true }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'plain-token', encrypt: (v: string) => v, isLegacyFormat: () => false }))

import { createInMemoryDb } from '@/test/in-memory-db'
import { BsuidSendBlockedError, resolveContactTarget } from './recipient'
import { resetBsuidScopeCache } from './bsuid-flow-auth'
import { engineSendInteractiveButtons, engineSendInteractiveList, engineSendMedia, engineSendText } from '@/lib/flows/meta-send'
import { engineSendText as automationSendText } from '@/lib/automations/meta-send'

const ACC = 'aaaaaaaa-0000-4000-8000-00000000000a'      // Keyler-like
const ROSSY = 'bbbbbbbb-0000-4000-8000-00000000000b'    // another account
const BSUID = 'PE.QA0000000000001'
const PN = '1000000000000001'
const WABA = '3000000000000001'
const FLOW = 'f1f1f1f1-0000-4000-8000-000000000001'
const SUB = 'f2f2f2f2-0000-4000-8000-000000000002'
const RUN = 'r1r1r1r1-0000-4000-8000-000000000001'
const CONTACT = 'contact-1'
const PILOT = 'WHATSAPP_BSUID_PILOT'

type Body = Record<string, unknown>
let calls: Body[]
let metaMode: 'ok' | 'rejected'

function stubMeta() {
  calls = []; metaMode = 'ok'
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)))
    if (metaMode === 'rejected') return { ok: false, status: 400, headers: { get: () => null }, json: async () => ({ error: { message: 'invalid parameter', code: 100 } }) } as unknown as Response
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.F${calls.length}` }] }) } as unknown as Response
  }))
}

interface World { env?: boolean; dbScope?: boolean; flows?: boolean; auth?: Partial<Record<string, unknown>> | null; runStatus?: string; phone?: string }
function world(o: World = {}) {
  h.db = createInMemoryDb({
    whatsapp_config: [{ id: 'cfg', account_id: ACC, user_id: 'owner', phone_number_id: PN, waba_id: WABA, access_token: 'enc', status: 'connected' }],
    flows: [{ id: FLOW, account_id: ACC, status: 'active' }, { id: SUB, account_id: ACC, status: 'active' }],
    flow_runs: [{ id: RUN, account_id: ACC, contact_id: CONTACT, flow_id: FLOW, current_flow_id: null, status: o.runStatus ?? 'active' }],
    flow_run_subflow_frames: [], bsuid_flow_settings: o.flows === false ? [] : [{ account_id: ACC, flows_enabled: true }],
    bsuid_flow_authorizations: o.auth === null ? [] : [{ id: 'a1', account_id: ACC, flow_id: FLOW, contact_id: null, enabled: true, allow_text: true, allow_media: false, allow_buttons: false, allow_list: false, allow_audio: false, expires_at: null, ...(o.auth ?? {}) }],
    bsuid_pilot_scopes: o.dbScope ? [{ account_id: ACC, phone_number_id: PN, waba_id: WABA, enabled: true }] : [],
    profiles: [],
  })
  if (o.env === false) delete process.env[PILOT]; else process.env[PILOT] = `${ACC}:${PN}:${WABA}`
  h.db.tables.contacts.push({ id: CONTACT, account_id: ACC, user_id: 'owner', phone: o.phone ?? '', phone_optional: !o.phone, name: 'Ana', blocked: false })
  h.db.tables.contact_identities.push({ id: 'i1', account_id: ACC, contact_id: CONTACT, kind: 'bsuid', value: BSUID, superseded_at: null, send_authorized_remaining: 0 })
  h.db.tables.conversations.push({ id: 'conv-1', account_id: ACC, user_id: 'owner', contact_id: CONTACT, status: 'open' })
  resetBsuidScopeCache()
}
const base = { accountId: ACC, userId: 'owner', conversationId: 'conv-1', contactId: CONTACT, flowRunId: RUN }
const audit = (event: string) => h.db.tables.contact_identity_audit.filter((a) => a.event === event)
const credit = () => h.db.tables.contact_identities[0].send_authorized_remaining
const setAuth = (patch: Record<string, unknown>) => Object.assign(h.db.tables.bsuid_flow_authorizations[0], patch)

beforeEach(() => { process.env.FLOW_MEDIA_AUDIO_SCOPE = 'all'; vi.restoreAllMocks(); vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {}); stubMeta() })
afterEach(() => { vi.unstubAllGlobals(); delete process.env[PILOT]; delete process.env.FLOW_MEDIA_AUDIO_SCOPE })

describe('authorized Flow → BSUID by `recipient`', () => {
  it('a text node of an authorized flow reaches the BSUID, never a phone, and spends no manual credit', async () => {
    world()
    await engineSendText({ ...base, text: 'Hola Ana' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ messaging_product: 'whatsapp', recipient: BSUID, type: 'text' })
    expect('to' in calls[0]).toBe(false)
    expect(credit()).toBe(0)
    expect(audit('send_consumed')).toHaveLength(0)
    expect(h.db.rpcCalls.filter((r) => r.name === 'consume_bsuid_send')).toHaveLength(0)
  })
  it('every modality is refused until its flag is turned on, and then goes by `recipient`', async () => {
    world()
    const media = () => engineSendMedia({ ...base, kind: 'image', link: 'https://cdn.test/a.png' } as never)
    const buttons = () => engineSendInteractiveButtons({ ...base, bodyText: 'elige', buttons: [{ id: 'a', title: 'A' }] } as never)
    const list = () => engineSendInteractiveList({ ...base, bodyText: 'elige', buttonLabel: 'ver', sections: [{ title: 'S', rows: [{ id: 'r', title: 'R' }] }] } as never)
    const audio = () => engineSendMedia({ ...base, kind: 'audio', link: 'https://cdn.test/a.ogg', voice: true } as never)
    for (const send of [media, buttons, list, audio]) await expect(send()).rejects.toBeInstanceOf(BsuidSendBlockedError)
    expect(calls).toHaveLength(0)
    setAuth({ allow_media: true, allow_buttons: true, allow_list: true, allow_audio: true })
    for (const send of [media, buttons, list, audio]) await send()
    expect(calls).toHaveLength(4)
    expect(calls.every((c) => c.recipient === BSUID && !('to' in c))).toBe(true)
  })
  it('each modality needs its OWN flag (media on does not open audio, buttons or lists)', async () => {
    world({ auth: { allow_media: true } })
    await engineSendMedia({ ...base, kind: 'image', link: 'https://cdn.test/a.png' } as never)
    await expect(engineSendMedia({ ...base, kind: 'audio', link: 'https://cdn.test/a.ogg', voice: true } as never)).rejects.toBeInstanceOf(BsuidSendBlockedError)
    await expect(engineSendInteractiveButtons({ ...base, bodyText: 'x', buttons: [{ id: 'a', title: 'A' }] } as never)).rejects.toBeInstanceOf(BsuidSendBlockedError)
    await expect(engineSendInteractiveList({ ...base, bodyText: 'x', buttonLabel: 'v', sections: [] } as never)).rejects.toBeInstanceOf(BsuidSendBlockedError)
    expect(calls).toHaveLength(1)
  })
  it('the DB pilot scope alone (no environment variable) switches the number on: no restart needed', async () => {
    world({ env: false, dbScope: true })
    await engineSendText({ ...base, text: 'hola' })
    expect(calls[0]).toMatchObject({ recipient: BSUID })
  })
  it('a canary authorization for ONE contact works for that contact', async () => {
    world({ auth: { contact_id: CONTACT } })
    await engineSendText({ ...base, text: 'hola' })
    expect(calls).toHaveLength(1)
  })
  it('after the contact\'s BSUID changes, the flow follows the NEW active id', async () => {
    world()
    h.db.tables.contact_identities[0].superseded_at = '2026-10-26T00:00:00Z'
    h.db.tables.contact_identities.push({ id: 'i2', account_id: ACC, contact_id: CONTACT, kind: 'bsuid', value: 'PE.NEW0000000000002', superseded_at: null, send_authorized_remaining: 0 })
    await engineSendText({ ...base, text: 'hola' })
    expect(calls[0].recipient).toBe('PE.NEW0000000000002')
  })
})

describe('everything not explicitly authorized is refused (closed by default)', () => {
  const blocked = async (why: string) => {
    await expect(engineSendText({ ...base, text: 'x' })).rejects.toBeInstanceOf(BsuidSendBlockedError)
    expect(calls).toHaveLength(0)
    expect(credit()).toBe(0)
    expect(audit('send_blocked').some((a) => JSON.stringify(a.detail).includes(why))).toBe(true)
  }
  it('no authorization row', async () => { world({ auth: null }); await blocked('flow_not_authorized') })
  it('authorization present but disabled (default state)', async () => { world({ auth: { enabled: false } }); await blocked('flow_not_authorized') })
  it('the account master switch is off (account kill switch)', async () => { world({ flows: false }); await blocked('flows_disabled') })
  it('the master switch row exists but is false', async () => { world(); h.db.tables.bsuid_flow_settings[0].flows_enabled = false; await blocked('flows_disabled') })
  it('an expired authorization', async () => { world({ auth: { expires_at: '2020-01-01T00:00:00Z' } }); await blocked('flow_not_authorized') })
  it('an authorization for ANOTHER contact (canary) does not serve this one', async () => { world({ auth: { contact_id: 'someone-else' } }); await blocked('flow_not_authorized') })
  it('an authorization for ANOTHER flow does not serve this run', async () => { world({ auth: { flow_id: SUB } }); await blocked('flow_not_authorized') })
  it('a run that is not active (completed, failed, paused) cannot send', async () => { world({ runStatus: 'completed' }); await blocked('run_invalid') })
  it('a run id that belongs to another contact is refused', async () => {
    world(); h.db.tables.flow_runs[0].contact_id = 'someone-else'; await blocked('run_invalid')
  })
  it('a run id that does not exist is refused (an id cannot be invented)', async () => {
    world()
    await expect(engineSendText({ ...base, flowRunId: 'r9r9r9r9-0000-4000-8000-000000000009', text: 'x' })).rejects.toBeInstanceOf(BsuidSendBlockedError)
    expect(calls).toHaveLength(0)
  })
  it('a call stack whose CALLED flow is not authorized is refused (every flow of the run must be)', async () => {
    world(); h.db.tables.flow_runs[0].current_flow_id = SUB; h.db.tables.flow_run_subflow_frames.push({ flow_run_id: RUN, callee_flow_id: SUB })
    await blocked('flow_not_authorized')
    h.db.tables.bsuid_flow_authorizations.push({ id: 'a2', account_id: ACC, flow_id: SUB, contact_id: null, enabled: true, allow_text: true, allow_media: false, allow_buttons: false, allow_list: false, allow_audio: false, expires_at: null })
    await engineSendText({ ...base, text: 'ok now' })
    expect(calls).toHaveLength(1)
  })
  it('the kill switch acts on the very next message of a run already in progress', async () => {
    world()
    await engineSendText({ ...base, text: 'one' })
    h.db.tables.bsuid_flow_settings[0].flows_enabled = false
    await expect(engineSendText({ ...base, text: 'two' })).rejects.toBeInstanceOf(BsuidSendBlockedError)
    expect(calls).toHaveLength(1)
  })
  it('switching one flow off does the same without touching the account switch', async () => {
    world()
    await engineSendText({ ...base, text: 'one' })
    setAuth({ enabled: false })
    await expect(engineSendText({ ...base, text: 'two' })).rejects.toBeInstanceOf(BsuidSendBlockedError)
    expect(calls).toHaveLength(1)
  })
  it('a number that is not in the pilot (neither environment nor DB) stays disabled even with a valid authorization', async () => {
    world({ env: false })
    await blocked('bsuid_disabled'.replace('bsuid_', ''))
  })
  it('an EXISTING DB scope that is disabled does not switch the number on', async () => {
    world({ env: false, dbScope: true }); h.db.tables.bsuid_pilot_scopes[0].enabled = false; resetBsuidScopeCache()
    await expect(engineSendText({ ...base, text: 'x' })).rejects.toBeInstanceOf(BsuidSendBlockedError)
    expect(calls).toHaveLength(0)
  })
  it('a sender WITHOUT the run id (AI, API, anything that is not the Flows engine) stays automated and is refused', async () => {
    world()
    await expect(engineSendText({ accountId: ACC, userId: 'owner', conversationId: 'conv-1', contactId: CONTACT, text: 'x' })).rejects.toBeInstanceOf(BsuidSendBlockedError)
    expect(calls).toHaveLength(0)
  })
  it('automations stay blocked for a BSUID contact even when the contact\'s flow is authorized', async () => {
    world()
    await expect(automationSendText({ accountId: ACC, userId: 'owner', conversationId: 'conv-1', contactId: CONTACT, text: 'x' } as never)).rejects.toBeInstanceOf(BsuidSendBlockedError)
    expect(calls).toHaveLength(0)
  })
  it('a manual-reply origin with a flow run id is not a flow send: the resolver ignores flowRun for it', async () => {
    world()
    await expect(resolveContactTarget(h.db.client as never, ACC, { id: CONTACT, phone: '' }, { origin: 'manual_reply', flowRun: { id: RUN, modality: 'text' } })).rejects.toBeInstanceOf(BsuidSendBlockedError)
    expect(calls).toHaveLength(0)
  })
  it('origin "flow" without a run id is refused', async () => {
    world()
    await expect(resolveContactTarget(h.db.client as never, ACC, { id: CONTACT, phone: '' }, { origin: 'flow' })).rejects.toBeInstanceOf(BsuidSendBlockedError)
  })
})

describe('isolation between accounts', () => {
  it('an authorization of one account cannot serve a contact or run of another account', async () => {
    world()
    h.db.tables.contacts.push({ id: 'rossy-contact', account_id: ROSSY, user_id: 'o2', phone: '', phone_optional: true, name: 'R', blocked: false })
    h.db.tables.contact_identities.push({ id: 'i9', account_id: ROSSY, contact_id: 'rossy-contact', kind: 'bsuid', value: 'PE.ROSSY000000001', superseded_at: null, send_authorized_remaining: 0 })
    h.db.tables.whatsapp_config.push({ id: 'cfg2', account_id: ROSSY, user_id: 'o2', phone_number_id: '2000000000000002', waba_id: '4000000000000004', access_token: 'enc', status: 'connected' })
    process.env[PILOT] = `${ACC}:${PN}:${WABA}`   // Rossy is NOT in the pilot
    h.db.tables.flow_runs.push({ id: 'rossy-run', account_id: ROSSY, contact_id: 'rossy-contact', flow_id: FLOW, current_flow_id: null, status: 'active' })
    await expect(engineSendText({ accountId: ROSSY, userId: 'o2', conversationId: 'c9', contactId: 'rossy-contact', flowRunId: 'rossy-run', text: 'x' })).rejects.toBeInstanceOf(BsuidSendBlockedError)
    expect(calls).toHaveLength(0)
  })
  it('the scope list for a contact never includes flows of another account', async () => {
    world()
    h.db.tables.flows.push({ id: 'foreign', account_id: ROSSY, status: 'active' })
    h.db.tables.bsuid_flow_authorizations.push({ id: 'a9', account_id: ACC, flow_id: 'foreign', contact_id: null, enabled: true, allow_text: true })
    const client = h.db.client as unknown as { rpc: (n: string, a: Record<string, unknown>) => Promise<{ data: string[] }> }
    expect((await client.rpc('bsuid_flow_scope', { p_account_id: ACC, p_contact_id: CONTACT })).data).toEqual([FLOW])
  })
})

describe('fail closed, errors and retries', () => {
  it('if the authorization function errors, nothing is sent', async () => {
    world(); h.db.failReads.add('rpc:bsuid_flow_send_check')
    await expect(engineSendText({ ...base, text: 'x' })).rejects.toBeInstanceOf(BsuidSendBlockedError)
    expect(calls).toHaveLength(0)
    expect(audit('send_blocked').some((a) => JSON.stringify(a.detail).includes('bsuid_check_failed'))).toBe(true)
  })
  it('a Meta rejection throws once: one request, no automatic retry, no credit logic, nothing stored by the sender', async () => {
    world(); metaMode = 'rejected'
    await expect(engineSendText({ ...base, text: 'x' })).rejects.toThrow()
    expect(calls).toHaveLength(1)
    expect(credit()).toBe(0)
  })
  it('a contact with a valid phone keeps the phone route, with or without a run id, and never calls the BSUID checks', async () => {
    world({ phone: '51900000001', auth: null, flows: false })
    await engineSendText({ ...base, text: 'x' })
    await engineSendText({ accountId: ACC, userId: 'owner', conversationId: 'conv-1', contactId: CONTACT, text: 'y' })
    expect(calls.every((c) => c.to === '51900000001' && !('recipient' in c))).toBe(true)
    expect(h.db.rpcCalls.filter((r) => r.name.startsWith('bsuid_flow') || r.name === 'consume_bsuid_send')).toHaveLength(0)
  })
  it('the pilot scope cache is shared: one DB read per window, not one per message', async () => {
    world({ env: false, dbScope: true })
    const before = () => h.db.rpcCalls.length
    await engineSendText({ ...base, text: 'a' }); await engineSendText({ ...base, text: 'b' })
    expect(calls).toHaveLength(2)
    expect(before()).toBeGreaterThan(0)
  })
})

describe('manual replies on an account switched on only through the database scope (phase 4A)', () => {
  const manual = { origin: 'manual_reply' as const, actor: { userId: 'agent-1' } }
  const resolve = () => resolveContactTarget(h.db.client as never, ACC, { id: CONTACT, phone: '' }, manual)
  it('without a credit the reply is refused, with the credit it goes to the BSUID once, and the next one is refused again', async () => {
    world({ env: false, dbScope: true })
    h.db.tables.profiles.push({ id: 'p1', user_id: 'agent-1', account_id: ACC, account_role: 'agent' })
    await expect(resolve()).rejects.toBeInstanceOf(BsuidSendBlockedError)
    h.db.tables.contact_identities[0].send_authorized_remaining = 1
    expect(await resolve()).toEqual({ kind: 'bsuid', bsuid: BSUID })
    expect(credit()).toBe(0)
    await expect(resolve()).rejects.toBeInstanceOf(BsuidSendBlockedError)
  })
  it('switching the scope off blocks manual replies as well (credit untouched)', async () => {
    world({ env: false, dbScope: true })
    h.db.tables.profiles.push({ id: 'p1', user_id: 'agent-1', account_id: ACC, account_role: 'agent' })
    h.db.tables.contact_identities[0].send_authorized_remaining = 1
    h.db.tables.bsuid_pilot_scopes[0].enabled = false; resetBsuidScopeCache()
    await expect(resolve()).rejects.toBeInstanceOf(BsuidSendBlockedError)
    expect(credit()).toBe(1)
  })
})
