// Browser-side shapes of the PR-05 endpoints (mirror src/lib/orders/shalom/service.ts). The browser never sends an account, role or actor.

export type ShipmentStatus = 'at_origin' | 'in_transit' | 'at_destination' | 'delivered'
export type PickupState = 'none' | 'waiting_pickup' | 'alerted_15d' | 'abandoned' | 'completed'
export type TrackingState = 'active' | 'requires_attention' | 'stopped' | 'delivered'

export interface ShipmentView {
  id: string
  order_id: string
  tracking_number: string
  tracking_code: string
  identifier_version: number
  logistic_status: ShipmentStatus | null
  tracking_state: TrackingState
  stop_reason: string | null
  stopped_at: string | null
  status_changed_at: string | null
  destination_episode: number
  destination_entered_at: string | null
  last_polled_at: string | null
  last_success_at: string | null
  next_poll_at: string | null
  consecutive_failures: number
  last_error_kind: 'order' | 'integration' | 'credentials' | 'exception' | null
  last_error_code: string | null
  pickup_state: PickupState
  pickup_alerted_at: string | null
  pickup_abandoned_at: string | null
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

export type ShipmentMessageKind = 'destination_15d_customer' | 'destination_arrival_customer'

export interface ShipmentMessageView {
  id: string
  destination_episode: number
  /** Which customer notice this ledger row is: the immediate arrival one or the day-15 reminder. */
  kind?: ShipmentMessageKind
  status: 'pending' | 'claimed' | 'sending' | 'sent' | 'failed' | 'uncertain' | 'skipped'
  attempt: number
  error_code: string | null
  next_attempt_at: string | null
  resolution: string | null
  created_at: string
  finished_at: string | null
}

export interface ShipmentPanelData {
  eligible: boolean
  shipment: ShipmentView | null
  events: ShipmentEventView[]
  alerts: ShipmentAlertView[]
  polls: ShipmentPollView[]
  messages: ShipmentMessageView[]
  days_at_destination: number | null
  can_stop: boolean
}

export interface ShipmentSummaryData {
  logistic_status: ShipmentStatus | null
  tracking_state: TrackingState
  alert_open: boolean
  needs_attention: boolean
  pickup_state: PickupState
  days_at_destination: number | null
}

/** Broadcast "the tracking of this order changed" so the list indicator refreshes (same pattern as PR-04's logistics-changed event). */
export const SHIPMENT_CHANGED_EVENT = 'wacrm:shipment-changed'
export const notifyShipmentChanged = (orderId: string | null) => {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SHIPMENT_CHANGED_EVENT, { detail: { orderId } }))
}

export const SHIPMENT_STEPS = ['ready_for_dispatch', 'at_origin', 'in_transit', 'at_destination', 'delivered'] as const
