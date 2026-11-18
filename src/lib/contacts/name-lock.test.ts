import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createInMemoryDb } from '@/test/in-memory-db'
import { applyAutomaticName, manualNameChange } from './name-lock'
import { findOrCreateContact } from './find-or-create'
import { resolveInboundContact } from './resolve-identity'

const A = 'acct-a'
const B = 'acct-b'
const OWNER = 'owner-1'
const BSUID = 'CO.AAAAAAAAAAAA'

describe('manualNameChange', () => {
  it('a changed name sets the name AND the lock in one patch', () => {
    expect(manualNameChange('Ana', ' Ana Perez ')).toEqual({ ok: true, patch: { name: 'Ana Perez', name_locked: true } })
  })
  it('an unchanged name is not an edit: no lock, no name in the patch', () => {
    expect(manualNameChange('Ana', ' Ana ')).toEqual({ ok: true, patch: {} })
    expect(manualNameChange(null, '')).toEqual({ ok: true, patch: {} })
    expect(manualNameChange(undefined, '   ')).toEqual({ ok: true, patch: {} })
  })
  it('an emptied or blank name is rejected and carries no patch (stored name and lock stay)', () => {
    expect(manualNameChange('Ana', '')).toEqual({ ok: false, reason: 'empty' })
    expect(manualNameChange('Ana', '   ')).toEqual({ ok: false, reason: 'empty' })
    expect(manualNameChange('Ana', null)).toEqual({ ok: false, reason: 'empty' })
  })
  it('naming a contact that had no name is an edit and locks', () => {
    expect(manualNameChange(null, 'Luis')).toEqual({ ok: true, patch: { name: 'Luis', name_locked: true } })
  })
})

describe('applyAutomaticName', () => {
  it('updates an unlocked contact and reports it', async () => {
    const db = createInMemoryDb()
    db.tables.contacts.push({ id: 'c1', account_id: A, phone: '51900000001', name: 'Old', name_locked: false, blocked: false })
    expect(await applyAutomaticName(db.client as unknown as SupabaseClient, 'c1', 'New')).toBe(true)
    expect(db.tables.contacts[0].name).toBe('New')
  })
  it('never touches a locked contact (even when the caller read a stale unlocked copy)', async () => {
    const db = createInMemoryDb()
    db.tables.contacts.push({ id: 'c1', account_id: A, phone: '51900000001', name: 'Manual', name_locked: true, blocked: false })
    expect(await applyAutomaticName(db.client as unknown as SupabaseClient, 'c1', 'Profile')).toBe(false)
    expect(db.tables.contacts[0].name).toBe('Manual')
  })
  it('is scoped to the account when asked', async () => {
    const db = createInMemoryDb()
    db.tables.contacts.push({ id: 'c1', account_id: A, phone: '51900000001', name: 'Old', name_locked: false, blocked: false })
    expect(await applyAutomaticName(db.client as unknown as SupabaseClient, 'c1', 'New', { accountId: B })).toBe(false)
    expect(db.tables.contacts[0].name).toBe('Old')
  })
  it('a database error or exception never throws (message processing must continue)', async () => {
    const failing = { from: () => ({ update: () => ({ eq: () => ({ eq: () => ({ select: () => Promise.resolve({ data: null, error: { code: 'XX000' } }) }) }) }) }) } as unknown as SupabaseClient
    const throwing = { from: () => { throw new Error('boom') } } as unknown as SupabaseClient
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(applyAutomaticName(failing, 'c1', 'X')).resolves.toBe(false)
    await expect(applyAutomaticName(throwing, 'c1', 'X')).resolves.toBe(false)
    spy.mockRestore()
  })
})

describe('inbound sync with the lock (phone contacts)', () => {
  const sync = (db: ReturnType<typeof createInMemoryDb>, phone: string, name: string) =>
    findOrCreateContact(db.client as unknown as SupabaseClient, A, OWNER, phone, name)

  it('a new contact gets the WhatsApp name and is NOT locked', async () => {
    const db = createInMemoryDb()
    const out = await sync(db, '51900000001', 'Ana WA')
    expect(out?.wasCreated).toBe(true)
    expect(db.tables.contacts).toHaveLength(1)
    expect(db.tables.contacts[0]).toMatchObject({ name: 'Ana WA', phone: '51900000001' })
    expect(db.tables.contacts[0].name_locked).not.toBe(true)
  })
  it('an automatic contact follows a profile change', async () => {
    const db = createInMemoryDb()
    await sync(db, '51900000001', 'Ana WA')
    await sync(db, '51900000001', 'Ana Nueva')
    expect(db.tables.contacts).toHaveLength(1)
    expect(db.tables.contacts[0].name).toBe('Ana Nueva')
  })
  it('a manually edited (locked) name survives new messages with another profile name', async () => {
    const db = createInMemoryDb()
    await sync(db, '51900000001', 'Ana WA')
    db.tables.contacts[0].name = 'Ana Cliente Keyler'
    db.tables.contacts[0].name_locked = true
    await sync(db, '51900000001', 'Ana Nueva')
    await sync(db, '51900000001', 'Otra cosa')
    expect(db.tables.contacts).toHaveLength(1)
    expect(db.tables.contacts[0].name).toBe('Ana Cliente Keyler')
  })
  it('the lock cannot be bypassed by a stale read: the contact is locked AFTER the webhook read it', async () => {
    const db = createInMemoryDb()
    await sync(db, '51900000001', 'Ana WA')
    const stale = { ...db.tables.contacts[0] } // what a webhook read before the operator saved
    db.tables.contacts[0].name = 'Manual'
    db.tables.contacts[0].name_locked = true
    expect(stale.name_locked).not.toBe(true)
    expect(await applyAutomaticName(db.client as unknown as SupabaseClient, stale.id as string, 'Profile')).toBe(false)
    expect(db.tables.contacts[0].name).toBe('Manual')
  })
  it('an empty profile name changes nothing; a blocked contact never changes', async () => {
    const db = createInMemoryDb()
    await sync(db, '51900000001', 'Ana WA')
    await sync(db, '51900000001', '')
    expect(db.tables.contacts[0].name).toBe('Ana WA')
    db.tables.contacts[0].blocked = true
    await sync(db, '51900000001', 'Blocked rename')
    expect(db.tables.contacts[0].name).toBe('Ana WA')
  })
  it('no duplicates and nothing else changes (phone, id, account)', async () => {
    const db = createInMemoryDb()
    await sync(db, '51900000001', 'Ana WA')
    const before = { ...db.tables.contacts[0] }
    await sync(db, '51900000001', 'Ana Nueva')
    await sync(db, '+51 900 000 001', 'Ana Nueva 2')
    expect(db.tables.contacts).toHaveLength(1)
    expect(db.tables.contacts[0]).toMatchObject({ id: before.id, phone: before.phone, account_id: A, user_id: OWNER })
  })
})

describe('inbound sync with the lock (BSUID-only contacts)', () => {
  const ident = (name: string, username?: string) => ({ ok: true as const, phone: undefined, bsuid: BSUID, name, username, warnings: [] }) as never
  const resolve = (db: ReturnType<typeof createInMemoryDb>, name: string, username?: string) =>
    resolveInboundContact(db.client as unknown as SupabaseClient, A, OWNER, ident(name, username), 'WhatsApp user')

  it('creates with the profile name, follows an unlocked change, keeps a locked name, and still syncs the username', async () => {
    const db = createInMemoryDb()
    const first = await resolve(db, 'Ana', 'ana_01')
    expect(db.tables.contacts).toHaveLength(1)
    expect(db.tables.contacts[0]).toMatchObject({ name: 'Ana', wa_username: 'ana_01' })

    await resolve(db, 'Ana P.', 'ana_02')
    expect(db.tables.contacts[0]).toMatchObject({ name: 'Ana P.', wa_username: 'ana_02' })

    db.tables.contacts[0].name = 'Cliente Manual'
    db.tables.contacts[0].name_locked = true
    const again = await resolve(db, 'Ana Cambio', 'ana_03')
    expect(db.tables.contacts).toHaveLength(1)
    expect(db.tables.contacts[0]).toMatchObject({ id: first?.contact.id, name: 'Cliente Manual', wa_username: 'ana_03', phone: '', phone_optional: true })
    expect(again?.contact.name).toBe('Cliente Manual')
  })
  it('does not touch the BSUID identity rows', async () => {
    const db = createInMemoryDb()
    await resolve(db, 'Ana', 'ana_01')
    const ids = JSON.stringify(db.tables.contact_identities)
    db.tables.contacts[0].name_locked = true
    await resolve(db, 'Otra', 'ana_09')
    expect(JSON.stringify(db.tables.contact_identities)).toBe(ids)
  })
})

describe('other automatic writers respect the lock', () => {
  it('ManyChat bridge (findOrCreateContact with full_name): a locked name is kept, an automatic one follows', async () => {
    const db = createInMemoryDb()
    const client = db.client as unknown as SupabaseClient
    await findOrCreateContact(client, A, OWNER, '51900000009', 'Nombre ManyChat')
    expect(db.tables.contacts[0].name).toBe('Nombre ManyChat')
    await findOrCreateContact(client, A, OWNER, '51900000009', 'Nombre ManyChat 2')
    expect(db.tables.contacts[0].name).toBe('Nombre ManyChat 2')
    db.tables.contacts[0].name_locked = true
    db.tables.contacts[0].name = 'Fijado por vendedor'
    await findOrCreateContact(client, A, OWNER, '51900000009', 'Nombre ManyChat 3')
    expect(db.tables.contacts).toHaveLength(1)
    expect(db.tables.contacts[0].name).toBe('Fijado por vendedor')
  })

  it('the ManyChat route uses the shared find-or-create (so it inherits the lock)', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/app/api/integrations/manychat/inbound/route.ts', 'utf8')
    expect(src).toMatch(/findOrCreateContact[\s\S]{0,80}@\/lib\/contacts\/find-or-create|from '@\/lib\/contacts\/find-or-create'/)
    expect(src).not.toMatch(/from\('contacts'\)[\s\S]{0,60}\.update\(/)
  })
})
