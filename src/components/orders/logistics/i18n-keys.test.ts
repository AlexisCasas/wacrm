import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// Every text the PR-04 UI can show must exist in BOTH catalogues, with the same shape: a missing key renders as a raw key path in the page. The keys
// are derived from the code that produces them (components, services and the database CHECK lists), so a new code without a translation fails here.

const root = process.cwd()
const catalogue = (locale: string) => JSON.parse(readFileSync(join(root, 'messages', `${locale}.json`), 'utf8')).OrderLogistics as Record<string, unknown>
const es = catalogue('es')
const en = catalogue('en')

const leaves = (node: unknown, prefix = ''): string[] =>
  node && typeof node === 'object' ? Object.entries(node).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k)) : [prefix]
const has = (cat: Record<string, unknown>, path: string) => path.split('.').reduce<unknown>((n, k) => (n && typeof n === 'object' ? (n as Record<string, unknown>)[k] : undefined), cat) !== undefined
const group = (cat: Record<string, unknown>, name: string) => Object.keys((cat[name] ?? {}) as object)

const read = (path: string) => readFileSync(join(root, path), 'utf8')
const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]))

describe('OrderLogistics catalogue', () => {
  it('es and en have exactly the same keys', () => {
    expect(leaves(en).sort()).toEqual(leaves(es).sort())
  })

  it('no translation is empty', () => {
    for (const cat of [es, en]) for (const key of leaves(cat)) expect(String(key.split('.').reduce<unknown>((n, k) => (n as Record<string, unknown>)[k], cat)).trim(), key).not.toBe('')
  })

  it('every static key used by the components exists', () => {
    const files = walk('src/components/orders/logistics').filter((f) => f.endsWith('.tsx'))
    const used = new Set<string>()
    for (const file of files) {
      for (const m of read(file).matchAll(/\bt(?:\.has)?\(\s*"([A-Za-z0-9_.]+)"/g)) used.add(m[1])
    }
    // keys chosen through a ternary / a lookup table
    for (const k of ['confirmSentAsk', 'confirmNotSentAsk', 'fieldDni', 'fieldPhone', 'fieldName', 'fieldAmount']) used.add(k)
    expect(used.size).toBeGreaterThan(60)
    for (const key of used) {
      expect(has(es, key), `es: ${key}`).toBe(true)
      expect(has(en, key), `en: ${key}`).toBe(true)
    }
  })

  it('the four visible logistic states are exactly the approved ones, and only those', () => {
    expect(group(es, 'status')).toEqual(['pending_voucher', 'voucher_validated', 'packing', 'ready_for_dispatch'])
    expect(group(en, 'status')).toEqual(['pending_voucher', 'voucher_validated', 'packing', 'ready_for_dispatch'])
    expect((es.status as Record<string, string>).pending_voucher).toBe('Pendiente voucher')
    expect((es.status as Record<string, string>).voucher_validated).toBe('Voucher validado')
    expect((es.status as Record<string, string>).packing).toBe('Embalaje en proceso')
    expect((es.status as Record<string, string>).ready_for_dispatch).toBe('Listo para despacho')
  })

  it('every audit event type of the database has a label', () => {
    const migration = read('supabase/migrations/20261204000003_order_logistics_model.sql')
    const list = migration.slice(migration.indexOf('order_logistics_events_type_check'), migration.indexOf('order_logistics_events_outcome_check'))
    const types = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    expect(types.length).toBe(17)
    for (const type of types) expect(has(es, `event.${type}`), type).toBe(true)
  })

  it('every status the API can return (documents, associations, comparisons, indicators, bulk reasons) has a label', () => {
    for (const k of ['pending_review', 'validated', 'rejected', 'superseded', 'active']) expect(has(es, `docStatus.${k}`), k).toBe(true)
    for (const k of ['direct', 'auto', 'manual', 'pending']) expect(has(es, `association.${k}`), k).toBe(true)
    for (const k of ['match', 'mismatch', 'missing', 'not_comparable']) expect(has(es, `cmp.${k}`), k).toBe(true)
    for (const k of ['ambiguous', 'insufficient_signals', 'no_candidates', 'no_signals', 'low_confidence', 'ocr_failed', 'association_refused']) expect(has(es, `reason.${k}`), k).toBe(true)
  })

  it('every error code the services can answer has a friendly message', () => {
    const codes = new Set<string>()
    for (const file of ['documents', 'bulk', 'evidence', 'packaging', 'review', 'panel', 'access'].map((n) => `src/lib/orders/logistics/${n}.ts`)) {
      const source = read(file)
      for (const m of source.matchAll(/\bfail\(\s*\d{3}\s*,\s*'([a-z_]+)'/g)) codes.add(m[1])
      for (const m of source.matchAll(/\berror:\s*'([a-z_]+)'/g)) codes.add(m[1])
    }
    for (const file of ['src/lib/orders/logistics/access.ts', 'src/app/api/orders/logistics/documents/route.ts']) for (const m of read(file).matchAll(/error:\s*'([a-z_]+)'/g)) codes.add(m[1])
    // reasons the database answers (mapped to 409 by the services) and the typed send outcomes
    for (const c of ['frozen', 'stale', 'association_required', 'reviewed_data_required', 'order_locked', 'in_progress', 'uncertain', 'dispatch_open', 'not_packing', 'evidence_required', 'already_ready', 'direct_locked', 'not_pending', 'voucher_required', 'not_uncertain', 'send_failed', 'send_uncertain', 'dispatch_record_failed']) codes.add(c)
    // codes that only guard against a malformed request: the UI cannot produce them, the generic message covers them
    const internalOnly = new Set(['invalid_body', 'invalid_form', 'file_required', 'invalid_ids', 'invalid_action', 'invalid_row_version', 'invalid_document_id', 'invalid_order_id', 'invalid_batch_id', 'invalid_message_id', 'invalid_dispatch_id', 'invalid_resolution', 'invalid_kind', 'invalid_status', 'invalid_association', 'rejected', 'not_a_voucher', 'invalid_request'])
    const missing = [...codes].filter((c) => !internalOnly.has(c) && !has(es, `err.${c}`))
    expect(missing).toEqual([])
  })
})
