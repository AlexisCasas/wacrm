// @vitest-environment node
/**
 * Integration release · what production runs today (contact name lock + contact deletion controls) against the PR-02..PR-06 data model, on the REAL local stack:
 * deleting a contact whose chat is in Logistica with an order, payments, a finalization and a shipment must neither fail (foreign keys) nor lose what must survive.
 * Skipped unless LOCAL_URL is set. LOCAL ONLY.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createWorld, QA_ENABLED, type QaWorld } from '@/lib/orders/logistics/test-support/qa-env'
import { enablePayments, paymentsOps, type Row } from '@/lib/orders/payments/test-support/payments-ops'

let w: QaWorld
let p: ReturnType<typeof paymentsOps>
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

describe.skipIf(!QA_ENABLED)('production features (name lock, contact deletion) with PR-02..PR-06', () => {
  beforeAll(async () => {
    w = await createWorld()
    p = paymentsOps(w)
    await enablePayments(w, w.acc)
  }, 120_000)
  afterAll(async () => {
    if (w) await w.dispose()
  }, 90_000)

  it('both production migrations are present in the integrated schema, next to the PR ones', async () => {
    const { data: cols } = await w.admin.rpc('contact_delete_limits')
    expect(cols).toBeTruthy() // contact_deletion_controls
    const probe = await w.admin.from('contacts').select('name_locked').limit(1) // contacts_name_locked
    expect(probe.error).toBeNull()
    for (const t of ['contact_deletion_operations', 'contact_deletion_items', 'conversation_routing', 'order_payments', 'order_shipments', 'order_finalizations']) {
      expect((await w.admin.from(t).select('*', { head: true, count: 'exact' })).error, t).toBeNull()
    }
  })

  it('deleting a contact whose chat is in Logistica with orders / payments / finalization: succeeds, the audit is written, orders survive UNLINKED, financial history is intact', async () => {
    const { order, conv } = await p.order('compat', 100)
    const contactId = ((await w.admin.from('conversations').select('contact_id').eq('id', conv).single()).data as Row).contact_id as string
    await w.admin.from('conversation_routing').insert({ conversation_id: conv, account_id: w.acc, stage: 'logistics', version: 1 })
    await w.admin.from('messages').insert({ conversation_id: conv, sender_type: 'customer', content_type: 'text', content_text: 'hola', status: 'delivered' })
    const payId = await p.pay(order, '100.00')
    await w.admin.from('order_finalizations').upsert({ order_id: order, account_id: w.acc, finalized_at: new Date().toISOString(), source: 'qa_simulation', return_state: 'pending' })
    await w.admin.from('order_shipment_messages').insert({ account_id: w.acc, order_id: order, destination_episode: 1, conversation_id: conv }).then(() => null, () => null)

    const res = await w.admin.rpc('bulk_delete_contacts_internal', { p_account_id: w.acc, p_contact_ids: [contactId], p_public_base: 'http://127.0.0.1:55321/storage/v1/object/public/chat-media/', p_actor_user_id: w.owner.id, p_ack_protected: true })
    expect(res.error, JSON.stringify(res.error)).toBeNull()
    expect(res.data).toMatchObject({ deleted: 1 })

    // the chat and its routing are gone (cascade), the order is kept and unlinked
    expect((await w.admin.from('conversations').select('id').eq('id', conv)).data).toEqual([])
    expect((await w.admin.from('conversation_routing').select('conversation_id').eq('conversation_id', conv)).data).toEqual([])
    const o = (await w.admin.from('order_confirmations').select('contact_id, conversation_id, price').eq('id', order).single()).data as Row
    expect(o).toMatchObject({ conversation_id: null, price: 100 }) // the order row survives, its chat link is cleared (FK SET NULL)
    // payments, financial status, events and the finalization record are untouched
    expect((await p.payments(order)).map((x) => [x.id, x.status])).toEqual([[payId, 'confirmed']])
    expect(await p.financials(order)).toMatchObject({ financial_status: 'paid', paid_confirmed: 100 })
    expect((await p.events(order)).length).toBeGreaterThan(0)
    expect((await w.admin.from('order_finalizations').select('order_id').eq('order_id', order)).data).toHaveLength(1)
    // the deletion audit (production feature) recorded it
    const audit = await w.admin.from('contact_deletion_operations').select('deleted_count, conversations_deleted').eq('account_id', w.acc).order('created_at', { ascending: false }).limit(1)
    expect(audit.data?.[0]).toMatchObject({ deleted_count: 1, conversations_deleted: 1 })
  })

  it('the contact name lock coexists with an order that has PR-06 data (name_locked is per contact and untouched by the new tables)', async () => {
    const { order, conv } = await p.order('namelock', 50)
    const contactId = ((await w.admin.from('conversations').select('contact_id').eq('id', conv).single()).data as Row).contact_id as string
    const upd = await w.admin.from('contacts').update({ name: 'Nombre editado por una persona', name_locked: true }).eq('id', contactId).select('name, name_locked').single()
    expect(upd.error).toBeNull()
    expect(upd.data).toMatchObject({ name_locked: true })
    await p.pay(order, '50.00')
    expect((await w.admin.from('contacts').select('name, name_locked').eq('id', contactId).single()).data).toMatchObject({ name: 'Nombre editado por una persona', name_locked: true })
  })
})
