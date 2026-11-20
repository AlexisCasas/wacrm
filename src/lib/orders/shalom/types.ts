// PR-05 (Shalom tracking) · shared types. The domain only knows this provider interface: NO real provider is wired and none may be until the Shalom
// contract / authorization is verified (REAL INTEGRATION: BLOCKED UNTIL CONTRACT/AUTHORIZATION VERIFIED). Nothing here is a Shalom contract.

/** The normalized WACRM tracking status (PR-05 axis, separate from order_logistics.status of PR-04). */
export type ShipmentStatus = 'at_origin' | 'in_transit' | 'at_destination' | 'delivered'
export const SHIPMENT_STATUSES: readonly ShipmentStatus[] = ['at_origin', 'in_transit', 'at_destination', 'delivered']

export type TrackingState = 'active' | 'requires_attention' | 'stopped' | 'delivered'

/** What one query to the provider produced, classified (stored in order_shipment_polls.outcome). */
export type PollOutcome =
  | 'ok'
  | 'unknown_state'
  | 'not_found'
  | 'invalid_identifier'
  | 'rate_limited'
  | 'credentials'
  | 'server_error'
  | 'timeout'
  | 'invalid_json'
  | 'degraded_order'
  | 'degraded_integration'

/** ERROR DE PEDIDO (the guide) vs ERROR DE INTEGRACIÓN (Shalom / network) vs ERROR GLOBAL DE CREDENCIALES. */
export type ErrorKind = 'order' | 'integration' | 'credentials'

export interface TrackingQuery {
  /** numero_orden */
  numero: string
  /** codigo */
  codigo: string
  signal?: AbortSignal
}

/** The provider's RAW answer (an HTTP-like envelope). Interpreting it is the job of classify.ts, never of the provider. */
export interface ProviderResponse {
  httpStatus: number
  /** Parsed JSON body, or null when there was none / it was not valid JSON. */
  body: unknown
  invalidJson?: boolean
  retryAfterSeconds?: number | null
}

export interface ShalomTrackingProvider {
  readonly name: string
  fetchTracking(query: TrackingQuery): Promise<ProviderResponse>
}

/** Thrown by a provider when there is no HTTP answer at all. */
export type ProviderErrorCode = 'not_configured' | 'timeout' | 'network'
export class ShalomProviderError extends Error {
  constructor(readonly code: ProviderErrorCode) {
    super(code)
    this.name = 'ShalomProviderError'
  }
}
