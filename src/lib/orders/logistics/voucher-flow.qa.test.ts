// @vitest-environment node
/**
 * PR-04 · END-TO-END of the voucher flow against the REAL local Supabase (PostgREST + RLS + RPCs + private Storage), with the OCR provider
 * replaced by the fake / not-configured ones (no real provider exists yet). Skipped unless LOCAL_URL is set. LOCAL ONLY (see test-support/qa-env).
 *
 *   eval "$(npx supabase status -o env | sed 's/^/export /')"; LOCAL_URL=$API_URL LOCAL_ANON=$ANON_KEY LOCAL_SERVICE=$SERVICE_ROLE_KEY npx vitest run src/lib/orders/logistics/voucher-flow.qa.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { uploadVoucher } from '@/lib/orders/logistics/documents'
import { getOrderPanel } from '@/lib/orders/logistics/panel'
import { createFakeProvider, notConfiguredProvider } from '@/lib/orders/logistics/ocr/providers'
import { runDocumentOcr } from '@/lib/orders/logistics/ocr/run'
import { getDocumentDetail, reviewDocument } from '@/lib/orders/logistics/review'
import { createWorld, pdfBytes, QA_ENABLED, type QaWorld } from '@/lib/orders/logistics/test-support/qa-env'
import type { VoucherOcrProvider } from '@/lib/orders/logistics/ocr/types'

let w: QaWorld
let n = 0
const key = (p: string) => `${w.tag}-${p}-${(n += 1)}`

async function upload(actor = w.logi, orderId: string | null, seed: string) {
  const r = await uploadVoucher(w.ctxOf(actor, w.acc), w.admin, { fileName: `${seed}.pdf`, bytes: pdfBytes(seed), orderId, batchId: null, requestKey: key(seed), allowDuplicate: false })
  if (!r.ok) throw new Error(`upload failed: ${r.status} ${r.error}`)
  const { data } = await w.admin.from('order_documents').select('storage_path').eq('id', r.body.document.id).single()
  w.track((data as { storage_path: string }).storage_path)
  return r.body.document.id
}
const ocr = (id: string, provider: VoucherOcrProvider, actor = w.logi, options = {}) => runDocumentOcr(w.ctxOf(actor, w.acc), w.admin, provider, id, options)
const review = (id: string, input: Parameters<typeof reviewDocument>[3], actor = w.logi) => reviewDocument(w.ctxOf(actor, w.acc), w.admin, id, input)
const panel = (orderId: string, actor = w.logi) => getOrderPanel(w.ctxOf(actor, w.acc), orderId)
const eventTypes = async (orderId: string) => {
  const r = await panel(orderId)
  if (!r.ok) throw new Error('panel failed')
  return r.body.events.map((e) => e.event_type).reverse()
}
const DATA = { dni: '12345678', phone: '51900000001', customer_name: 'Cliente Prueba', amount: '10.00' }

// These tests make many real round trips (PostgREST + Storage + RPC) against the local stack; under the load of the whole suite the 5 s default is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 })

describe.skipIf(!QA_ENABLED)('PR-04 voucher flow end to end (direct upload, OCR, review, validation)', () => {
  beforeAll(async () => {
    w = await createWorld()
  }, 90_000)
  afterAll(async () => {
    if (w) await w.dispose()
  }, 90_000)

  describe('A · from the order: upload -> OCR -> review -> correction -> validation', () => {
    let order = ''
    let doc = ''
    it('uploads on the open order (order_id already known, no matching) and the order is still pending_voucher (no row)', async () => {
      order = await w.mkOrder(w.acc, 'a')
      doc = await upload(w.logi, order, 'flow-a')
      const p = await panel(order)
      expect(p).toMatchObject({ ok: true, body: { logistics: { status: 'pending_voucher', version: 0 }, vouchers: [{ id: doc, association: 'direct', status: 'pending_review' }] } })
    })

    it('OCR (fake provider) stores a SUGGESTION: the document is NOT validated and the order does not move', async () => {
      const r = await ocr(doc, createFakeProvider())
      expect(r).toMatchObject({ ok: true, body: { attempt: 1, ocr_status: 'done', error_code: null } })
      const d = await getDocumentDetail(w.ctxOf(w.logi, w.acc), doc)
      expect(d.ok && d.body.document).toMatchObject({ status: 'pending_review', ocr_status: 'done', ocr_provider: 'fake' })
      expect(d.ok && d.body.ocr?.fields.dni).toEqual({ value: '12345678', confidence: 0.95 })
      expect((await panel(order)).ok && (await panel(order)).ok).toBe(true)
      const p = await panel(order)
      expect(p.ok && p.body.logistics.status).toBe('pending_voucher')
    })

    it('the review screen compares against the order (statuses; DNI / phone masked)', async () => {
      const d = await getDocumentDetail(w.ctxOf(w.logi, w.acc), doc)
      if (!d.ok) throw new Error('detail')
      expect(d.body.comparison.map((c) => `${c.field}:${c.status}`)).toEqual(['dni:match', 'phone:match', 'customer_name:match', 'amount:match'])
      expect(d.body.comparison.find((c) => c.field === 'dni')?.order_value).toBe('*****678')
      expect(JSON.stringify(d.body.comparison.map((c) => c.order_value))).not.toContain('51900000001') // the order's phone / DNI are never returned unmasked
    })

    it('a person corrects, then validates with the version they saw; who / when are recorded', async () => {
      const before = await getDocumentDetail(w.ctxOf(w.logi, w.acc), doc)
      if (!before.ok) throw new Error('detail')
      const corrected = await review(doc, { action: 'correct', reviewedData: { ...DATA, amount: '10.00', note: 'revisado' } })
      expect(corrected).toMatchObject({ ok: true, body: { changed: true, status: 'pending_review' } })
      const mid = await getDocumentDetail(w.ctxOf(w.logi, w.acc), doc)
      if (!mid.ok) throw new Error('detail')
      expect(mid.body.document.row_version).toBe(before.body.document.row_version + 1)
      // the OCR result is untouched by the correction
      expect(mid.body.ocr?.fields.dni.value).toBe('12345678')
      expect(mid.body.reviewed_data).toMatchObject({ note: 'revisado' })

      const validated = await review(doc, { action: 'validate', expectedRowVersion: mid.body.document.row_version })
      expect(validated).toMatchObject({ ok: true, body: { changed: true, status: 'validated', version: 1 } })
      const p = await panel(order)
      expect(p).toMatchObject({ ok: true, body: { logistics: { status: 'voucher_validated', voucher_document_id: doc } } })
    })

    it('audit trail: who / what / which order / result, with NO voucher content or PII', async () => {
      expect(await eventTypes(order)).toEqual(['voucher_uploaded', 'ocr_started', 'ocr_completed', 'voucher_corrected', 'voucher_validated'])
      const p = await panel(order)
      if (!p.ok) throw new Error('panel')
      expect(p.body.events.every((e) => e.actor_name !== 'unknown' && e.document_id === doc)).toBe(true)
      const blob = JSON.stringify(p.body.events)
      for (const secret of ['12345678', '51900000001', 'Cliente Prueba']) expect(blob).not.toContain(secret)
      expect(p.body.events.find((e) => e.event_type === 'voucher_corrected')?.detail).toEqual({ fields: ['amount', 'customer_name', 'dni', 'note', 'phone'] })
    })

    it('a validated voucher is frozen: no re-OCR, no correction, no rejection; validating again changes nothing', async () => {
      expect(await ocr(doc, createFakeProvider())).toMatchObject({ ok: false, status: 409, error: 'frozen' })
      expect(await review(doc, { action: 'correct', reviewedData: { dni: '1' } })).toMatchObject({ ok: false, status: 409, error: 'frozen' })
      expect(await review(doc, { action: 'reject' })).toMatchObject({ ok: false, status: 409, error: 'frozen' })
      expect(await review(doc, { action: 'validate' }, w.sup)).toMatchObject({ ok: true, body: { changed: false } })
      expect((await eventTypes(order)).filter((t) => t === 'voucher_validated')).toHaveLength(1)
    })

    it('a NEW legitimate version supersedes the old one (kept) and repoints the order', async () => {
      const doc2 = await upload(w.logi, order, 'flow-a-v2')
      expect(await review(doc2, { action: 'validate', reviewedData: { dni: '12345678' } })).toMatchObject({ ok: true, body: { changed: true, version: 2 } })
      const p = await panel(order)
      if (!p.ok) throw new Error('panel')
      expect(p.body.logistics).toMatchObject({ status: 'voucher_validated', voucher_document_id: doc2, version: 2 })
      expect(p.body.vouchers.map((v) => `${v.status}:v${v.version}`).sort()).toEqual(['superseded:v1', 'validated:v2'])
    })
  })

  describe('B · OCR failures, timeout, retry and abandoned attempts', () => {
    it('provider failure -> recorded; retry succeeds; timeout keeps the last result; an abandoned claim is retaken', async () => {
      const order = await w.mkOrder(w.acc, 'b')
      const doc = await upload(w.logi, order, 'flow-b')

      expect(await ocr(doc, createFakeProvider({ fail: 'ocr_provider_error' }))).toMatchObject({ ok: true, body: { attempt: 1, ocr_status: 'failed', error_code: 'ocr_provider_error' } })
      expect(await ocr(doc, createFakeProvider())).toMatchObject({ ok: true, body: { attempt: 2, ocr_status: 'done' } })
      expect(await ocr(doc, createFakeProvider({ hang: true }), w.logi, { timeoutMs: 80 })).toMatchObject({ ok: true, body: { attempt: 3, ocr_status: 'failed', error_code: 'ocr_timeout' } })
      const afterTimeout = await getDocumentDetail(w.ctxOf(w.logi, w.acc), doc)
      expect(afterTimeout.ok && afterTimeout.body.ocr?.fields.dni.value).toBe('12345678') // the last good suggestion is not silently lost

      // an attempt that was claimed and never finished (process died) blocks others only until the stale window
      const claim = await w.admin.rpc('begin_document_ocr', { p_account: w.acc, p_actor: w.logi.id, p_doc: doc })
      expect(claim.data).toMatchObject({ ok: true, attempt: 4 })
      expect(await ocr(doc, createFakeProvider())).toMatchObject({ ok: false, status: 409, error: 'in_progress' })
      await w.admin.from('order_documents').update({ ocr_claimed_at: new Date(Date.now() - 10 * 60_000).toISOString() }).eq('id', doc)
      expect(await ocr(doc, createFakeProvider())).toMatchObject({ ok: true, body: { attempt: 5, ocr_status: 'done' } })

      const events = (await panel(order)).ok ? await eventTypes(order) : []
      expect(events.filter((t) => t === 'ocr_started')).toHaveLength(5)
      expect(events.filter((t) => t === 'ocr_failed')).toHaveLength(2)
    })

    it('no provider configured: the attempt is recorded and the voucher can still be captured MANUALLY and validated', async () => {
      const order = await w.mkOrder(w.acc, 'c')
      const doc = await upload(w.logi, order, 'flow-c')
      expect(await ocr(doc, notConfiguredProvider)).toMatchObject({ ok: true, body: { ocr_status: 'failed', error_code: 'ocr_not_configured' } })
      expect(await review(doc, { action: 'validate' })).toMatchObject({ ok: false, status: 422, error: 'reviewed_data_required' })
      expect(await review(doc, { action: 'validate', reviewedData: { dni: '12345678', amount: '10.00' } })).toMatchObject({ ok: true, body: { status: 'validated' } })
      const p = await panel(order)
      expect(p.ok && p.body.logistics.status).toBe('voucher_validated')
      expect(p.ok && p.body.events.find((e) => e.event_type === 'ocr_failed')?.error_code).toBe('ocr_not_configured')
    })
  })

  describe('C · concurrency', () => {
    it('two parallel OCR attempts: ONE provider call, the other gets 409 in_progress', async () => {
      const order = await w.mkOrder(w.acc, 'd')
      const doc = await upload(w.logi, order, 'flow-d')
      let calls = 0
      const slow: VoucherOcrProvider = {
        name: 'slow',
        extract: async () => {
          calls += 1
          await new Promise((r) => setTimeout(r, 300))
          return { provider: 'slow', fields: { dni: { value: '12345678', confidence: 0.9 } } }
        },
      }
      const results = await Promise.all([ocr(doc, slow, w.logi), ocr(doc, slow, w.logi2)])
      expect(calls).toBe(1)
      expect(results.filter((r) => r.ok)).toHaveLength(1)
      expect(results.find((r) => !r.ok)).toMatchObject({ status: 409, error: 'in_progress' })
    })

    it('two operators validating the same voucher at once: one change, one idempotent no-op, one event', async () => {
      const order = await w.mkOrder(w.acc, 'e')
      const doc = await upload(w.logi, order, 'flow-e')
      await review(doc, { action: 'correct', reviewedData: { dni: '12345678' } })
      const results = await Promise.all([review(doc, { action: 'validate' }, w.logi), review(doc, { action: 'validate' }, w.logi2)])
      expect(results.every((r) => r.ok)).toBe(true)
      expect(results.filter((r) => r.ok && r.body.changed)).toHaveLength(1)
      expect((await eventTypes(order)).filter((t) => t === 'voucher_validated')).toHaveLength(1)
      const { count } = await w.admin.from('order_documents').select('id', { count: 'exact', head: true }).eq('order_id', order).eq('status', 'validated')
      expect(count).toBe(1)
    })

    it('a review made on a stale row_version (someone else corrected first) is refused', async () => {
      const order = await w.mkOrder(w.acc, 'f')
      const doc = await upload(w.logi, order, 'flow-f')
      const seen = await getDocumentDetail(w.ctxOf(w.logi, w.acc), doc)
      if (!seen.ok) throw new Error('detail')
      await review(doc, { action: 'correct', reviewedData: { dni: '12345678' } }, w.logi2) // the other operator changes it first
      expect(await review(doc, { action: 'validate', expectedRowVersion: seen.body.document.row_version })).toMatchObject({ ok: false, status: 409, error: 'stale' })
    })

    it('two documents of the same order validated at once leave exactly ONE validated voucher', async () => {
      const order = await w.mkOrder(w.acc, 'g')
      const a = await upload(w.logi, order, 'flow-g1')
      const b = await upload(w.logi2, order, 'flow-g2')
      const results = await Promise.all([review(a, { action: 'validate', reviewedData: { dni: '1' } }, w.logi), review(b, { action: 'validate', reviewedData: { dni: '2' } }, w.logi2)])
      expect(results.every((r) => r.ok)).toBe(true)
      const { data } = await w.admin.from('order_documents').select('status, version').eq('order_id', order)
      expect((data ?? []).filter((d) => d.status === 'validated')).toHaveLength(1)
      expect((data ?? []).map((d) => d.version).sort()).toEqual([1, 2])
    })
  })

  describe('D · packaging lock', () => {
    it('once packaging started, vouchers can no longer be uploaded or validated for that order', async () => {
      const order = await w.mkOrder(w.acc, 'h')
      const first = await upload(w.logi, order, 'flow-h1')
      const second = await upload(w.logi, order, 'flow-h2')
      expect(await review(first, { action: 'validate', reviewedData: { dni: '12345678' } })).toMatchObject({ ok: true })
      const start = await w.admin.rpc('start_order_packaging', { p_account: w.acc, p_actor: w.logi.id, p_order: order })
      expect(start.data).toMatchObject({ ok: true, changed: true, status: 'packing' })

      expect(await review(second, { action: 'validate', reviewedData: { dni: '12345678' } })).toMatchObject({ ok: false, status: 409, error: 'order_locked' })
      const folder = `account-${w.acc}/orders/${order}/vouchers`
      const before = (await w.admin.storage.from('order-docs').list(folder)).data?.length
      const late = await uploadVoucher(w.ctxOf(w.logi, w.acc), w.admin, { fileName: 'late.pdf', bytes: pdfBytes('late'), orderId: order, batchId: null, requestKey: key('late'), allowDuplicate: false })
      expect(late).toMatchObject({ ok: false, status: 409, error: 'order_locked' })
      expect((await w.admin.storage.from('order-docs').list(folder)).data?.length).toBe(before) // no orphan object
      const p = await panel(order)
      expect(p.ok && p.body.logistics.status).toBe('packing')
    })
  })

  describe('E · security of the review flow', () => {
    it('another account, commercial and a viewer can neither OCR, review nor read; flag OFF blocks everything', async () => {
      const order = await w.mkOrder(w.acc, 'i')
      const doc = await upload(w.logi, order, 'flow-i')

      const foreignCtx = w.ctxOf(w.foreign, w.accForeign)
      expect(await runDocumentOcr(foreignCtx, w.admin, createFakeProvider(), doc)).toMatchObject({ ok: false, status: 404 })
      expect(await reviewDocument(foreignCtx, w.admin, doc, { action: 'reject' })).toMatchObject({ ok: false, status: 404 })
      expect(await getDocumentDetail(foreignCtx, doc)).toMatchObject({ ok: false, status: 404 })
      expect(await getOrderPanel(foreignCtx, order)).toMatchObject({ ok: false, status: 404 })

      // the actor the backend would derive for these sessions is refused by the DATABASE itself
      for (const actor of [w.comm, w.viewer]) {
        expect(await runDocumentOcr(w.ctxOf(actor, w.acc), w.admin, createFakeProvider(), doc)).toMatchObject({ ok: false, status: 404 })
        expect(await reviewDocument(w.ctxOf(actor, w.acc), w.admin, doc, { action: 'reject' })).toMatchObject({ ok: false, status: 404 })
        expect(await getDocumentDetail(w.ctxOf(actor, w.acc), doc)).toMatchObject({ ok: false, status: 404 })
        expect(await getOrderPanel(w.ctxOf(actor, w.acc), order)).toMatchObject({ ok: false, status: 404 })
      }
      const { data: untouched } = await w.admin.from('order_documents').select('status, ocr_attempts').eq('id', doc).single()
      expect(untouched).toEqual({ status: 'pending_review', ocr_attempts: 0 })

      await w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: false }).eq('account_id', w.acc)
      try {
        expect(await reviewDocument(w.ctxOf(w.logi, w.acc), w.admin, doc, { action: 'reject' })).toMatchObject({ ok: false, status: 403, error: 'feature_disabled' })
        expect(await runDocumentOcr(w.ctxOf(w.logi, w.acc), w.admin, createFakeProvider(), doc)).toMatchObject({ ok: false, status: 403 })
        expect(await getOrderPanel(w.ctxOf(w.logi, w.acc), order)).toMatchObject({ ok: false, status: 404 })
        expect(await getDocumentDetail(w.ctxOf(w.logi, w.acc), doc)).toMatchObject({ ok: false, status: 404 })
      } finally {
        await w.admin.from('order_integration_settings').update({ logistics_mvp_enabled: true }).eq('account_id', w.acc)
      }
    })
  })

  describe('F · multiproduct: one order, one voucher, one logistic row', () => {
    it('works on an order with N products without any per-item structure', async () => {
      const { data, error } = await w.admin.rpc('create_order_confirmation', {
        p_account: w.acc,
        p_contact: null,
        p_conversation: null,
        p_actor: w.comm.id,
        p_actor_name: 'Comercial QA',
        p_request_key: key('multi'),
        p_seller: w.comm.id,
        p_fields: {
          customer_name: 'Cliente Prueba',
          phone: '51900000001',
          product: '1 x A\n2 x B',
          quantity: '3',
          price: '20.00',
          destination: 'Lima',
          items: [
            { product_name: 'A', quantity: '1', unit_price: '10.00' },
            { product_name: 'B', quantity: '2', unit_price: '5.00' },
          ],
        },
      })
      expect(error).toBeNull()
      const order = (data as Array<{ order_id: string }>)[0].order_id
      const doc = await upload(w.logi, order, 'flow-multi')
      expect(await review(doc, { action: 'validate', reviewedData: { dni: '12345678' } })).toMatchObject({ ok: true })
      const p = await panel(order)
      if (!p.ok) throw new Error('panel')
      expect(p.body.order).toMatchObject({ is_multiproduct: true, quantity: 3, total: 20 })
      expect(p.body.order.lines).toHaveLength(2)
      expect(p.body.vouchers).toHaveLength(1)
      const { count } = await w.admin.from('order_logistics').select('order_id', { count: 'exact', head: true }).eq('order_id', order)
      expect(count).toBe(1)
    })
  })
})
