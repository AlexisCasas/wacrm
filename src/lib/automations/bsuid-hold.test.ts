import { beforeEach, describe, expect, it, vi } from 'vitest'

// BSUID pilot: a contact known only by a WhatsApp user id never starts an automation (it could only park a wait row and fail at its first send).
// Accounts outside the pilot, and contacts with a phone, behave exactly as before.
const h = vi.hoisted(() => ({ db: null as unknown as import('@/test/in-memory-db').InMemoryDb }))
vi.mock('./admin-client', () => ({ supabaseAdmin: () => h.db.client }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.db.client }))

import { createInMemoryDb } from '@/test/in-memory-db'
import { runAutomationsForTrigger } from './engine'
import { resetBsuidScopeCache } from '@/lib/whatsapp/bsuid-flow-auth'

const ROSSY = 'c35b393f-0000-4000-8000-00000000000c'
const OTHER = 'bbbbbbbb-0000-4000-8000-00000000000b'
const PN = '1000000000000001'
const WABA = '3000000000000001'
const PILOT = 'WHATSAPP_BSUID_PILOT'

function world(opts: { dbScope?: boolean; env?: boolean; account?: string } = {}) {
  const acc = opts.account ?? ROSSY
  h.db = createInMemoryDb({
    automations: [{ id: 'au1', account_id: acc, user_id: 'owner', name: 'Seguimiento', trigger_type: 'tag_added', trigger_config: { tag_id: 't1' }, is_active: true, execution_count: 0 }],
    automation_steps: [], automation_logs: [], automation_pending_executions: [],
    bsuid_pilot_scopes: opts.dbScope ? [{ account_id: ROSSY, phone_number_id: PN, waba_id: WABA, enabled: true }] : [],
  })
  if (opts.env) process.env[PILOT] = `${ROSSY}:${PN}:${WABA}`; else delete process.env[PILOT]
  h.db.tables.contacts.push({ id: 'bsuid-contact', account_id: acc, phone: '', phone_optional: true, blocked: false, name: 'Ana' })
  h.db.tables.contacts.push({ id: 'phone-contact', account_id: acc, phone: '51900000001', phone_optional: false, blocked: false, name: 'Luis' })
  resetBsuidScopeCache()
}
const fire = (contactId: string, account = ROSSY) => runAutomationsForTrigger({ accountId: account, triggerType: 'tag_added', contactId, context: { tag_id: 't1' } } as never)
const logs = () => h.db.tables.automation_logs.length
const audit = (event: string) => h.db.tables.contact_identity_audit.filter((a) => a.event === event)

beforeEach(() => { vi.restoreAllMocks(); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}) })

describe('automations and contacts without a phone number (BSUID pilot)', () => {
  it('a phone-less contact of a pilot account (DB scope only) starts nothing and the skip is audited', async () => {
    world({ dbScope: true })
    await fire('bsuid-contact')
    expect(logs()).toBe(0)
    expect(h.db.tables.automation_pending_executions).toHaveLength(0)
    expect(audit('automation_skipped')).toHaveLength(1)
    expect(audit('automation_skipped')[0].detail).toMatchObject({ reason: 'pilot_hold_phoneless_contact', trigger: 'tag_added' })
  })
  it('the same holds when the account is in the pilot through the environment variable', async () => {
    world({ env: true })
    await fire('bsuid-contact')
    expect(logs()).toBe(0)
  })
  it('a contact WITH a phone in the same pilot account still runs the automation, unchanged', async () => {
    world({ dbScope: true })
    await fire('phone-contact')
    expect(logs()).toBe(1)
    expect(audit('automation_skipped')).toHaveLength(0)
  })
  it('an account outside the pilot is untouched, even for a phone-less contact (previous behavior)', async () => {
    world({ account: OTHER })
    await fire('bsuid-contact', OTHER)
    expect(logs()).toBe(1)
    expect(audit('automation_skipped')).toHaveLength(0)
  })
  it('a DB scope that is disabled does not hold anything', async () => {
    world({ dbScope: true }); h.db.tables.bsuid_pilot_scopes[0].enabled = false; resetBsuidScopeCache()
    await fire('bsuid-contact')
    expect(logs()).toBe(1)
  })
  it('if the scope table cannot be read, nothing is held (previous behavior) and nothing breaks', async () => {
    world({ dbScope: true }); h.db.failReads.add('bsuid_pilot_scopes'); resetBsuidScopeCache()
    await expect(fire('phone-contact')).resolves.toBeUndefined()
    expect(logs()).toBe(1)
  })
})
