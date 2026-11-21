import { extractDestinationDate, hashRaw, mapShalomStatus, summarizeRaw } from '@/lib/orders/shalom/normalize'
import type { ErrorKind, PollOutcome, ProviderResponse, ShipmentStatus } from '@/lib/orders/shalom/types'

// ONE place that turns a provider answer into an outcome. Separates ERROR DE PEDIDO / ERROR DE INTEGRACIÓN / ERROR GLOBAL DE CREDENCIALES. A single 404 is a
// plain order-level answer: it NEVER marks a guide as permanently inexistent (the attention window is decided by config.ts + the database).

export interface Classified {
  outcome: PollOutcome
  httpStatus: number | null
  normalized: ShipmentStatus | null
  destinationAt: string | null
  rawSummary: Record<string, unknown> | null
  rawHash: string | null
  errorCode: string | null
  retryAfterSeconds: number | null
}

const base = (over: Partial<Classified>): Classified => ({ outcome: 'server_error', httpStatus: null, normalized: null, destinationAt: null, rawSummary: null, rawHash: null, errorCode: null, retryAfterSeconds: null, ...over })

export function errorKindOf(outcome: PollOutcome): ErrorKind | null {
  switch (outcome) {
    case 'not_found':
    case 'invalid_identifier':
    case 'degraded_order':
      return 'order'
    case 'rate_limited':
    case 'server_error':
    case 'timeout':
    case 'invalid_json':
    case 'degraded_integration':
      return 'integration'
    case 'credentials':
      return 'credentials'
    default:
      return null
  }
}

function degradedOutcome(reason: unknown): PollOutcome | null {
  if (typeof reason !== 'string' || reason === '') return null
  if (reason === 'shalom_auth_failed') return 'credentials'
  if (reason === 'orden_no_disponible') return 'degraded_order'
  return 'degraded_integration' // shalom_login_unavailable and anything we do not know: Shalom's side, not the order's
}

const bodyErrorCode = (body: unknown): string | undefined => {
  if (typeof body !== 'object' || body === null) return undefined
  const err = (body as { error?: unknown }).error
  return typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : undefined
}

export function classifyResponse(res: ProviderResponse): Classified {
  const httpStatus = res.httpStatus
  const retry = res.retryAfterSeconds ?? null
  if (httpStatus === 429) return base({ outcome: 'rate_limited', httpStatus, errorCode: 'rate_limited', retryAfterSeconds: retry })
  if (httpStatus === 401 || httpStatus === 403) return base({ outcome: 'credentials', httpStatus, errorCode: 'credentials' })
  if (httpStatus === 404 || bodyErrorCode(res.body) === 'not_found') return base({ outcome: 'not_found', httpStatus, errorCode: 'not_found' })
  if (httpStatus === 400 || httpStatus === 422) return base({ outcome: 'invalid_identifier', httpStatus, errorCode: 'invalid_identifier' })
  if (httpStatus === 408) return base({ outcome: 'timeout', httpStatus, errorCode: 'timeout' })
  if (httpStatus >= 500 || httpStatus < 200 || (httpStatus >= 300 && httpStatus < 500)) {
    return base({ outcome: 'server_error', httpStatus, errorCode: httpStatus >= 500 ? `http_${httpStatus}` : 'http_unexpected' })
  }

  // 2xx
  if (res.invalidJson || typeof res.body !== 'object' || res.body === null || Array.isArray(res.body)) return base({ outcome: 'invalid_json', httpStatus, errorCode: 'invalid_json' })
  const degraded = degradedOutcome((res.body as { degraded_reason?: unknown }).degraded_reason)
  if (degraded) return base({ outcome: degraded, httpStatus, errorCode: degraded === 'credentials' ? 'credentials' : degraded })

  const normalized = mapShalomStatus(res.body)
  const rawSummary = summarizeRaw(res.body)
  const rawHash = hashRaw(res.body)
  if (!normalized) return base({ outcome: 'unknown_state', httpStatus, rawSummary, rawHash, errorCode: 'unknown_status' })
  return base({ outcome: 'ok', httpStatus, normalized, destinationAt: normalized === 'at_destination' || normalized === 'delivered' ? extractDestinationDate(res.body) : null, rawSummary, rawHash })
}

/** No HTTP answer at all: a timeout or a connection failure (both INTEGRATION errors). */
export function classifyFailure(code: 'timeout' | 'network' | 'not_configured'): Classified {
  if (code === 'timeout') return base({ outcome: 'timeout', errorCode: 'timeout' })
  if (code === 'network') return base({ outcome: 'server_error', errorCode: 'network_error' })
  return base({ outcome: 'server_error', errorCode: 'not_configured' })
}
