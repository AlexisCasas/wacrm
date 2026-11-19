// Test support for the PR-05 DB-level suites (real local stack): a tiny toolkit over the PR-05 RPCs with explicit clocks. Test code only.
import type { QaActor, QaWorld } from '@/lib/orders/logistics/test-support/qa-env'
import { mkReadyOrder } from '@/lib/orders/shalom/test-support/ready-order'

export const BASE = Date.parse('2026-12-01T15:00:00Z') // 10:00 in Lima
export const at = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString()
export const day = (d: number, hours = 0) => at(d * 1440 + hours * 60)

export interface Claimed {
  order_id: string
  account_id: string
  tracking_number: string
  tracking_code: string
  identifier_version: number
  claim_token: string
}

export function shalomOps(w: QaWorld) {
  let n = 0
  const ready = (label: string, acc = w.acc) => mkReadyOrder(w, acc, `pk-${label}-${(n += 1)}`)
  const register = (order: string, opts: { actor?: QaActor; acc?: string; now?: string } = {}) =>
    w.admin.rpc('register_order_shipment', { p_account: opts.acc ?? w.acc, p_actor: (opts.actor ?? w.logi).id, p_order: order, p_number: String(70_000_000 + (n += 1)), p_code: 'PK01', p_now: opts.now ?? at(0) })
  const claim = async (now: string, order: string | null = null): Promise<Claimed[]> => {
    const { data, error } = await w.admin.rpc('claim_shipment_polls', { p_limit: 20, p_lease_seconds: 600, p_order: order, p_now: now })
    if (error) throw error
    return data as Claimed[]
  }
  const apply = (c: Claimed, over: Record<string, unknown> = {}) =>
    w.admin.rpc('apply_shipment_poll', {
      p_account: c.account_id, p_order: c.order_id, p_claim_token: c.claim_token, p_identifier_version: c.identifier_version,
      p_started_at: at(1), p_finished_at: at(2), p_trigger: 'cron', p_outcome: 'ok', p_http_status: 200, p_latency_ms: 40, p_normalized: 'at_origin',
      p_raw_summary: { origen: true }, p_raw_hash: 'h-origin', p_destination_at: null, p_next_poll_at: at(180), p_attention: false, p_error_code: null, p_now: at(2), ...over,
    })
  /** A registered shipment brought to `status` by ONE applied answer at `finishedAt`. */
  async function shipAt(label: string, status: 'at_origin' | 'in_transit' | 'at_destination' | 'delivered', opts: { destinationAt?: string | null; finishedAt?: string; acc?: string; actor?: QaActor } = {}) {
    const acc = opts.acc ?? w.acc
    const order = await ready(label, acc)
    const reg = await register(order, { acc, actor: opts.actor })
    if ((reg.data as { ok?: boolean })?.ok !== true) throw new Error(`register failed: ${JSON.stringify(reg)}`)
    const [c] = (await claim(at(1), order))
    const done = await apply(c, { p_normalized: status, p_destination_at: opts.destinationAt ?? null, p_finished_at: opts.finishedAt ?? at(2), p_started_at: at(1), p_raw_hash: `h-${status}` })
    if ((done.data as { applied?: boolean })?.applied !== true) throw new Error(`apply failed: ${JSON.stringify(done)}`)
    return { order, c }
  }
  const shipment = async (order: string) => ((await w.admin.from('order_shipments').select('*').eq('order_id', order).single()).data ?? {}) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const events = async (order: string) =>
    ((await w.admin.from('order_shipment_events').select('event_type, from_status, to_status, source, detail').eq('order_id', order).order('created_at')).data ?? []) as Array<{ event_type: string; from_status: string | null; to_status: string | null; source: string; detail: Record<string, any> }> // eslint-disable-line @typescript-eslint/no-explicit-any
  const count = async (order: string, type: string) => (await events(order)).filter((e) => e.event_type === type).length
  return { ready, register, claim, apply, shipAt, shipment, events, count }
}
