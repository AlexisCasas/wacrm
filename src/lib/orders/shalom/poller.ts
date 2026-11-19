import type { SupabaseClient } from '@supabase/supabase-js'

import { classifyFailure, classifyResponse, errorKindOf, type Classified } from '@/lib/orders/shalom/classify'
import {
  attentionWindowElapsed, nextPollAfterFailure, nextPollAfterSuccess, rateLimitPauseSeconds, type ShalomConfig,
} from '@/lib/orders/shalom/config'
import { emptyMessageTick, processCustomerMessages, type MessageTickResult, type SendFn } from '@/lib/orders/shalom/customer-message'
import { ShalomProviderError, type PollOutcome, type ShalomTrackingProvider, type ShipmentStatus } from '@/lib/orders/shalom/types'

// PR-05 · the poller. It only ORCHESTRATES: the database owns the invariants (claim / lease / token, guide versions, late answers, never backwards, no
// duplicate events). Scheduling policy comes from config.ts. A Shalom failure can never throw out of here: every error becomes a recorded outcome.
// Logs are structured counters (ids and outcomes only): never a token, a credential or customer data.

export interface ClaimedShipment {
  order_id: string
  account_id: string
  tracking_number: string
  tracking_code: string
  identifier_version: number
  claim_token: string
  first_failure_at: string | null
  consecutive_failures: number
  logistic_status: ShipmentStatus | null
}

export interface PollDeps {
  provider: ShalomTrackingProvider
  cfg: ShalomConfig
  /** Injectable clock (tests / UAT accelerate it); defaults to the real one. */
  now?: () => Date
  /** Injectable pause (tests); defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
  /** Global kill switch: do the DB-only work (alert clock, pickup evaluation, retention) but make NO provider query, claim nothing and send NO customer message. */
  skipQueries?: boolean
  /** Injectable send core for the customer message (tests); defaults to the real one. */
  sendMessage?: SendFn
}

export type PauseReason = 'rate_limited' | 'credentials' | null

export interface PollResult {
  outcome: PollOutcome
  applied: boolean
  ignoredReason: string | null
  pause: PauseReason
  pauseSeconds: number
}

const clock = (deps: PollDeps) => (deps.now ? deps.now() : new Date())

/** One provider query with its own time budget. Never throws: a missing answer is a classified failure. */
export async function queryProvider(provider: ShalomTrackingProvider, row: Pick<ClaimedShipment, 'tracking_number' | 'tracking_code'>, timeoutMs: number): Promise<Classified> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await provider.fetchTracking({ numero: row.tracking_number, codigo: row.tracking_code, signal: controller.signal })
    return classifyResponse(response)
  } catch (error) {
    if (controller.signal.aborted) return classifyFailure('timeout')
    if (error instanceof ShalomProviderError) return classifyFailure(error.code)
    return classifyFailure('network')
  } finally {
    clearTimeout(timer)
  }
}

/** Queries ONE claimed shipment and applies the answer through the database. */
export async function pollClaimed(admin: SupabaseClient, row: ClaimedShipment, deps: PollDeps, trigger: 'cron' | 'manual'): Promise<PollResult> {
  const startedAt = clock(deps)
  const classified = await queryProvider(deps.provider, row, deps.cfg.timeoutMs)
  const finishedAt = clock(deps)
  const kind = errorKindOf(classified.outcome)

  let nextPoll: Date | null
  let attention = false
  let pause: PauseReason = null
  let pauseSeconds = 0
  if (classified.outcome === 'ok') {
    nextPoll = nextPollAfterSuccess(classified.normalized, finishedAt, deps.cfg)
  } else if (classified.outcome === 'unknown_state') {
    nextPoll = nextPollAfterSuccess(row.logistic_status, finishedAt, deps.cfg)
  } else if (kind === 'credentials') {
    nextPoll = null // the row keeps its due time; the breaker (below) is what stops the claims
    pause = 'credentials'
    pauseSeconds = deps.cfg.credentialsPauseMinutes * 60
  } else {
    nextPoll = nextPollAfterFailure(row.consecutive_failures + 1, finishedAt, deps.cfg)
    if (classified.outcome === 'rate_limited') {
      pause = 'rate_limited'
      pauseSeconds = rateLimitPauseSeconds(classified.retryAfterSeconds, deps.cfg)
      nextPoll = new Date(finishedAt.getTime() + pauseSeconds * 1000)
    }
    attention = kind === 'order' && attentionWindowElapsed(row.first_failure_at ? new Date(row.first_failure_at) : null, finishedAt, deps.cfg)
  }

  const { data, error } = await admin.rpc('apply_shipment_poll', {
    p_account: row.account_id,
    p_order: row.order_id,
    p_claim_token: row.claim_token,
    p_identifier_version: row.identifier_version,
    p_started_at: startedAt.toISOString(),
    p_finished_at: finishedAt.toISOString(),
    p_trigger: trigger,
    p_outcome: classified.outcome,
    p_http_status: classified.httpStatus,
    p_latency_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    p_normalized: classified.normalized,
    p_raw_summary: classified.rawSummary,
    p_raw_hash: classified.rawHash,
    p_destination_at: classified.destinationAt,
    p_next_poll_at: nextPoll ? nextPoll.toISOString() : null,
    p_attention: attention,
    p_error_code: classified.errorCode,
    p_now: finishedAt.toISOString(),
  })
  if (error) {
    console.error('[shalom] could not record a poll:', error.code)
    return { outcome: classified.outcome, applied: false, ignoredReason: 'record_failed', pause, pauseSeconds }
  }
  const out = (data ?? {}) as { applied?: boolean; reason?: string }
  return { outcome: classified.outcome, applied: out.applied === true, ignoredReason: out.reason ?? null, pause, pauseSeconds }
}

export interface TickSummary {
  enabled: boolean
  claimed: number
  applied: number
  ignored: number
  byOutcome: Partial<Record<PollOutcome, number>>
  paused: PauseReason
  alertsCreated: number
  alertsNotified: number
  /** PR-05A/B: pickup condition + customer message (counters only). */
  pickup: { alerted: number; messagesDue: number; abandoned: number }
  messages: MessageTickResult
  purgedPolls: number
  errors: number
  durationMs: number
}

class SkipQueries extends Error {}

export const emptyTick = (enabled: boolean): TickSummary => ({ enabled, claimed: 0, applied: 0, ignored: 0, byOutcome: {}, paused: null, alertsCreated: 0, alertsNotified: 0, pickup: { alerted: 0, messagesDue: 0, abandoned: 0 }, messages: emptyMessageTick(), purgedPolls: 0, errors: 0, durationMs: 0 })

/**
 * One cron tick: claim a batch (FOR UPDATE SKIP LOCKED) → query sequentially → apply each answer; a 429 or a credentials failure PAUSES the rest of the
 * batch (claims handed back without counting a failure; credentials also open the global breaker). Then evaluate the 15-day alerts and purge old polls:
 * both independent of Shalom (the alert clock does not depend on Shalom being up).
 */
export async function runShalomTick(admin: SupabaseClient, deps: PollDeps): Promise<TickSummary> {
  const t0 = Date.now()
  const summary = emptyTick(!deps.skipQueries)
  try {
    const now = clock(deps)
    if (deps.skipQueries) throw new SkipQueries()
    const { data, error } = await admin.rpc('claim_shipment_polls', { p_limit: deps.cfg.batchSize, p_lease_seconds: deps.cfg.leaseSeconds, p_order: null, p_now: now.toISOString() })
    if (error) {
      summary.errors += 1
      console.error('[shalom] claim failed:', error.code)
    }
    const claimed = ((data ?? []) as ClaimedShipment[])
    summary.claimed = claimed.length

    for (let i = 0; i < claimed.length; i += 1) {
      const row = claimed[i]
      let result: PollResult
      try {
        result = await pollClaimed(admin, row, deps, 'cron')
      } catch (e) {
        summary.errors += 1
        console.error('[shalom] poll crashed:', e instanceof Error ? e.name : 'unknown')
        continue
      }
      summary.byOutcome[result.outcome] = (summary.byOutcome[result.outcome] ?? 0) + 1
      if (result.applied) summary.applied += 1
      else summary.ignored += 1
      if (result.pause) {
        summary.paused = result.pause
        const rest = claimed.slice(i + 1).map((r) => r.claim_token)
        if (result.pause === 'credentials') {
          const { error: tripError } = await admin.rpc('trip_shalom_credentials_breaker', { p_pause_seconds: result.pauseSeconds, p_reason: 'credentials', p_now: clock(deps).toISOString() })
          if (tripError) summary.errors += 1
        }
        if (rest.length > 0) await admin.rpc('release_shipment_claims', { p_tokens: rest, p_next_poll_at: null })
        break
      }
    }
  } catch (e) {
    if (!(e instanceof SkipQueries)) {
      summary.errors += 1
      console.error('[shalom] tick failed:', e instanceof Error ? e.name : 'unknown')
    }
  }

  // Independent of Shalom: the clock of the alert and the retention of the technical log.
  try {
    const { data } = await admin.rpc('evaluate_destination_alerts', { p_now: clock(deps).toISOString(), p_days: deps.cfg.alertDays })
    const out = (data ?? {}) as { created?: number; notified?: number }
    summary.alertsCreated = out.created ?? 0
    summary.alertsNotified = out.notified ?? 0
    const { data: purged } = await admin.rpc('purge_shipment_polls', { p_days: deps.cfg.pollRetentionDays, p_now: clock(deps).toISOString() })
    summary.purgedPolls = typeof purged === 'number' ? purged : 0
  } catch (e) {
    summary.errors += 1
    console.error('[shalom] alert evaluation failed:', e instanceof Error ? e.name : 'unknown')
  }

  // PR-05A/B, also independent of Shalom and of each other: the pickup condition (day 15 -> alerted_15d and the customer message becomes due) ...
  try {
    const { data, error } = await admin.rpc('evaluate_pickup_day15', { p_now: clock(deps).toISOString(), p_days: deps.cfg.customerMessageDays })
    if (error) throw new Error(error.code ?? 'rpc')
    const out = (data ?? {}) as { alerted?: number; messages_due?: number }
    summary.pickup.alerted = out.alerted ?? 0
    summary.pickup.messagesDue = out.messages_due ?? 0
  } catch (e) {
    summary.errors += 1
    console.error('[shalom] pickup day-15 evaluation failed:', e instanceof Error ? e.message : 'unknown')
  }

  // ... and the customer message itself: an external action (WhatsApp), so it also honours the global kill switch; a failure here never touches the tracking.
  if (!deps.skipQueries) {
    summary.messages = await processCustomerMessages(admin, { cfg: deps.cfg, now: deps.now, sendMessage: deps.sendMessage })
    summary.errors += summary.messages.errors
  }
  summary.durationMs = Date.now() - t0
  console.info('[shalom] tick', JSON.stringify({ claimed: summary.claimed, applied: summary.applied, ignored: summary.ignored, byOutcome: summary.byOutcome, paused: summary.paused, alerts: summary.alertsCreated, pickup: summary.pickup, messages: summary.messages, errors: summary.errors, ms: summary.durationMs }))
  return summary
}

/** Queries ONE shipment now (forced refresh). Returns null when nothing could be claimed (not due, paused by the breaker, flag OFF, or another worker has it). */
export async function pollOrderNow(admin: SupabaseClient, orderId: string, deps: PollDeps): Promise<PollResult | null> {
  const { data, error } = await admin.rpc('claim_shipment_polls', { p_limit: 1, p_lease_seconds: deps.cfg.leaseSeconds, p_order: orderId, p_now: clock(deps).toISOString() })
  if (error) {
    console.error('[shalom] manual claim failed:', error.code)
    return null
  }
  const [row] = (data ?? []) as ClaimedShipment[]
  if (!row) return null
  const result = await pollClaimed(admin, row, deps, 'manual')
  if (result.pause === 'credentials') {
    await admin.rpc('trip_shalom_credentials_breaker', { p_pause_seconds: result.pauseSeconds, p_reason: 'credentials', p_now: clock(deps).toISOString() })
  }
  return result
}

export interface ShalomHealth {
  active: number
  due: number
  requiresAttention: number
  stopped: number
  delivered: number
  openAlerts: number
  acknowledgedAlerts: number
  unknownStateExceptions: number
  pollsLastHour: Partial<Record<PollOutcome, number>>
  lastSuccessAt: string | null
  oldestDueAt: string | null
  credentialsPausedUntil: string | null
}

/** Read-only operational counters (no PII, no credentials). */
export async function collectShalomHealth(admin: SupabaseClient, now: Date = new Date()): Promise<ShalomHealth> {
  const count = async (table: string, apply: (q: any) => any): Promise<number> => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const { count: c } = await apply(admin.from(table).select('*', { count: 'exact', head: true }))
    return c ?? 0
  }
  const iso = now.toISOString()
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString()
  const [active, due, requiresAttention, stopped, delivered, openAlerts, acknowledgedAlerts, unknown] = await Promise.all([
    count('order_shipments', (q) => q.eq('tracking_state', 'active')),
    count('order_shipments', (q) => q.eq('tracking_state', 'active').lte('next_poll_at', iso)),
    count('order_shipments', (q) => q.eq('tracking_state', 'requires_attention')),
    count('order_shipments', (q) => q.eq('tracking_state', 'stopped')),
    count('order_shipments', (q) => q.eq('tracking_state', 'delivered')),
    count('order_shipment_alerts', (q) => q.eq('status', 'open')),
    count('order_shipment_alerts', (q) => q.eq('status', 'acknowledged')),
    count('order_shipments', (q) => q.eq('last_error_kind', 'exception')),
  ])
  const { data: recent } = await admin.from('order_shipment_polls').select('outcome').gte('created_at', hourAgo).limit(1000)
  const pollsLastHour: Partial<Record<PollOutcome, number>> = {}
  for (const p of (recent ?? []) as Array<{ outcome: PollOutcome }>) pollsLastHour[p.outcome] = (pollsLastHour[p.outcome] ?? 0) + 1
  const { data: last } = await admin.from('order_shipments').select('last_success_at').not('last_success_at', 'is', null).order('last_success_at', { ascending: false }).limit(1)
  const { data: oldest } = await admin.from('order_shipments').select('next_poll_at').eq('tracking_state', 'active').not('next_poll_at', 'is', null).order('next_poll_at', { ascending: true }).limit(1)
  const { data: paused } = await admin.from('order_shipment_settings').select('credentials_paused_until').gt('credentials_paused_until', iso).order('credentials_paused_until', { ascending: false }).limit(1)
  return {
    active, due, requiresAttention, stopped, delivered, openAlerts, acknowledgedAlerts, unknownStateExceptions: unknown, pollsLastHour,
    lastSuccessAt: ((last ?? [])[0] as { last_success_at: string } | undefined)?.last_success_at ?? null,
    oldestDueAt: ((oldest ?? [])[0] as { next_poll_at: string } | undefined)?.next_poll_at ?? null,
    credentialsPausedUntil: ((paused ?? [])[0] as { credentials_paused_until: string } | undefined)?.credentials_paused_until ?? null,
  }
}
