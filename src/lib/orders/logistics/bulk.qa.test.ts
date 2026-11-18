// @vitest-environment node
/**
 * PR-04 · BULK vouchers end to end against the REAL local Supabase: N documents uploaded without an order -> OCR -> conservative matching ->
 * associated (single safe candidate) or PENDING (a person chooses) -> manual association -> validation. The OCR provider is a scripted fake (no real
 * provider exists yet). Skipped unless LOCAL_URL is set. LOCAL ONLY (see test-support/qa-env).
 *
 *   eval "$(npx supabase status -o env | sed 's/^/export /')"; LOCAL_URL=$API_URL LOCAL_ANON=$ANON_KEY LOCAL_SERVICE=$SERVICE_ROLE_KEY npx vitest run src/lib/orders/logistics/bulk.qa.test.ts
 */
import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { associateDocument, processBulkDocument, searchPendingOrders } from '@/lib/orders/logistics/bulk'
import { listDocuments, uploadVoucher } from '@/lib/orders/logistics/documents'
import { getOrderPanel } from '@/lib/orders/logistics/panel'
import { reviewDocument } from '@/lib/orders/logistics/review'
import { createWorld, pdfBytes, QA_ENABLED, type QaWorld } from '@/lib/orders/logistics/test-support/qa-env'
import type { VoucherOcrProvider } from '@/lib/orders/logistics/ocr/types'
import { VoucherOcrError } from '@/lib/orders/logistics/ocr/types'

let w: QaWorld
let n = 0
const key = (p: string) => `${w.tag}-${p}-${(n += 1)}`

type Script = Record<string, { fields?: Record<string, { value: string; confidence: number }>; fail?: boolean; delayMs?: number }>
const script: Script = {}
const calls: Record<string, number> = {}
/** A scripted provider: the "seed" written inside the test PDF selects what the "OCR" reads. */
const provider: VoucherOcrProvider = {
  name: 'fake',
  extract: async (input) => {
    const text = new TextDecoder().decode(input.bytes)
    const seed = Object.keys(script).find((s) => text.includes(`% ${s} `))
    if (!seed) throw new VoucherOcrError('ocr_unreadable')
    calls[seed] = (calls[seed] ?? 0) + 1
    const s = script[seed]
    if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs))
    if (s.fail) throw new VoucherOcrError('ocr_provider_error')
    return { provider: 'fake', fields: s.fields ?? {} }
  },
}
const read = (dni: string | null, phone: string | null, confidence = 0.95) => ({
  ...(dni ? { dni: { value: dni, confidence } } : {}),
  ...(phone ? { phone: { value: phone, confidence } } : {}),
})

const orders: Record<string, string> = {}
const docs: Record<string, string> = {}
const batch = randomUUID()
const total = () => Object.values(calls).reduce((a, b) => a + b, 0)

async function bulkUpload(name: string) {
  const r = await uploadVoucher(w.ctxOf(w.logi, w.acc), w.admin, { fileName: `${name}.pdf`, bytes: pdfBytes(name), orderId: null, batchId: batch, requestKey: key(name), allowDuplicate: false })
  if (!r.ok) throw new Error(`bulk upload ${name}: ${r.status} ${r.error}`)
  docs[name] = r.body.document.id
  const { data } = await w.admin.from('order_documents').select('storage_path').eq('id', r.body.document.id).single()
  w.track((data as { storage_path: string }).storage_path)
}
const process = (name: string, actor = w.logi) => processBulkDocument(w.ctxOf(actor, w.acc), w.admin, { provider }, docs[name])
const row = async (name: string) => (await w.admin.from('order_documents').select('association, order_id, status, ocr_status').eq('id', docs[name]).single()).data as { association: string; order_id: string | null; status: string; ocr_status: string }
const panel = (orderId: string, actor = w.logi) => getOrderPanel(w.ctxOf(actor, w.acc), orderId)

describe.skipIf(!QA_ENABLED)('PR-04 bulk vouchers: OCR -> conservative matching -> associated | pending -> manual association', () => {
  beforeAll(async () => {
    w = await createWorld()
    // Orders of the account (DNI / phone are the matching SIGNALS; the order id is the only key)
    orders.safe = await w.mkOrder(w.acc, 'safe', { customer_name: 'Carlos Safe', dni: '10000001', phone: '51910000001' })
    orders.ambA = await w.mkOrder(w.acc, 'ambA', { customer_name: 'Ana Doble', dni: '20000002', phone: '51920000002', product: 'Producto A' })
    orders.ambB = await w.mkOrder(w.acc, 'ambB', { customer_name: 'Ana Doble', dni: '20000002', phone: '51920000002', product: 'Producto B' })
    orders.one = await w.mkOrder(w.acc, 'one', { customer_name: 'Luis Uno', dni: '30000003', phone: '51930000003' })
    orders.advanced = await w.mkOrder(w.acc, 'advanced', { customer_name: 'Eva Avanzada', dni: '40000004', phone: '51940000004' })
    orders.after = await w.mkOrder(w.acc, 'after', { customer_name: 'Eva Avanzada', dni: '40000004', phone: '51940000004' })
    orders.par = await w.mkOrder(w.acc, 'par', { customer_name: 'Pedro Paralelo', dni: '50000005', phone: '51950000005' })
    orders.locked = await w.mkOrder(w.acc, 'locked', { customer_name: 'Lola Bloqueada', dni: '60000006', phone: '51960000006' })
    // a DIFFERENT account with the very same DNI / phone as `safe`: it must never be a candidate
    orders.foreign = await w.mkOrder(w.accForeign, 'foreign', { customer_name: 'Carlos Safe', dni: '10000001', phone: '51910000001' })

    // `advanced` already has a validated voucher (so it is no longer waiting) and `locked` already started packaging
    for (const [name, order] of [['adv-pre', orders.advanced], ['lock-pre', orders.locked]] as const) {
      const r = await uploadVoucher(w.ctxOf(w.logi, w.acc), w.admin, { fileName: `${name}.pdf`, bytes: pdfBytes(name), orderId: order, batchId: null, requestKey: key(name), allowDuplicate: false })
      if (!r.ok) throw new Error('pre upload')
      const { data } = await w.admin.from('order_documents').select('storage_path').eq('id', r.body.document.id).single()
      w.track((data as { storage_path: string }).storage_path)
      const v = await reviewDocument(w.ctxOf(w.logi, w.acc), w.admin, r.body.document.id, { action: 'validate', reviewedData: { dni: '1' } })
      if (!v.ok) throw new Error('pre validate')
    }
    const start = await w.admin.rpc('start_order_packaging', { p_account: w.acc, p_actor: w.logi.id, p_order: orders.locked })
    expect(start.data).toMatchObject({ ok: true })

    Object.assign(script, {
      safe: { fields: read('10000001', '51910000001') },
      amb: { fields: read('20000002', '51920000002') },
      single: { fields: read('30000003', null) },
      none: { fields: read('99999999', '51999999999') },
      doubt: { fields: read('10000001', '51910000001', 0.5) },
      after: { fields: read('40000004', '51940000004') },
      broken: { fail: true },
      par: { fields: read('50000005', '51950000005'), delayMs: 300 },
    })
    for (const name of ['safe', 'amb', 'single', 'none', 'doubt', 'after', 'broken']) await bulkUpload(name)
  }, 120_000)

  afterAll(async () => {
    if (w) await w.dispose()
  }, 90_000)

  it('the whole batch is persisted before any processing (nothing depends on the browser)', async () => {
    const list = await listDocuments(w.ctxOf(w.sup, w.acc), { batchId: batch, association: 'pending' })
    expect(list.ok && list.body.documents).toHaveLength(7)
    expect(list.ok && list.body.documents.every((d) => d.order_id === null && d.ocr_status === 'none' && d.status === 'pending_review')).toBe(true)
  })

  it('SAFE match: one candidate, DNI + phone -> associated automatically (method auto) but NOT validated and the order does not move', async () => {
    const r = await process('safe')
    expect(r).toMatchObject({ ok: true, body: { outcome: 'associated', association: 'auto', order_id: orders.safe, signals: ['dni', 'phone'] } })
    expect(await row('safe')).toMatchObject({ association: 'auto', order_id: orders.safe, status: 'pending_review', ocr_status: 'done' })
    const p = await panel(orders.safe)
    expect(p.ok && p.body.logistics.status).toBe('pending_voucher')
    // the other account's order with the same DNI / phone was never a candidate
    expect((await w.admin.from('order_documents').select('id').eq('order_id', orders.foreign)).data).toHaveLength(0)
  })

  it('AMBIGUOUS (same customer, two pending orders): pending association, BOTH offered, nothing chosen, no PII in the answer', async () => {
    const r = await process('amb')
    expect(r).toMatchObject({ ok: true, body: { outcome: 'pending', reason: 'ambiguous' } })
    if (!r.ok || r.body.outcome !== 'pending') throw new Error('shape')
    expect(r.body.candidates.map((c) => c.order_id).sort()).toEqual([orders.ambA, orders.ambB].sort())
    expect(r.body.candidates.every((c) => c.signals.join() === 'dni,phone')).toBe(true)
    expect(JSON.stringify(r)).not.toMatch(/20000002|51920000002/)
    expect(await row('amb')).toMatchObject({ association: 'pending', order_id: null })
  })

  it('a single signal is not enough: pending (insufficient), the candidate is only suggested', async () => {
    const r = await process('single')
    expect(r).toMatchObject({ ok: true, body: { outcome: 'pending', reason: 'insufficient_signals' } })
    expect(r.ok && r.body.outcome === 'pending' && r.body.candidates.map((c) => c.order_id)).toEqual([orders.one])
    expect(await row('single')).toMatchObject({ association: 'pending', order_id: null })
  })

  it('NO match, LOW confidence and OCR failure all end as pending association for a person', async () => {
    expect(await process('none')).toMatchObject({ ok: true, body: { outcome: 'pending', reason: 'no_candidates', candidates: [] } })
    expect(await process('doubt')).toMatchObject({ ok: true, body: { outcome: 'pending', reason: 'low_confidence' } })
    expect(await process('broken')).toMatchObject({ ok: true, body: { outcome: 'pending', reason: 'ocr_failed', ocr_error_code: 'ocr_provider_error' } })
    for (const name of ['none', 'doubt', 'broken']) expect(await row(name)).toMatchObject({ association: 'pending', order_id: null })
  })

  it('orders that already have a validated voucher are not candidates: the voucher goes to the order still waiting', async () => {
    const r = await process('after')
    expect(r).toMatchObject({ ok: true, body: { outcome: 'associated', order_id: orders.after } })
  })

  it('RESUMABLE and idempotent: processing again never repeats OCR for a finished document and never re-associates', async () => {
    const before = total()
    expect(await process('safe')).toMatchObject({ ok: true, body: { outcome: 'already_associated', association: 'auto', order_id: orders.safe } })
    expect(await process('amb')).toMatchObject({ ok: true, body: { outcome: 'pending', reason: 'ambiguous' } })
    expect(total()).toBe(before) // no provider call for documents whose OCR was already done
    await process('broken') // the failed one IS retried
    expect(total()).toBe(before + 1)
    const stillPending = await listDocuments(w.ctxOf(w.logi2, w.acc), { batchId: batch, association: 'pending' })
    expect(stillPending.ok && stillPending.body.documents).toHaveLength(5)
  })

  it('an automatic association still REQUIRES a person to validate; manual association resolves the ambiguous one', async () => {
    // pending association cannot be validated
    expect(await reviewDocument(w.ctxOf(w.logi, w.acc), w.admin, docs.amb, { action: 'validate', reviewedData: { dni: '1' } })).toMatchObject({ ok: false, status: 409, error: 'association_required' })
    // a person picks the right order among the candidates
    const manual = await associateDocument(w.ctxOf(w.logi2, w.acc), w.admin, docs.amb, orders.ambB)
    expect(manual).toMatchObject({ ok: true, body: { changed: true, order_id: orders.ambB, document: { association: 'manual' } } })
    expect(await associateDocument(w.ctxOf(w.logi2, w.acc), w.admin, docs.amb, orders.ambB)).toMatchObject({ ok: true, body: { changed: false } })
    expect(await reviewDocument(w.ctxOf(w.logi2, w.acc), w.admin, docs.amb, { action: 'validate', reviewedData: { dni: '20000002' } })).toMatchObject({ ok: true, body: { status: 'validated' } })
    const b = await panel(orders.ambB)
    const a = await panel(orders.ambA)
    expect(b.ok && b.body.logistics.status).toBe('voucher_validated')
    expect(a.ok && a.body.logistics.status).toBe('pending_voucher') // the other order of the same customer was never touched

    // and the automatically associated one is validated by a person too
    expect(await reviewDocument(w.ctxOf(w.logi, w.acc), w.admin, docs.safe, { action: 'validate', reviewedData: { dni: '10000001' } })).toMatchObject({ ok: true, body: { status: 'validated' } })
    const s = await panel(orders.safe)
    expect(s.ok && s.body.logistics.status).toBe('voucher_validated')
  })

  it('the manual choice has a search among the orders still waiting (no DNI / phone, no advanced orders, no other account)', async () => {
    const found = await searchPendingOrders(w.ctxOf(w.logi, w.acc), 'Eva')
    expect(found.ok && found.body.orders.map((o) => o.order_id)).toEqual(expect.arrayContaining([orders.after]))
    expect(found.ok && found.body.orders.map((o) => o.order_id)).not.toContain(orders.advanced) // already has a validated voucher
    const carlos = await searchPendingOrders(w.ctxOf(w.logi, w.acc), 'Carlos')
    expect(carlos.ok && carlos.body.orders.map((o) => o.order_id)).not.toContain(orders.foreign) // another account
    expect(JSON.stringify(found)).not.toMatch(/40000004|51940000004/)
    expect(await searchPendingOrders(w.ctxOf(w.comm, w.acc), 'Eva')).toMatchObject({ ok: false, status: 404 }) // commercial reads orders elsewhere, not this
  })

  it('cross-account and locked orders are refused for manual association', async () => {
    expect(await associateDocument(w.ctxOf(w.logi, w.acc), w.admin, docs.none, orders.foreign)).toMatchObject({ ok: false, status: 404 })
    expect(await associateDocument(w.ctxOf(w.foreign, w.accForeign), w.admin, docs.none, orders.foreign)).toMatchObject({ ok: false, status: 404 }) // not their document
    expect(await associateDocument(w.ctxOf(w.logi, w.acc), w.admin, docs.none, orders.locked)).toMatchObject({ ok: false, status: 409, error: 'order_locked' })
    for (const actor of [w.comm, w.viewer]) expect(await associateDocument(w.ctxOf(actor, w.acc), w.admin, docs.none, orders.one)).toMatchObject({ ok: false, status: 404 })
    expect(await row('none')).toMatchObject({ association: 'pending', order_id: null })
    expect(await processBulkDocument(w.ctxOf(w.foreign, w.accForeign), w.admin, { provider }, docs.none)).toMatchObject({ ok: false, status: 404 })
  })

  it('two operators processing the SAME document at once: ONE provider call', async () => {
    await bulkUpload('par')
    const results = await Promise.all([process('par', w.logi), process('par', w.logi2)])
    expect(calls.par).toBe(1)
    expect(results.filter((r) => r.ok && r.body.outcome === 'associated')).toHaveLength(1)
    expect(results.find((r) => !r.ok || r.body.outcome !== 'associated')).toMatchObject({ ok: false, status: 409, error: 'in_progress' })
    expect(await row('par')).toMatchObject({ association: 'auto', order_id: orders.par })
  })

  it('audit of an automatic association: who, how and which SIGNAL NAMES — never the values', async () => {
    const { data } = await w.admin.from('order_logistics_events').select('event_type, detail, actor_name, outcome, error_code').eq('document_id', docs.safe).order('created_at')
    const events = (data ?? []) as Array<{ event_type: string; detail: Record<string, unknown>; actor_name: string; outcome: string; error_code: string | null }>
    expect(events.map((e) => e.event_type)).toEqual(['voucher_uploaded', 'ocr_started', 'ocr_completed', 'voucher_associated', 'voucher_validated'])
    expect(events.find((e) => e.event_type === 'voucher_associated')?.detail).toEqual({ method: 'auto', signals: ['dni', 'phone'], reassigned: false })
    expect(events.every((e) => e.actor_name !== 'unknown')).toBe(true)
    expect(JSON.stringify(events)).not.toMatch(/10000001|51910000001/)
    const failed = await w.admin.from('order_logistics_events').select('error_code, outcome').eq('document_id', docs.broken).eq('event_type', 'ocr_failed')
    expect(failed.data).toEqual([{ error_code: 'ocr_provider_error', outcome: 'error' }, { error_code: 'ocr_provider_error', outcome: 'error' }])
  })
})
