// @vitest-environment node
/** PR-06 · payment proofs (order_documents kind payment_proof in the private bucket) against the REAL local stack. LOCAL ONLY. */
import { randomBytes, randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createWorld, pdfBytes, QA_ENABLED, type QaWorld } from '@/lib/orders/logistics/test-support/qa-env'
import { paymentDocumentSignedUrl, uploadPaymentProof } from '@/lib/orders/payments/evidence'
import { enablePayments, paymentsOps, type Row } from '@/lib/orders/payments/test-support/payments-ops'

let w: QaWorld
let p: ReturnType<typeof paymentsOps>
vi.setConfig({ testTimeout: 40_000, hookTimeout: 120_000 })
const key = () => `pp-${randomUUID()}`
const jpeg = (seed: string) => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(`${seed}-${randomBytes(6).toString('hex')}`), 0xff, 0xd9])
const tracked = (actor = w.logi, acc = w.acc) => ({ userId: actor.id, accountId: acc })
const objects: string[] = []

describe.skipIf(!QA_ENABLED)('PR-06 payment proof (evidence)', () => {
  beforeAll(async () => {
    w = await createWorld()
    p = paymentsOps(w)
    await enablePayments(w, w.acc)
  }, 120_000)
  afterAll(async () => {
    if (w) {
      if (objects.length) await w.admin.storage.from('order-docs').remove(objects)
      await w.dispose()
    }
  }, 90_000)

  it('uploads a proof: private bucket path account/order scoped, kind payment_proof, active; the same request_key / same file is ONE proof and leaves no duplicate object', async () => {
    const { order } = await p.order('proof', 100)
    const bytes = pdfBytes('proof-1')
    const k = key()
    const first = await uploadPaymentProof(tracked(), w.admin, order, { fileName: 'yape.pdf', bytes, requestKey: k })
    expect(first).toMatchObject({ ok: true, status: 201, body: { created: true } })
    const id = first.ok ? first.body.proof.id : ''
    const row = (await w.admin.from('order_documents').select('*').eq('id', id).single()).data as Row
    objects.push(row.storage_path)
    expect(row).toMatchObject({ kind: 'payment_proof', status: 'active', association: 'direct', source: 'upload', order_id: order, account_id: w.acc, storage_bucket: 'order-docs', version: null })
    expect(row.storage_path.startsWith(`account-${w.acc}/orders/${order}/payment-proofs/`)).toBe(true)
    expect((await uploadPaymentProof(tracked(), w.admin, order, { fileName: 'yape.pdf', bytes, requestKey: k })).ok && true).toBe(true) // replay of the same request
    const same = await uploadPaymentProof(tracked(), w.admin, order, { fileName: 'otro-nombre.pdf', bytes, requestKey: key() }) // same file, another key
    expect(same).toMatchObject({ ok: true, status: 200, body: { created: false } })
    expect(same.ok && same.body.proof.id).toBe(id)
    expect((await w.admin.from('order_documents').select('id').eq('order_id', order).eq('kind', 'payment_proof')).data).toHaveLength(1)
    const { data: listed } = await w.admin.storage.from('order-docs').list(`account-${w.acc}/orders/${order}/payment-proofs`)
    expect(listed).toHaveLength(1) // the duplicate upload was dropped
    expect(await uploadPaymentProof(tracked(), w.admin, order, { fileName: 'x.pdf', bytes: pdfBytes('different'), requestKey: k })).toMatchObject({ ok: false, status: 409, error: 'request_key_conflict' })
  })

  it('validations: empty, too large, bad extension, not a pdf/jpeg/png/webp, bad key; an unknown / other-account order is a 404; an untracked order is refused (and nothing is left stored)', async () => {
    const { order } = await p.order('proof-val', 100)
    expect(await uploadPaymentProof(tracked(), w.admin, order, { fileName: 'a.pdf', bytes: new Uint8Array(), requestKey: key() })).toMatchObject({ ok: false, error: 'empty_file' })
    expect(await uploadPaymentProof(tracked(), w.admin, order, { fileName: 'a.pdf', bytes: new Uint8Array(8 * 1024 * 1024 + 1), requestKey: key() })).toMatchObject({ ok: false, status: 413 })
    expect(await uploadPaymentProof(tracked(), w.admin, order, { fileName: 'virus.exe', bytes: pdfBytes('e'), requestKey: key() })).toMatchObject({ ok: false, status: 415, error: 'unsupported_extension' })
    expect(await uploadPaymentProof(tracked(), w.admin, order, { fileName: 'a.pdf', bytes: new TextEncoder().encode('MZ not an image'), requestKey: key() })).toMatchObject({ ok: false, status: 415 })
    expect(await uploadPaymentProof(tracked(), w.admin, order, { fileName: 'a.pdf', bytes: pdfBytes('k'), requestKey: 'bad key!' })).toMatchObject({ ok: false, error: 'invalid_request_key' })
    expect(await uploadPaymentProof(tracked(), w.admin, randomUUID(), { fileName: 'a.pdf', bytes: pdfBytes('n'), requestKey: key() })).toMatchObject({ ok: false, status: 404 })
    expect(await uploadPaymentProof(tracked(w.foreign, w.accForeign), w.admin, order, { fileName: 'a.pdf', bytes: pdfBytes('x'), requestKey: key() })).toMatchObject({ ok: false, status: 404 }) // not their order
    const historic = await w.mkOrder(w.acc, `hist-${randomUUID()}`, { price: 10 })
    await w.admin.from('order_financials').delete().eq('order_id', historic)
    const r = await uploadPaymentProof(tracked(), w.admin, historic, { fileName: 'a.pdf', bytes: pdfBytes('h'), requestKey: key() })
    expect(r).toMatchObject({ ok: false, status: 409, error: 'not_tracked' })
    const { data: left } = await w.admin.storage.from('order-docs').list(`account-${w.acc}/orders/${historic}/payment-proofs`)
    expect(left ?? []).toHaveLength(0)
  })

  it('who may upload: Commercial, viewer and the flag OFF are refused by the database (404, indistinguishable from "not found"; the route answers 403); the RPC is service-role only', async () => {
    const { order } = await p.order('proof-auth', 100)
    for (const actor of [w.comm, w.viewer]) {
      expect(await uploadPaymentProof(tracked(actor), w.admin, order, { fileName: 'a.pdf', bytes: pdfBytes('c'), requestKey: key() })).toMatchObject({ ok: false })
    }
    await enablePayments(w, w.acc, false, null)
    try {
      expect(await uploadPaymentProof(tracked(), w.admin, order, { fileName: 'a.pdf', bytes: pdfBytes('o'), requestKey: key() })).toMatchObject({ ok: false })
    } finally {
      await enablePayments(w, w.acc, true)
    }
    expect((await w.logi.client.rpc('register_payment_proof', {})).error).not.toBeNull()
  })

  it('a proof links to a payment; a payment proof is never a voucher (PR-04 refuses it) and never creates a payment', async () => {
    const { order } = await p.order('proof-link', 100)
    const up = await uploadPaymentProof(tracked(), w.admin, order, { fileName: 'pago.jpg', bytes: jpeg('p'), requestKey: key() })
    const docId = up.ok ? up.body.proof.id : ''
    objects.push(((await w.admin.from('order_documents').select('storage_path').eq('id', docId).single()).data as Row).storage_path)
    expect(await p.payments(order)).toEqual([]) // a file alone is not money
    const r = await p.register(order, { p_evidence: docId, p_amount: '40.00' })
    expect(r.data).toMatchObject({ ok: true })
    expect((await p.register(order, { p_evidence: docId, p_amount: '10.00' })).data).toMatchObject({ ok: false, reason: 'duplicate_evidence' })
    await p.confirm((r.data as { payment_id: string }).payment_id)
    expect((await p.financials(order))?.paid_confirmed).toBe(40)
    // PR-04 refuses to treat it as a voucher / to review it / to run OCR on it
    expect((await w.admin.rpc('review_order_document', { p_account: w.acc, p_actor: w.logi.id, p_doc: docId, p_action: 'validate', p_expected_row_version: null, p_reviewed_data: { amount: '1' } })).error ?? (await w.admin.rpc('review_order_document', { p_account: w.acc, p_actor: w.logi.id, p_doc: docId, p_action: 'validate', p_expected_row_version: null, p_reviewed_data: { amount: '1' } })).data).toBeTruthy()
    expect((await w.admin.from('order_documents').select('status').eq('id', docId).single()).data).toMatchObject({ status: 'active' })
    // another order's proof can not back this order's payment
    const other = await p.order('proof-other', 100)
    const up2 = await uploadPaymentProof(tracked(), w.admin, other.order, { fileName: 'x.jpg', bytes: jpeg('q'), requestKey: key() })
    objects.push(((await w.admin.from('order_documents').select('storage_path').eq('id', up2.ok ? up2.body.proof.id : '').single()).data as Row).storage_path)
    expect((await p.register(order, { p_evidence: up2.ok ? up2.body.proof.id : '', p_amount: '5.00' })).data).toMatchObject({ ok: false, reason: 'invalid_evidence' })
  })

  it('signed URLs: Logistica / Supervisor get a short-lived URL (no storage path); Comercial, viewer, other accounts and the flag OFF get a 404', async () => {
    const { order } = await p.order('proof-url', 100)
    const up = await uploadPaymentProof(tracked(), w.admin, order, { fileName: 'pago.pdf', bytes: pdfBytes('u'), requestKey: key() })
    const docId = up.ok ? up.body.proof.id : ''
    objects.push(((await w.admin.from('order_documents').select('storage_path').eq('id', docId).single()).data as Row).storage_path)
    for (const a of [w.logi, w.sup]) {
      const r = await paymentDocumentSignedUrl({ supabase: a.client, accountId: w.acc }, w.admin, docId)
      expect(r).toMatchObject({ ok: true, body: { expires_in: 120, mime_type: 'application/pdf' } })
      if (r.ok) {
        expect(Object.keys(r.body).sort()).toEqual(['expires_in', 'filename', 'mime_type', 'url']) // the storage path is not a field of the answer
        const res = await fetch(r.body.url)
        expect(res.status).toBe(200)
      }
    }
    for (const a of [w.comm, w.viewer]) expect(await paymentDocumentSignedUrl({ supabase: a.client, accountId: w.acc }, w.admin, docId)).toMatchObject({ ok: false, status: 404 })
    expect(await paymentDocumentSignedUrl({ supabase: w.foreign.client, accountId: w.accForeign }, w.admin, docId)).toMatchObject({ ok: false, status: 404 })
    expect(await paymentDocumentSignedUrl({ supabase: w.foreign.client, accountId: w.acc }, w.admin, docId)).toMatchObject({ ok: false, status: 404 })
    expect(await paymentDocumentSignedUrl({ supabase: w.logi.client, accountId: w.acc }, w.admin, 'not-a-uuid')).toMatchObject({ ok: false, status: 400 })
    // the bucket is private: no public URL exists
    expect((await fetch(`${process.env.LOCAL_URL}/storage/v1/object/public/order-docs/${(await w.admin.from('order_documents').select('storage_path').eq('id', docId).single()).data?.storage_path}`)).status).not.toBe(200)
    await enablePayments(w, w.acc, false, null)
    try {
      expect(await paymentDocumentSignedUrl({ supabase: w.logi.client, accountId: w.acc }, w.admin, docId)).toMatchObject({ ok: false, status: 404 })
    } finally {
      await enablePayments(w, w.acc, true)
    }
  })
})
