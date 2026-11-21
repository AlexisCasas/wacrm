import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

type Snapshot = Record<string, unknown>

const script = resolve(process.cwd(), 'scripts/qa/order-sync/reconcile.cjs')
const base = (id: string, over: Snapshot = {}): Snapshot => ({
  canonical_order_id: id,
  customer: { has_name: true, has_phone: true, has_dni: false, has_destination: true },
  product_key: 'producto',
  total: 100,
  paid: 0,
  balance: 100,
  vouchers: [],
  packing_completed: false,
  shipment: null,
  messages: {},
  ...over,
})
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

function run(w: Snapshot[], i: Snapshot[]) {
  const dir = mkdtempSync(join(tmpdir(), 'sync-reconcile-'))
  const wf = join(dir, 'w.json')
  const inf = join(dir, 'i.json')
  const out = join(dir, 'out.json')
  writeFileSync(wf, JSON.stringify(w))
  writeFileSync(inf, JSON.stringify(i))
  execFileSync(process.execPath, [script, '--wacrm', wf, '--inkaclick', inf, '--out', out], {
    env: { ...process.env, SYNC_RECONCILE_READ_ONLY: '1' },
  })
  return JSON.parse(readFileSync(out, 'utf8')) as {
    counts: Record<string, number>
    orders: Array<{ canonical_order_id: string | null; status: string; domains: Record<string, string> }>
    duplicate_vouchers: { inkaclick: { groups: number } }
  }
}

describe('SYNC-00/01 read-only reconciler', () => {
  it('MATCH: equal snapshots', () => {
    expect(run([base(A)], [base(A, { source: 'wacrm' })]).orders[0].status).toBe('MATCH')
  })

  it('WACRM_AHEAD: a voucher exists only in WACRM', () => {
    const r = run([base(A, { vouchers: [{ shalom_number: '10', shalom_code: 'AA' }] })], [base(A, { source: 'wacrm' })])
    expect(r.orders[0]).toMatchObject({ status: 'WACRM_AHEAD', domains: { voucher: 'WACRM_AHEAD' } })
  })

  it('INKACLICK_AHEAD: legacy initial payment exists only in InkaClick', () => {
    const r = run([base(A)], [base(A, { source: 'wacrm', paid: 30, balance: 70 })])
    expect(r.orders[0]).toMatchObject({ status: 'INKACLICK_AHEAD', domains: { payments: 'INKACLICK_AHEAD', balance: 'INKACLICK_AHEAD' } })
  })

  it('CONFLICT: totals disagree', () => {
    const r = run([base(A)], [base(A, { source: 'wacrm', total: 120, balance: 120 })])
    expect(r.orders[0]).toMatchObject({ status: 'CONFLICT', domains: { total: 'CONFLICT' } })
  })

  it('MISSING: canonical orders missing from either side', () => {
    const r = run([base(A)], [base(B, { source: 'wacrm' })])
    expect(r.counts.MISSING_IN_INKACLICK).toBe(1)
    expect(r.counts.MISSING_IN_WACRM).toBe(1)
  })

  it('LEGACY: InkaClick orders without a WACRM canonical id stay out of canonical mapping', () => {
    const r = run([], [{ legacy_inkaclick_id: 'legacy-1', source: 'manychat' }])
    expect(r.counts.LEGACY).toBe(1)
    expect(r.counts.canonical_orders).toBe(0)
  })

  it('detects duplicate voucher rows without mutating or collapsing source data', () => {
    const voucher = { shalom_number: '104873189', shalom_code: 'D3K9' }
    const r = run([base(A)], [base(A, { source: 'wacrm', vouchers: [voucher, voucher] })])
    expect(r.duplicate_vouchers.inkaclick.groups).toBe(1)
  })

  it('reports payment divergence per domain', () => {
    const r = run([base(A)], [base(A, { source: 'wacrm', paid: 30, balance: 70 })])
    expect(r.orders[0].domains.payments).toBe('INKACLICK_AHEAD')
  })

  it('refuses to run unless read-only mode is explicit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-reconcile-'))
    const wf = join(dir, 'w.json')
    const inf = join(dir, 'i.json')
    writeFileSync(wf, '[]')
    writeFileSync(inf, '[]')
    expect(() =>
      execFileSync(process.execPath, [script, '--wacrm', wf, '--inkaclick', inf], {
        env: { ...process.env, SYNC_RECONCILE_READ_ONLY: '' },
        stdio: 'pipe',
      }),
    ).toThrow()
  })
})
