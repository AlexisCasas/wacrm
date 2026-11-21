import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'

import { getLogisticsSummary, MAX_SUMMARY_IDS } from '@/lib/orders/logistics/panel'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const A = '22222222-2222-4222-8222-222222222222'
const B = '33333333-3333-4333-8333-333333333333'
const C = '44444444-4444-4444-8444-444444444444'
const D = '55555555-5555-4555-8555-555555555555'

function caller(opts: { allowed?: boolean; logistics?: Array<{ order_id: string; status: string }>; pending?: Array<{ order_id: string }>; error?: boolean }) {
  const supabase = {
    rpc: async () => ({ data: opts.allowed ?? true, error: null }),
    from: (table: string) => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        in: async () => ({ data: table === 'order_logistics' ? (opts.logistics ?? []) : (opts.pending ?? []), error: opts.error ? { code: 'XX000' } : null }),
      }
      return b
    },
  } as unknown as SupabaseClient
  return { supabase, userId: 'u', accountId: ACCOUNT, role: 'agent' as const }
}

describe('getLogisticsSummary (list indicator)', () => {
  it('no row = pending_voucher; a validated voucher = validated; an uploaded one waiting = pending_review; anything past pending_voucher = validated', async () => {
    const r = await getLogisticsSummary(
      caller({ logistics: [{ order_id: A, status: 'voucher_validated' }, { order_id: D, status: 'ready_for_dispatch' }], pending: [{ order_id: B }] }),
      [A, B, C, D],
    )
    expect(r).toMatchObject({
      ok: true,
      body: {
        summary: {
          [A]: { status: 'voucher_validated', voucher: 'validated' },
          [B]: { status: 'pending_voucher', voucher: 'pending_review' },
          [C]: { status: 'pending_voucher', voucher: 'none' },
          [D]: { status: 'ready_for_dispatch', voucher: 'validated' },
        },
      },
    })
  })

  it('validates the ids: empty, duplicated-only, malformed and more than the ceiling are refused', async () => {
    expect(await getLogisticsSummary(caller({}), [])).toMatchObject({ ok: false, status: 400 })
    expect(await getLogisticsSummary(caller({}), ['nope'])).toMatchObject({ ok: false, status: 400 })
    const many = Array.from({ length: MAX_SUMMARY_IDS + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    expect(await getLogisticsSummary(caller({}), many)).toMatchObject({ ok: false, status: 400 })
    expect(await getLogisticsSummary(caller({}), [A, A])).toMatchObject({ ok: true, body: { summary: { [A]: { status: 'pending_voucher' } } } })
  })

  it('a caller the database does not recognise as logistics (commercial) gets the 404 of a non-existent resource, never data', async () => {
    expect(await getLogisticsSummary(caller({ allowed: false, logistics: [{ order_id: A, status: 'packing' }] }), [A])).toMatchObject({ ok: false, status: 404 })
  })

  it('a database error is a 500 without details', async () => {
    const r = await getLogisticsSummary(caller({ error: true }), [A])
    expect(r).toMatchObject({ ok: false, status: 500, error: 'internal_error' })
  })
})
