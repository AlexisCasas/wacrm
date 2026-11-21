import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'

import { normalizeOcrOutput, safeProviderName } from '@/lib/orders/logistics/ocr/normalize-result'
import { createFakeProvider, notConfiguredProvider, resolveOcrProvider } from '@/lib/orders/logistics/ocr/providers'
import { runDocumentOcr } from '@/lib/orders/logistics/ocr/run'
import { VoucherOcrError, type VoucherOcrProvider } from '@/lib/orders/logistics/ocr/types'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const USER = '99999999-9999-4999-8999-999999999999'
const DOC = '33333333-3333-4333-8333-333333333333'
const ctx = { userId: USER, accountId: ACCOUNT }
const PDF = new TextEncoder().encode('%PDF-1.7\nbytes')

describe('providers', () => {
  it('not_configured always fails with the typed code (the UI falls back to manual capture)', async () => {
    await expect(notConfiguredProvider.extract({ bytes: PDF, mimeType: 'application/pdf' })).rejects.toMatchObject({ code: 'ocr_not_configured' })
  })

  it('the fake provider is deterministic and can be scripted to fail or hang', async () => {
    const ok = await createFakeProvider().extract({ bytes: PDF, mimeType: 'application/pdf' })
    expect(ok.provider).toBe('fake')
    expect(Object.keys(ok.fields)).toEqual(['dni', 'phone', 'customer_name', 'amount'])
    await expect(createFakeProvider({ fail: 'ocr_rate_limited' }).extract({ bytes: PDF, mimeType: 'application/pdf' })).rejects.toMatchObject({ code: 'ocr_rate_limited' })
    const controller = new AbortController()
    const hung = createFakeProvider({ hang: true }).extract({ bytes: PDF, mimeType: 'application/pdf', signal: controller.signal })
    controller.abort()
    await expect(hung).rejects.toThrow('aborted')
  })

  it('resolve: not_configured by default; the fake one only outside production; no real provider is registered', () => {
    expect(resolveOcrProvider({}).name).toBe('not_configured')
    expect(resolveOcrProvider({ ORDER_OCR_PROVIDER: 'fake', NODE_ENV: 'development' }).name).toBe('fake')
    expect(resolveOcrProvider({ ORDER_OCR_PROVIDER: 'fake', NODE_ENV: 'production' }).name).toBe('not_configured')
    expect(resolveOcrProvider({ ORDER_OCR_PROVIDER: 'gemini', NODE_ENV: 'development' }).name).toBe('not_configured')
    expect(resolveOcrProvider({ ORDER_OCR_PROVIDER: 'openai', NODE_ENV: 'production' }).name).toBe('not_configured')
  })
})

describe('normalizeOcrOutput (provider output is untrusted)', () => {
  it('keeps clean fields, clamps confidence, trims and caps values, turns empty values into null', () => {
    const r = normalizeOcrOutput({
      provider: 'x',
      model: 'm-1',
      fields: {
        dni: { value: ' 12345678 ', confidence: 1.7 },
        phone: { value: '', confidence: -2 },
        amount: { value: 10 as unknown as string, confidence: 0.12345 },
        long: { value: 'x'.repeat(500), confidence: 0.5 },
      },
    })
    expect(r.model).toBe('m-1')
    expect(r.fields.dni).toEqual({ value: '12345678', confidence: 1 })
    expect(r.fields.phone).toEqual({ value: null, confidence: 0 })
    expect(r.fields.amount).toEqual({ value: '10', confidence: 0.123 })
    expect(r.fields.long.value).toHaveLength(200)
  })

  it('drops invalid field names and non-objects; nothing readable -> ocr_unreadable; garbage -> ocr_invalid_response', () => {
    const r = normalizeOcrOutput({ provider: 'x', fields: { 'Bad Name': { value: 'a', confidence: 1 }, ok_field: { value: 'a', confidence: 1 }, nul: null as never } })
    expect(Object.keys(r.fields)).toEqual(['ok_field'])
    expect(() => normalizeOcrOutput({ provider: 'x', fields: { 'Bad Name': { value: 'a', confidence: 1 } } })).toThrow(VoucherOcrError)
    expect(() => normalizeOcrOutput(null as never)).toThrow(/ocr_invalid_response/)
    expect(() => normalizeOcrOutput({ provider: 'x', fields: 'nope' as never })).toThrow(/ocr_invalid_response/)
  })

  it('caps the number of fields and sanitizes the provider name', () => {
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}`, { value: 'v', confidence: 1 }]))
    expect(Object.keys(normalizeOcrOutput({ provider: 'x', fields: many }).fields)).toHaveLength(30)
    expect(safeProviderName('fake')).toBe('fake')
    expect(safeProviderName('Bad Name!')).toBe('unknown')
  })
})

// ---- runDocumentOcr with a fake service client ----
interface Scenario {
  doc?: Record<string, unknown> | null
  begin?: unknown
  beginError?: { code: string; message: string }
  download?: 'ok' | 'error' | 'html'
  complete?: unknown
  completeError?: { code: string; message: string }
}
function fakeAdmin(s: Scenario) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const admin = {
    from: () => {
      const b: Record<string, unknown> = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: s.doc === undefined ? { id: DOC, storage_path: 'p', kind: 'voucher', status: 'pending_review' } : s.doc, error: null }) }
      return b
    },
    storage: {
      from: () => ({
        download: async () => {
          if (s.download === 'error') return { data: null, error: { message: 'x' } }
          const bytes = s.download === 'html' ? new TextEncoder().encode('<html>') : PDF
          return { data: new Blob([bytes as BlobPart]), error: null }
        },
      }),
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args })
      if (name === 'begin_document_ocr') return s.beginError ? { data: null, error: s.beginError } : { data: s.begin ?? { ok: true, attempt: 1 }, error: null }
      if (name === 'complete_document_ocr') return s.completeError ? { data: null, error: s.completeError } : { data: s.complete ?? { ok: true, attempt: 1 }, error: null }
      return { data: { ok: true }, error: null }
    },
  } as unknown as SupabaseClient
  return { admin, calls }
}
const names = (c: Array<{ name: string }>) => c.map((x) => x.name)
const run = (s: Scenario, provider: VoucherOcrProvider, opts = {}) => {
  const f = fakeAdmin(s)
  return runDocumentOcr(ctx, f.admin, provider, DOC, opts).then((r) => ({ r, calls: f.calls }))
}

describe('runDocumentOcr', () => {
  it('happy path: claim -> provider -> normalized result stored (never validated)', async () => {
    const { r, calls } = await run({}, createFakeProvider())
    expect(r).toMatchObject({ ok: true, status: 200, body: { attempt: 1, ocr_status: 'done', error_code: null } })
    expect(names(calls)).toEqual(['begin_document_ocr', 'complete_document_ocr'])
    const stored = calls[1].args.p_result as { fields: Record<string, unknown> }
    expect(Object.keys(stored.fields)).toContain('dni')
    expect(calls[1].args).toMatchObject({ p_account: ACCOUNT, p_actor: USER, p_attempt: 1, p_provider: 'fake' })
  })

  it('no provider configured -> the attempt is RECORDED as failed (ocr_not_configured); manual capture remains possible', async () => {
    const { r, calls } = await run({}, notConfiguredProvider)
    expect(r).toMatchObject({ ok: true, body: { ocr_status: 'failed', error_code: 'ocr_not_configured' } })
    expect(names(calls)).toEqual(['begin_document_ocr', 'fail_document_ocr'])
    expect(calls[1].args.p_error_code).toBe('ocr_not_configured')
  })

  it.each(['ocr_provider_error', 'ocr_rate_limited', 'ocr_unreadable', 'ocr_invalid_response'] as const)('provider failure %s is recorded with its typed code', async (code) => {
    const { r } = await run({}, createFakeProvider({ fail: code }))
    expect(r).toMatchObject({ ok: true, body: { ocr_status: 'failed', error_code: code } })
  })

  it('an unexpected provider exception becomes ocr_provider_error (its message is never stored)', async () => {
    const boom: VoucherOcrProvider = { name: 'boom', extract: async () => { throw new Error('SECRET api key sk-123 leaked in message') } }
    const { r, calls } = await run({}, boom)
    expect(r).toMatchObject({ ok: true, body: { ocr_status: 'failed', error_code: 'ocr_provider_error' } })
    expect(JSON.stringify(calls)).not.toContain('SECRET')
  })

  it('timeout: a hung provider is aborted and recorded as ocr_timeout', async () => {
    const { r } = await run({}, createFakeProvider({ hang: true }), { timeoutMs: 30 })
    expect(r).toMatchObject({ ok: true, body: { ocr_status: 'failed', error_code: 'ocr_timeout' } })
  })

  it('a provider answer with nothing usable -> ocr_unreadable; the stored file missing -> ocr_file_unavailable; a non-document file -> ocr_unreadable', async () => {
    const empty: VoucherOcrProvider = { name: 'e', extract: async () => ({ provider: 'e', fields: {} }) }
    expect((await run({}, empty)).r).toMatchObject({ body: { error_code: 'ocr_unreadable' } })
    expect((await run({ download: 'error' }, createFakeProvider())).r).toMatchObject({ body: { error_code: 'ocr_file_unavailable' } })
    expect((await run({ download: 'html' }, createFakeProvider())).r).toMatchObject({ body: { error_code: 'ocr_unreadable' } })
  })

  it('the database rejecting the stored result is recorded as ocr_invalid_response', async () => {
    const { r, calls } = await run({ completeError: { code: '22023', message: 'invalid_ocr_result' } }, createFakeProvider())
    expect(r).toMatchObject({ ok: true, body: { error_code: 'ocr_invalid_response' } })
    expect(names(calls)).toEqual(['begin_document_ocr', 'complete_document_ocr', 'fail_document_ocr'])
  })

  it('another attempt is running (double click / two operators) -> 409 in_progress, the provider is NOT called', async () => {
    let called = false
    const spy: VoucherOcrProvider = { name: 's', extract: async () => { called = true; return { provider: 's', fields: {} } } }
    const { r } = await run({ begin: { ok: false, reason: 'in_progress', attempt: 1 } }, spy)
    expect(r).toMatchObject({ ok: false, status: 409, error: 'in_progress' })
    expect(called).toBe(false)
  })

  it('a validated / rejected voucher is never re-processed (409 frozen, provider not called)', async () => {
    const { r } = await run({ begin: { ok: false, reason: 'frozen' } }, createFakeProvider())
    expect(r).toMatchObject({ ok: false, status: 409, error: 'frozen' })
  })

  it('unknown document / other account -> 404; forbidden by the database -> 404; invalid id -> 400', async () => {
    expect((await run({ doc: null }, createFakeProvider())).r).toMatchObject({ ok: false, status: 404 })
    expect((await run({ beginError: { code: '42501', message: 'forbidden' } }, createFakeProvider())).r).toMatchObject({ ok: false, status: 404 })
    const f = fakeAdmin({})
    expect(await runDocumentOcr(ctx, f.admin, createFakeProvider(), 'nope')).toMatchObject({ ok: false, status: 400 })
  })
})
