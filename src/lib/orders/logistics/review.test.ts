import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'

import { getDocumentDetail, reviewDocument, sanitizeReviewedData } from '@/lib/orders/logistics/review'
import { getOrderPanel } from '@/lib/orders/logistics/panel'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const USER = '99999999-9999-4999-8999-999999999999'
const DOC = '33333333-3333-4333-8333-333333333333'
const ORDER = '22222222-2222-4222-8222-222222222222'
const ctx = { userId: USER, accountId: ACCOUNT }

describe('sanitizeReviewedData', () => {
  it('keeps a flat object of short strings, trims, stringifies numbers, drops empty values', () => {
    expect(sanitizeReviewedData({ dni: ' 12345678 ', amount: 10.5, note: '', skip: null })).toEqual({ dni: '12345678', amount: '10.5' })
  })

  it.each([
    ['an array', ['a']],
    ['a string', 'x'],
    ['a bad key', { 'Bad Key': 'a' }],
    ['a nested value', { a: { b: 1 } }],
    ['a too long value', { a: 'x'.repeat(201) }],
    ['too many fields', Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`f${i}`, 'v']))],
  ])('refuses %s (never coerced silently)', (_name, value) => {
    expect(sanitizeReviewedData(value)).toBeNull()
  })
})

function adminWith(rpc: { data?: unknown; error?: { code: string; message: string } }, view: Record<string, unknown> | null = { id: DOC, status: 'validated', version: 1 }) {
  const calls: Array<Record<string, unknown>> = []
  const admin = {
    rpc: async (_name: string, args: Record<string, unknown>) => (calls.push(args), { data: rpc.data ?? null, error: rpc.error ?? null }),
    from: () => {
      const b: Record<string, unknown> = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: view, error: null }) }
      return b
    },
  } as unknown as SupabaseClient
  return { admin, calls }
}

describe('reviewDocument', () => {
  it('validates input before touching the database', async () => {
    const f = adminWith({})
    expect(await reviewDocument(ctx, f.admin, 'nope', { action: 'validate' })).toMatchObject({ ok: false, status: 400, error: 'invalid_document_id' })
    expect(await reviewDocument(ctx, f.admin, DOC, { action: 'approve' })).toMatchObject({ ok: false, status: 400, error: 'invalid_action' })
    expect(await reviewDocument(ctx, f.admin, DOC, { action: 'validate', expectedRowVersion: 0 })).toMatchObject({ ok: false, status: 400, error: 'invalid_row_version' })
    expect(await reviewDocument(ctx, f.admin, DOC, { action: 'correct', reviewedData: ['x'] })).toMatchObject({ ok: false, status: 400, error: 'invalid_reviewed_data' })
    expect(f.calls).toHaveLength(0)
  })

  it('passes the SESSION actor / account and the sanitized data to the RPC', async () => {
    const f = adminWith({ data: { ok: true, changed: true, status: 'validated', version: 1 } })
    const r = await reviewDocument(ctx, f.admin, DOC, { action: 'validate', expectedRowVersion: 3, reviewedData: { dni: ' 1 ' } })
    expect(r).toMatchObject({ ok: true, status: 200, body: { changed: true, status: 'validated', version: 1 } })
    expect(f.calls[0]).toMatchObject({ p_account: ACCOUNT, p_actor: USER, p_doc: DOC, p_action: 'validate', p_expected_row_version: 3, p_reviewed_data: { dni: '1' } })
  })

  it.each([
    ['frozen', 409],
    ['stale', 409],
    ['association_required', 409],
    ['order_locked', 409],
    ['reviewed_data_required', 422],
    ['not_a_voucher', 400],
  ])('database refusal %s -> HTTP %i', async (reason, status) => {
    const f = adminWith({ data: { ok: false, reason, row_version: 5 } })
    const r = await reviewDocument(ctx, f.admin, DOC, { action: 'validate' })
    expect(r).toMatchObject({ ok: false, status, error: reason })
  })

  it('forbidden by the database (other account / not logistics) -> 404; flag off -> 403', async () => {
    expect(await reviewDocument(ctx, adminWith({ error: { code: '42501', message: 'forbidden' } }).admin, DOC, { action: 'reject' })).toMatchObject({ ok: false, status: 404 })
    expect(await reviewDocument(ctx, adminWith({ error: { code: '42501', message: 'feature_disabled' } }).admin, DOC, { action: 'reject' })).toMatchObject({ ok: false, status: 403 })
  })
})

describe('getDocumentDetail', () => {
  function callerWith(tables: Record<string, unknown>) {
    return {
      supabase: {
        from: (table: string) => {
          const b: Record<string, unknown> = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: tables[table] ?? null, error: null }) }
          return b
        },
      } as unknown as SupabaseClient,
      userId: USER,
      accountId: ACCOUNT,
      role: 'agent' as const,
    }
  }
  const row = (over: Record<string, unknown> = {}) => ({
    id: DOC,
    order_id: ORDER,
    status: 'pending_review',
    ocr_provider: 'fake',
    reviewed_at: null,
    ocr_result: { fields: { dni: { value: '12345678', confidence: 0.9 }, phone: { value: '900000001', confidence: 0.4 } } },
    reviewed_data: null,
    ...over,
  })
  const order = { customer_name: 'Juan Perez', dni: '12345678', phone: '51900000001', price: '10.00' }

  it('compares the OCR against the order and never returns the order DNI / phone unmasked', async () => {
    const r = await getDocumentDetail(callerWith({ order_documents: row(), order_confirmations: order }), DOC)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.body.comparison.find((c) => c.field === 'dni')).toMatchObject({ status: 'match', order_value: '*****678' })
    expect(r.body.comparison.find((c) => c.field === 'phone')).toMatchObject({ status: 'match', order_value: '******001' })
    expect(JSON.stringify(r.body)).not.toContain('51900000001')
    expect(r.body.ocr?.fields.dni.confidence).toBe(0.9)
  })

  it('once a person corrected the data, the comparison uses what they accepted (the OCR stays untouched)', async () => {
    const r = await getDocumentDetail(callerWith({ order_documents: row({ reviewed_data: { dni: '87654321' } }), order_confirmations: order }), DOC)
    if (!r.ok) throw new Error('expected ok')
    expect(r.body.comparison.find((c) => c.field === 'dni')?.status).toBe('mismatch')
    expect(r.body.ocr?.fields.dni.value).toBe('12345678')
    expect(r.body.reviewed_data).toEqual({ dni: '87654321' })
  })

  it('a bulk voucher without an order has no comparison; an unknown / hidden document is a 404', async () => {
    const pending = await getDocumentDetail(callerWith({ order_documents: row({ order_id: null }) }), DOC)
    expect(pending.ok && pending.body.comparison).toEqual([])
    expect(await getDocumentDetail(callerWith({}), DOC)).toMatchObject({ ok: false, status: 404 })
    expect(await getDocumentDetail(callerWith({}), 'x')).toMatchObject({ ok: false, status: 400 })
  })
})

describe('getOrderPanel', () => {
  function panelCaller(opts: { order?: unknown; logistics?: unknown; allowed?: boolean }) {
    return {
      supabase: {
        from: (table: string) => {
          const b: Record<string, unknown> = {
            select: () => b,
            eq: () => b,
            order: () => b,
            limit: async () => ({ data: [], error: null }),
            maybeSingle: async () => ({ data: table === 'order_confirmations' ? (opts.order ?? null) : (opts.logistics ?? null), error: null }),
            then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }),
          }
          return b
        },
        rpc: async () => ({ data: opts.allowed ?? true, error: null }),
      } as unknown as SupabaseClient,
      userId: USER,
      accountId: ACCOUNT,
      role: 'agent' as const,
    }
  }
  const orderRow = { id: ORDER, confirmed_at: '2026-11-17T10:00:00Z', customer_name: 'Juan', product: 'Prod', quantity: 1, price: '10.00', seller_name: 'S', order_status: 'Pedido confirmado', delivery_status: 'held', agency: 'Shalom', destination: 'Lima', department: null, conversation_id: null }

  it('NO row in order_logistics means pending_voucher (no backfill)', async () => {
    const r = await getOrderPanel(panelCaller({ order: orderRow }), ORDER)
    expect(r).toMatchObject({ ok: true, body: { logistics: { status: 'pending_voucher', version: 0 }, vouchers: [], events: [], order: { id: ORDER, total: 10, is_multiproduct: false } } })
  })

  it('shows the stored status when the row exists', async () => {
    const r = await getOrderPanel(panelCaller({ order: orderRow, logistics: { status: 'packing', version: 3 } }), ORDER)
    expect(r.ok && r.body.logistics.status).toBe('packing')
  })

  it('a caller the database does not recognise as logistics / supervisor (e.g. commercial) gets exactly the 404 of a non-existent order', async () => {
    expect(await getOrderPanel(panelCaller({ order: orderRow, allowed: false }), ORDER)).toMatchObject({ ok: false, status: 404, error: 'not_found' })
  })

  it('an order of another account / hidden by RLS is a plain 404; a bad id is a 400', async () => {
    expect(await getOrderPanel(panelCaller({}), ORDER)).toMatchObject({ ok: false, status: 404 })
    expect(await getOrderPanel(panelCaller({}), 'x')).toMatchObject({ ok: false, status: 400 })
  })
})
