import { readFileSync } from 'node:fs'

import { ShalomProviderError, type ProviderResponse, type ShalomTrackingProvider, type TrackingQuery } from '@/lib/orders/shalom/types'

// Provider registry. NO REAL PROVIDER EXISTS and none is wired: the Shalom API could not be confirmed as official and the InkaClick endpoint is NOT an
// approved contract (REAL INTEGRATION: BLOCKED UNTIL CONTRACT/AUTHORIZATION VERIFIED). This file only offers the two local ones:
//   not_configured  default everywhere. Never makes any call: every query ends as an integration failure the cron survives.
//   fake            deterministic stand-in for local development / tests / UAT. NEVER selectable in production (SHALOM_PROVIDER=fake outside production only).
// No Shalom credential is read, stored or required by anything here.

export const notConfiguredProvider: ShalomTrackingProvider = {
  name: 'not_configured',
  async fetchTracking(): Promise<ProviderResponse> {
    throw new ShalomProviderError('not_configured')
  },
}

/** The scenarios the fake provider can play (QA tooling switches between them without restarting anything). */
export const FAKE_SCENARIOS = [
  'origin', 'transit', 'destination', 'delivered',
  'not_found', 'invalid', 'rate_limited', 'credentials_401', 'credentials_403',
  'server_500', 'server_502', 'server_503', 'server_504',
  'timeout', 'hang', 'invalid_json', 'degraded_auth', 'degraded_login', 'degraded_order', 'unknown',
] as const
export type FakeScenario = (typeof FAKE_SCENARIOS)[number]

const ok = (body: unknown): ProviderResponse => ({ httpStatus: 200, body })
const failure = (httpStatus: number, extra: Partial<ProviderResponse> = {}): ProviderResponse => ({ httpStatus, body: { error: { code: `http_${httpStatus}`, message: 'simulated' } }, ...extra })

/** Same SHAPE as the answers observed in InkaClick (status.{registrado,origen,transito,destino,entregado,reparto,demora} + order.*). Synthetic values only. */
function body(numero: string, status: Record<string, unknown>, delivered = false): unknown {
  return {
    status: { registrado: { fecha: '2026-01-01T10:00:00Z' }, origen: null, transito: null, destino: null, entregado: delivered, reparto: null, demora: null, ...status },
    order: { numero_orden: numero, codigo_orden: 'SIM', entregado: delivered, destino: 'SIMULADO', origen: 'SIMULADO' },
    detailed: true,
  }
}

/** `scenario` may carry a date for destination / delivered: "destination@2026-12-01T15:00:00Z". */
export function fakeResponse(spec: string, numero: string, signal?: AbortSignal): ProviderResponse | Promise<ProviderResponse> {
  const [name, arg] = spec.split('@') as [string, string | undefined]
  switch (name as FakeScenario) {
    case 'origin':
      return ok(body(numero, { origen: { fecha: '2026-01-02T10:00:00Z' } }))
    case 'transit':
      return ok(body(numero, { origen: { fecha: '2026-01-02T10:00:00Z' }, transito: { completo: true } }))
    case 'destination':
      return ok(body(numero, { origen: { fecha: '2026-01-02T10:00:00Z' }, transito: { completo: true }, destino: { completo: true, ...(arg ? { fecha: arg } : {}) } }))
    case 'delivered':
      return ok(body(numero, { destino: { completo: true, ...(arg ? { fecha: arg } : {}) }, entregado: true }, true))
    case 'not_found':
      return failure(404, { body: { error: { code: 'not_found', message: 'No se encontró la orden de servicio.' } } })
    case 'invalid':
      return failure(422)
    case 'rate_limited':
      return failure(429, { retryAfterSeconds: 2 })
    case 'credentials_401':
      return failure(401)
    case 'credentials_403':
      return failure(403)
    case 'server_500':
      return failure(500)
    case 'server_502':
      return failure(502)
    case 'server_503':
      return failure(503)
    case 'server_504':
      return failure(504)
    case 'timeout':
      throw new ShalomProviderError('timeout')
    case 'hang':
      return new Promise<ProviderResponse>((_, reject) => signal?.addEventListener('abort', () => reject(new ShalomProviderError('timeout')), { once: true }))
    case 'invalid_json':
      return { httpStatus: 200, body: null, invalidJson: true }
    case 'degraded_auth':
      return ok({ ...(body(numero, {}) as object), degraded_reason: 'shalom_auth_failed' })
    case 'degraded_login':
      return ok({ ...(body(numero, {}) as object), degraded_reason: 'shalom_login_unavailable' })
    case 'degraded_order':
      return ok({ ...(body(numero, {}) as object), degraded_reason: 'orden_no_disponible' })
    case 'unknown':
      return ok({ status: { registrado: null, origen: null, transito: null, destino: null, entregado: false, reparto: { fecha: '2026-01-03T10:00:00Z' }, demora: true }, order: { numero_orden: numero }, detailed: true })
    default:
      throw new Error(`unknown fake scenario "${spec}"`)
  }
}

export interface FakeScenarioFile {
  default?: string
  byNumber?: Record<string, string>
}

/** Which scenario applies to a guide: the per-number one, else the default, else "origin". */
export function pickScenario(file: FakeScenarioFile | null, numero: string): string {
  return file?.byNumber?.[numero] ?? file?.default ?? 'origin'
}

export function createFakeProvider(scenarioFor: (numero: string) => string): ShalomTrackingProvider {
  return {
    name: 'fake',
    async fetchTracking(query: TrackingQuery): Promise<ProviderResponse> {
      return fakeResponse(scenarioFor(query.numero), query.numero, query.signal)
    },
  }
}

function readScenarioFile(path: string | undefined): FakeScenarioFile | null {
  if (!path) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as FakeScenarioFile) : null
  } catch {
    return null
  }
}

/**
 * The provider for this process. Today: `not_configured`, or the fake one when SHALOM_PROVIDER=fake outside production. A real provider will be registered
 * here (and nowhere else) only after the contract / authorization is verified; until then production can only ever resolve `not_configured`.
 */
export function resolveShalomProvider(env: Record<string, string | undefined> = process.env): ShalomTrackingProvider {
  if (env.SHALOM_PROVIDER === 'fake' && env.NODE_ENV !== 'production') {
    const path = env.SHALOM_FAKE_SCENARIO_FILE
    return createFakeProvider((numero) => pickScenario(readScenarioFile(path), numero))
  }
  return notConfiguredProvider
}
