import { describe, expect, it, vi } from 'vitest'
import { createInMemoryDb } from '@/test/in-memory-db'
import { resolveInboundContact } from './resolve-identity'
import { resolveInboundIdentity } from '@/lib/whatsapp/resolve-sender-identity'

const A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const OWNER = 'cccccccc-0000-4000-8000-00000000000c'
const BSUID = 'PE.QA0000000000001'
const OTHER = 'PE.QA0000000000002'
const PARENT = 'PE.ENT.QAP000000001'

function ident(message: Record<string, unknown>, contact: Record<string, unknown> = {}) {
  const r = resolveInboundIdentity(message, contact)
  if (!r.ok) throw new Error('fixture identity must resolve')
  return r
}
const resolve = (db: ReturnType<typeof createInMemoryDb>, account: string, message: Record<string, unknown>, contact: Record<string, unknown> = {}) =>
  resolveInboundContact(db.client as never, account, OWNER, ident(message, contact), '')

describe('resolveInboundContact', () => {
  it('phone only: identical to the previous behaviour (creates, then reuses; no identity rows)', async () => {
    const db = createInMemoryDb()
    const first = await resolve(db, A, { from: '51900000001' }, { wa_id: '51900000001', profile: { name: 'Ana' } })
    const again = await resolve(db, A, { from: '+51 900 000 001' }, { wa_id: '51900000001' })
    expect(first).toMatchObject({ wasCreated: true, via: 'phone' })
    expect(again).toMatchObject({ wasCreated: false })
    expect(again?.contact.id).toBe(first?.contact.id)
    expect(db.tables.contact_identities).toHaveLength(0)
    expect(db.tables.contacts).toHaveLength(1)
  })

  it('BSUID only: creates a phone-less contact (empty phone, never the id), then reuses it', async () => {
    const db = createInMemoryDb()
    const first = await resolve(db, A, { from_user_id: BSUID }, { user_id: BSUID, profile: { name: 'Ana', username: 'ana_01' } })
    expect(first).toMatchObject({ wasCreated: true, via: 'bsuid' })
    const row = db.tables.contacts[0]
    expect(row).toMatchObject({ account_id: A, phone: '', phone_optional: true, name: 'Ana', wa_username: 'ana_01' })
    expect(JSON.stringify(row)).not.toContain(BSUID)
    const again = await resolve(db, A, { from_user_id: BSUID }, { user_id: BSUID, profile: { name: 'Ana', username: 'ana_01' } })
    expect(again).toMatchObject({ wasCreated: false })
    expect(again?.contact.id).toBe(first?.contact.id)
    expect(db.tables.contacts).toHaveLength(1)
  })

  it('a changed display name / username updates the contact but the id stays the key', async () => {
    const db = createInMemoryDb()
    const first = await resolve(db, A, { from_user_id: BSUID }, { user_id: BSUID, profile: { name: 'Ana', username: 'ana_01' } })
    await resolve(db, A, { from_user_id: BSUID }, { user_id: BSUID, profile: { name: 'Ana P.', username: 'ana_new' } })
    expect(db.tables.contacts).toHaveLength(1)
    expect(db.tables.contacts[0]).toMatchObject({ id: first?.contact.id, name: 'Ana P.', wa_username: 'ana_new' })
  })

  it('profile absent: a neutral name, no crash', async () => {
    const db = createInMemoryDb()
    await resolve(db, A, { from_user_id: BSUID }, {})
    expect(db.tables.contacts[0].name).toBe('WhatsApp user')
  })

  it('two users with the same visible name are two contacts (a name proves nothing)', async () => {
    const db = createInMemoryDb()
    await resolve(db, A, { from_user_id: BSUID }, { user_id: BSUID, profile: { name: 'Ana' } })
    await resolve(db, A, { from_user_id: OTHER }, { user_id: OTHER, profile: { name: 'Ana' } })
    expect(db.tables.contacts).toHaveLength(2)
  })

  it('the same BSUID in another account is another contact (account isolation)', async () => {
    const db = createInMemoryDb()
    const a = await resolve(db, A, { from_user_id: BSUID }, { user_id: BSUID })
    const b = await resolve(db, B, { from_user_id: BSUID }, { user_id: BSUID })
    expect(a?.contact.id).not.toBe(b?.contact.id)
    expect(db.tables.contacts.map((c) => c.account_id).sort()).toEqual([A, B])
  })

  it('phone + BSUID on an existing phone contact: links, keeps the phone, no new contact', async () => {
    const db = createInMemoryDb()
    const created = await resolve(db, A, { from: '51900000001' }, { wa_id: '51900000001', profile: { name: 'Ana' } })
    const out = await resolve(db, A, { from: '51900000001', from_user_id: BSUID, from_parent_user_id: PARENT }, { wa_id: '51900000001', user_id: BSUID, parent_user_id: PARENT, profile: { name: 'Ana', username: 'ana_01' } })
    expect(out).toMatchObject({ via: 'phone+bsuid', wasCreated: false })
    expect(out?.contact.id).toBe(created?.contact.id)
    expect(db.tables.contacts).toHaveLength(1)
    expect(db.tables.contacts[0]).toMatchObject({ phone: '51900000001', wa_username: 'ana_01' })
    expect(db.tables.contact_identities.map((i) => i.kind).sort()).toEqual(['bsuid', 'parent_bsuid'])
    // the next BSUID-only message reaches the same contact
    const later = await resolve(db, A, { from_user_id: BSUID }, { user_id: BSUID })
    expect(later?.contact.id).toBe(created?.contact.id)
  })

  it('phone + BSUID, nobody known: one contact with a phone and the id', async () => {
    const db = createInMemoryDb()
    const out = await resolve(db, A, { from: '51900000001', from_user_id: BSUID }, { wa_id: '51900000001', user_id: BSUID })
    expect(out).toMatchObject({ wasCreated: true, via: 'phone+bsuid' })
    expect(db.tables.contacts).toHaveLength(1)
    expect(db.tables.contact_identities).toHaveLength(1)
  })

  it('a known BSUID contact whose phone appears later keeps its conversation owner and records the phone', async () => {
    const db = createInMemoryDb()
    const first = await resolve(db, A, { from_user_id: BSUID }, { user_id: BSUID })
    const out = await resolve(db, A, { from: '51900000001', from_user_id: BSUID }, { wa_id: '51900000001', user_id: BSUID })
    expect(out?.contact.id).toBe(first?.contact.id)
    expect(db.tables.contacts).toHaveLength(1)
    expect(db.tables.contacts[0].phone).toBe('51900000001')
  })

  it('CONFLICT: the phone belongs to one contact and the BSUID to another → nothing is merged', async () => {
    const db = createInMemoryDb()
    const byPhone = await resolve(db, A, { from: '51900000001' }, { wa_id: '51900000001' })
    const byId = await resolve(db, A, { from_user_id: BSUID }, { user_id: BSUID })
    const out = await resolve(db, A, { from: '51900000001', from_user_id: BSUID }, { wa_id: '51900000001', user_id: BSUID })
    expect(out?.contact.id).toBe(byId?.contact.id)
    expect(out?.conflict).toEqual({ phone_contact_id: byPhone?.contact.id, bsuid_contact_id: byId?.contact.id })
    expect(db.tables.contacts).toHaveLength(2)
    expect(db.tables.contacts.find((c) => c.id === byPhone?.contact.id)?.phone).toBe('51900000001')
    expect(db.tables.contacts.find((c) => c.id === byId?.contact.id)?.phone).toBe('')
  })

  it('a last-8-digits coincidence is not evidence for a BSUID contact: phone-less contacts are never matched by phone', async () => {
    const db = createInMemoryDb()
    await resolve(db, A, { from_user_id: BSUID }, { user_id: BSUID })
    const out = await resolve(db, A, { from: '51900000001' }, { wa_id: '51900000001' })
    expect(out).toMatchObject({ wasCreated: true })
    expect(db.tables.contacts).toHaveLength(2)
  })

  it('a replaced BSUID (system notice) attaches to the same contact and keeps the old one as history', async () => {
    const db = createInMemoryDb()
    const first = await resolve(db, A, { from_user_id: BSUID }, { user_id: BSUID })
    const out = await resolve(db, A, { type: 'system', from_user_id: OTHER, system: { type: 'user_changed_user_id', previous_user_id: BSUID } }, { user_id: OTHER })
    expect(out?.contact.id).toBe(first?.contact.id)
    expect(db.tables.contacts).toHaveLength(1)
    const ids = db.tables.contact_identities
    expect(ids.find((i) => i.value === BSUID)?.superseded_at).toBeTruthy()
    expect(ids.find((i) => i.value === OTHER)?.superseded_at).toBeNull()
    // the old id still resolves to the contact
    expect((await resolve(db, A, { from_user_id: BSUID }, { user_id: BSUID }))?.contact.id).toBe(first?.contact.id)
  })

  it('an unknown previous id does not attach to anyone: it is just a new contact', async () => {
    const db = createInMemoryDb()
    await resolve(db, A, { from_user_id: BSUID }, { user_id: BSUID })
    const out = await resolve(db, A, { type: 'system', from_user_id: OTHER, system: { type: 'user_changed_user_id', previous_user_id: 'PE.QA0000000000777' } }, { user_id: OTHER })
    expect(out?.wasCreated).toBe(true)
    expect(db.tables.contacts).toHaveLength(2)
  })

  it('fails closed on infrastructure errors: no contact is created', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = createInMemoryDb()
    db.failReads.add('contact_identities')
    expect(await resolve(db, A, { from_user_id: BSUID }, { user_id: BSUID })).toBeNull()
    expect(db.tables.contacts).toHaveLength(0)
    db.failReads.clear(); db.failReads.add('rpc:resolve_bsuid_contact')
    expect(await resolve(db, A, { from_user_id: BSUID }, { user_id: BSUID })).toBeNull()
    expect(db.tables.contacts).toHaveLength(0)
    expect(JSON.stringify(error.mock.calls)).not.toContain(BSUID)
    error.mockRestore()
  })

  it('a blocked BSUID contact is returned unchanged (name/username are not synced) so the caller can stop', async () => {
    const db = createInMemoryDb()
    await resolve(db, A, { from_user_id: BSUID }, { user_id: BSUID, profile: { name: 'Ana' } })
    db.tables.contacts[0].blocked = true
    const out = await resolve(db, A, { from_user_id: BSUID }, { user_id: BSUID, profile: { name: 'Renamed' } })
    expect(out?.contact.blocked).toBe(true)
    expect(db.tables.contacts[0].name).toBe('Ana')
  })

  it('concurrent first deliveries of the same BSUID end with one contact', async () => {
    const db = createInMemoryDb()
    const all = await Promise.all(Array.from({ length: 10 }, () => resolve(db, A, { from_user_id: BSUID }, { user_id: BSUID })))
    expect(new Set(all.map((o) => o?.contact.id)).size).toBe(1)
    expect(db.tables.contacts).toHaveLength(1)
  })
})
