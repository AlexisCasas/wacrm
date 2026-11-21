import type { SupabaseClient } from '@supabase/supabase-js'

import type { LogisticsCaller } from '@/lib/orders/logistics/access'
import { fail, mapRpcError, type ServiceResult } from '@/lib/orders/logistics/documents'
import { isUuid } from '@/lib/orders/logistics/files'
import { pollOrderNow, type PollDeps, type PollResult } from '@/lib/orders/shalom/poller'

// PR-05 · what Logística / Supervisor DO with a shipment (register / correct / refresh / acknowledge / stop) and what they SEE (panel, list summary).
// The account and the actor come from the SESSION (never from the request); the database re-validates both flags, the area, the role and the order's
// account inside every RPC. Nothing here calls Shalom except the forced refresh (through the injected provider).

export type ShipmentCaller = Pick<LogisticsCaller, 'userId' | 'accountId'>

export const NUMERO_PATTERN = /^[0-9]{6,12}$/
export const CODIGO_PATTERN = /^[A-Z0-9]{3,6}$/

/** Trim + upper-case the code; null when the guide does not have the (PROVISIONAL, evidence-based) format. */
export function normalizeIdentifier(numero: unknown, codigo: unknown): { numero: string; codigo: string } | null {
  if (typeof numero !== 'string' || typeof codigo !== 'string') return null
  const n = numero.trim()
  const c = codigo.trim().toUpperCase()
  return NUMERO_PATTERN.test(n) && CODIGO_PATTERN.test(c) ? { numero: n, codigo: c } : null
}

const REASON_STATUS: Record<string, number> = {
  invalid_identifier: 422,
  not_ready_for_dispatch: 409,
  already_registered: 409,
  no_shipment: 404,
  delivered_locked: 409,
  stopped: 409,
  stale: 409,
  rate_limited: 429,
  invalid_reason: 400,
  resolved: 409,
}

interface RpcOut {
  ok?: boolean
  reason?: string
  retry_after_seconds?: number
  [key: string]: unknown
}

function settle<T>(data: unknown, error: { code?: string; message?: string } | null, pick: (out: RpcOut) => T): ServiceResult<T> {
  if (error) return mapRpcError(error)
  const out = (data ?? {}) as RpcOut
  if (out.ok !== true) {
    const reason = out.reason ?? 'rejected'
    return fail(REASON_STATUS[reason] ?? 409, reason, out.retry_after_seconds ? { retry_after_seconds: out.retry_after_seconds } : undefined)
  }
  return { ok: true, status: 200, body: pick(out) }
}

export async function registerShipment(ctx: ShipmentCaller, admin: SupabaseClient, orderId: string, input: { numero: unknown; codigo: unknown }, now: Date = new Date()): Promise<ServiceResult<{ created: boolean; identifier_version: number }>> {
  if (!isUuid(orderId)) return fail(400, 'invalid_order_id')
  const id = normalizeIdentifier(input.numero, input.codigo)
  if (!id) return fail(422, 'invalid_identifier')
  const { data, error } = await admin.rpc('register_order_shipment', { p_account: ctx.accountId, p_actor: ctx.userId, p_order: orderId, p_number: id.numero, p_code: id.codigo, p_source: 'manual', p_now: now.toISOString() })
  const r = settle(data, error, (o) => ({ created: o.created === true, identifier_version: Number(o.identifier_version ?? 1) }))
  return r.ok && r.body.created ? { ...r, status: 201 } : r
}

export async function correctShipment(ctx: ShipmentCaller, admin: SupabaseClient, orderId: string, input: { numero: unknown; codigo: unknown; expectedVersion?: unknown }, now: Date = new Date()): Promise<ServiceResult<{ changed: boolean; identifier_version: number }>> {
  if (!isUuid(orderId)) return fail(400, 'invalid_order_id')
  const id = normalizeIdentifier(input.numero, input.codigo)
  if (!id) return fail(422, 'invalid_identifier')
  const expected = typeof input.expectedVersion === 'number' && Number.isInteger(input.expectedVersion) ? input.expectedVersion : null
  const { data, error } = await admin.rpc('correct_order_shipment_identifier', { p_account: ctx.accountId, p_actor: ctx.userId, p_order: orderId, p_number: id.numero, p_code: id.codigo, p_expected_version: expected, p_now: now.toISOString() })
  return settle(data, error, (o) => ({ changed: o.changed === true, identifier_version: Number(o.identifier_version ?? 0) }))
}

export async function stopShipment(ctx: ShipmentCaller, admin: SupabaseClient, orderId: string, reason: unknown, now: Date = new Date()): Promise<ServiceResult<{ changed: boolean }>> {
  if (!isUuid(orderId)) return fail(400, 'invalid_order_id')
  const r = typeof reason === 'string' && reason !== '' ? reason : 'manual'
  const { data, error } = await admin.rpc('stop_order_shipment', { p_account: ctx.accountId, p_actor: ctx.userId, p_order: orderId, p_reason: r, p_now: now.toISOString() })
  return settle(data, error, (o) => ({ changed: o.changed === true }))
}

export interface RefreshBody {
  /** The query ran now (true) or could not be claimed (false: paused by the credentials breaker / another worker holds it). */
  queried: boolean
  outcome: PollResult['outcome'] | null
}

/** Forced refresh: rate limited per order in the database, then ONE query now through the injected provider. */
export async function refreshShipment(ctx: ShipmentCaller, admin: SupabaseClient, orderId: string, deps: PollDeps): Promise<ServiceResult<RefreshBody>> {
  if (!isUuid(orderId)) return fail(400, 'invalid_order_id')
  const now = deps.now ? deps.now() : new Date()
  const { data, error } = await admin.rpc('request_shipment_refresh', { p_account: ctx.accountId, p_actor: ctx.userId, p_order: orderId, p_min_interval_seconds: deps.cfg.refreshMinIntervalSeconds, p_now: now.toISOString() })
  const gate = settle(data, error, () => true)
  if (!gate.ok) return gate
  const result = await pollOrderNow(admin, orderId, deps)
  return { ok: true, status: 200, body: { queried: result !== null, outcome: result?.outcome ?? null } }
}

export async function acknowledgeAlert(ctx: ShipmentCaller, admin: SupabaseClient, alertId: string, now: Date = new Date()): Promise<ServiceResult<{ changed: boolean }>> {
  if (!isUuid(alertId)) return fail(400, 'invalid_alert_id')
  const { data, error } = await admin.rpc('acknowledge_shipment_alert', { p_account: ctx.accountId, p_actor: ctx.userId, p_alert: alertId, p_now: now.toISOString() })
  return settle(data, error, (o) => ({ changed: o.changed === true }))
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Reads (the CALLER's client: RLS applies on top of the explicit account filter)
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** Columns the browser may see. Never the claim token / lease. */
export const SHIPMENT_COLUMNS =
  'id, order_id, tracking_number, tracking_code, identifier_version, identifier_source, logistic_status, tracking_state, stop_reason, stopped_at, status_changed_at, destination_episode, destination_entered_at, destination_entered_source, last_raw, last_polled_at, last_success_at, next_poll_at, consecutive_failures, first_failure_at, last_error_kind, last_error_code, pickup_state, pickup_state_at, pickup_alerted_at, pickup_abandoned_at, created_at, updated_at' as const

export type PickupState = 'none' | 'waiting_pickup' | 'alerted_15d' | 'abandoned' | 'completed'

/** Complete calendar days (America/Lima) between the entry into En destino and now. */
export function daysAtDestination(enteredAt: string | null | undefined, now: Date = new Date()): number | null {
  if (!enteredAt) return null
  const lima = (d: Date) => {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
    return Date.parse(`${p}T00:00:00Z`)
  }
  const from = new Date(enteredAt)
  if (Number.isNaN(from.getTime())) return null
  return Math.max(0, Math.round((lima(now) - lima(from)) / 86_400_000))
}

export interface ShipmentView {
  id: string
  order_id: string
  tracking_number: string
  tracking_code: string
  identifier_version: number
  identifier_source: string
  logistic_status: 'at_origin' | 'in_transit' | 'at_destination' | 'delivered' | null
  tracking_state: 'active' | 'requires_attention' | 'stopped' | 'delivered'
  stop_reason: string | null
  stopped_at: string | null
  status_changed_at: string | null
  destination_episode: number
  destination_entered_at: string | null
  destination_entered_source: string | null
  last_raw: Record<string, unknown> | null
  last_polled_at: string | null
  last_success_at: string | null
  next_poll_at: string | null
  consecutive_failures: number
  first_failure_at: string | null
  last_error_kind: 'order' | 'integration' | 'credentials' | 'exception' | null
  last_error_code: string | null
  /** PR-05B: the WACRM pickup condition (NOT a Shalom status). */
  pickup_state: PickupState
  pickup_state_at: string | null
  pickup_alerted_at: string | null
  pickup_abandoned_at: string | null
  created_at: string
  updated_at: string
}

export interface ShipmentEventView {
  id: string
  event_type: string
  from_status: string | null
  to_status: string | null
  source: string
  actor_name: string
  detail: Record<string, unknown>
  created_at: string
}

export interface ShipmentAlertView {
  id: string
  destination_episode: number
  status: 'open' | 'acknowledged' | 'resolved'
  due_date: string
  created_at: string
  acknowledged_at: string | null
  resolved_at: string | null
  resolved_reason: string | null
}

/** The voucher notice (P0 parity) of the current guide: one row per guide, sent by a person. */
export interface VoucherMessageView {
  id: string
  identifier_version: number
  status: 'claimed' | 'sending' | 'sent' | 'failed' | 'uncertain' | 'skipped'
  attempt: number
  error_code: string | null
  resolution: string | null
  created_at: string
  finished_at: string | null
}

export interface ShipmentMessageView {
  id: string
  destination_episode: number
  status: 'pending' | 'claimed' | 'sending' | 'sent' | 'failed' | 'uncertain' | 'skipped'
  attempt: number
  error_code: string | null
  next_attempt_at: string | null
  resolution: string | null
  created_at: string
  finished_at: string | null
}

export interface ShipmentPollView {
  id: string
  trigger: string
  started_at: string
  outcome: string
  http_status: number | null
  latency_ms: number | null
  applied: boolean
  ignored_reason: string | null
}

export interface ShipmentPanel {
  /** The order is ready_for_dispatch in PR-04: only then can a guide be registered. */
  eligible: boolean
  shipment: ShipmentView | null
  events: ShipmentEventView[]
  alerts: ShipmentAlertView[]
  polls: ShipmentPollView[]
  /** PR-05A: the day-15 customer message of the CURRENT episode first (newest episode first). */
  messages: ShipmentMessageView[]
  voucher_messages: VoucherMessageView[]
  /** Complete calendar days En destino (null when not En destino). */
  days_at_destination: number | null
  can_stop: boolean
}

/** The second wall for reads: the database says whether THIS person works tracking in THIS account (both flags + area + role). */
async function denyUnlessShipments(ctx: Pick<LogisticsCaller, 'supabase' | 'accountId'>): Promise<ServiceResult<never> | null> {
  const { data, error } = await ctx.supabase.rpc('order_shipments_access', { p_account_id: ctx.accountId })
  if (error) {
    console.error('[shalom] access check failed:', error.code)
    return fail(500, 'internal_error')
  }
  return data === true ? null : fail(404, 'not_found')
}

export async function getShipmentPanel(ctx: LogisticsCaller, orderId: string, canStop: boolean): Promise<ServiceResult<ShipmentPanel>> {
  if (!isUuid(orderId)) return fail(400, 'invalid_order_id')
  const denied = await denyUnlessShipments(ctx)
  if (denied) return denied
  const { data: order, error: orderError } = await ctx.supabase.from('order_confirmations').select('id').eq('account_id', ctx.accountId).eq('id', orderId).maybeSingle()
  if (orderError) return fail(500, 'internal_error')
  if (!order) return fail(404, 'not_found')

  const [logistics, shipment, events, alerts, polls, messages, voucherMessages] = await Promise.all([
    ctx.supabase.from('order_logistics').select('status').eq('account_id', ctx.accountId).eq('order_id', orderId).maybeSingle(),
    ctx.supabase.from('order_shipments').select(SHIPMENT_COLUMNS).eq('account_id', ctx.accountId).eq('order_id', orderId).maybeSingle(),
    ctx.supabase.from('order_shipment_events').select('id, event_type, from_status, to_status, source, actor_name, detail, created_at').eq('account_id', ctx.accountId).eq('order_id', orderId).order('created_at', { ascending: false }).limit(40),
    ctx.supabase.from('order_shipment_alerts').select('id, destination_episode, status, due_date, created_at, acknowledged_at, resolved_at, resolved_reason').eq('account_id', ctx.accountId).eq('order_id', orderId).order('destination_episode', { ascending: false }).limit(10),
    ctx.supabase.from('order_shipment_polls').select('id, trigger, started_at, outcome, http_status, latency_ms, applied, ignored_reason').eq('account_id', ctx.accountId).eq('order_id', orderId).order('created_at', { ascending: false }).limit(8),
    ctx.supabase.from('order_shipment_messages').select('id, destination_episode, kind, status, attempt, error_code, next_attempt_at, resolution, created_at, finished_at').eq('account_id', ctx.accountId).eq('order_id', orderId).order('destination_episode', { ascending: false }).limit(10),
    ctx.supabase.from('order_shipment_voucher_messages').select('id, identifier_version, status, attempt, error_code, resolution, created_at, finished_at').eq('account_id', ctx.accountId).eq('order_id', orderId).order('identifier_version', { ascending: false }).limit(5),
  ])
  if (logistics.error || shipment.error || events.error || alerts.error || polls.error || messages.error || voucherMessages.error) {
    console.error('[shalom] panel read failed')
    return fail(500, 'internal_error')
  }
  const status = (logistics.data as { status: string } | null)?.status
  const view = (shipment.data as ShipmentView | null) ?? null
  return {
    ok: true,
    status: 200,
    body: {
      eligible: status === 'ready_for_dispatch',
      shipment: (shipment.data as ShipmentView | null) ?? null,
      events: (events.data ?? []) as ShipmentEventView[],
      alerts: (alerts.data ?? []) as ShipmentAlertView[],
      polls: (polls.data ?? []) as ShipmentPollView[],
      messages: (messages.data ?? []) as ShipmentMessageView[],
      voucher_messages: (voucherMessages.data ?? []) as VoucherMessageView[],
      days_at_destination: view?.logistic_status === 'at_destination' ? daysAtDestination(view.destination_entered_at) : null,
      can_stop: canStop,
    },
  }
}

export const MAX_SUMMARY_IDS = 50

export interface ShipmentSummary {
  logistic_status: ShipmentView['logistic_status']
  tracking_state: ShipmentView['tracking_state']
  alert_open: boolean
  needs_attention: boolean
  pickup_state: PickupState
  days_at_destination: number | null
}

/** One light row per order for the list (derived logistic status). Only shipments that exist are returned. */
export async function getShipmentSummary(ctx: LogisticsCaller, ids: string[]): Promise<ServiceResult<{ summaries: Record<string, ShipmentSummary> }>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0 || unique.length > MAX_SUMMARY_IDS || !unique.every(isUuid)) return fail(400, 'invalid_ids')
  const denied = await denyUnlessShipments(ctx)
  if (denied) return denied
  const [shipments, alerts] = await Promise.all([
    ctx.supabase.from('order_shipments').select('order_id, logistic_status, tracking_state, last_error_kind, pickup_state, destination_entered_at').eq('account_id', ctx.accountId).in('order_id', unique),
    ctx.supabase.from('order_shipment_alerts').select('order_id').eq('account_id', ctx.accountId).in('order_id', unique).neq('status', 'resolved'),
  ])
  if (shipments.error || alerts.error) return fail(500, 'internal_error')
  const open = new Set(((alerts.data ?? []) as Array<{ order_id: string }>).map((a) => a.order_id))
  const summaries: Record<string, ShipmentSummary> = {}
  for (const s of (shipments.data ?? []) as Array<{ order_id: string; logistic_status: ShipmentSummary['logistic_status']; tracking_state: ShipmentSummary['tracking_state']; last_error_kind: string | null; pickup_state: PickupState; destination_entered_at: string | null }>) {
    summaries[s.order_id] = { logistic_status: s.logistic_status, tracking_state: s.tracking_state, alert_open: open.has(s.order_id), needs_attention: s.tracking_state === 'requires_attention' || s.last_error_kind === 'exception', pickup_state: s.pickup_state, days_at_destination: s.logistic_status === 'at_destination' ? daysAtDestination(s.destination_entered_at) : null }
  }
  return { ok: true, status: 200, body: { summaries } }
}

export const MAX_ABANDONED_IDS = 500

/** The orders CURRENTLY "En abandono" in this account (the list filter). Read with the caller's own client (RLS). */
export async function listAbandonedOrders(ctx: LogisticsCaller): Promise<ServiceResult<{ order_ids: string[] }>> {
  const denied = await denyUnlessShipments(ctx)
  if (denied) return denied
  const { data, error } = await ctx.supabase.from('order_shipments').select('order_id').eq('account_id', ctx.accountId).eq('pickup_state', 'abandoned').order('pickup_abandoned_at', { ascending: false }).limit(MAX_ABANDONED_IDS)
  if (error) return fail(500, 'internal_error')
  return { ok: true, status: 200, body: { order_ids: ((data ?? []) as Array<{ order_id: string }>).map((r) => r.order_id) } }
}
