import { ShalomProviderError, type ProviderResponse, type ShalomTrackingProvider, type TrackingQuery } from '@/lib/orders/shalom/types'

// REAL (HTTP) Shalom tracking provider. READ-ONLY: one GET per guide, nothing is ever written to the other side.
//
// It talks to the INTERMEDIATE tracking service that InkaClick uses today (contract discovered in a read-only audit of InkaClick; it is NOT an official
// Shalom contract and has not been confirmed by Shalom):
//
//   GET {SHALOM_BASE_URL}/v1/tracking?numero=<numero>&codigo=<codigo>
//   Accept: application/json · Content-Type: application/json
//   X-API-Key · X-Shalom-Email · X-Shalom-Password
//
// Rules this file enforces (each one has a test):
//   * SERVER SIDE ONLY. It reads nothing from the browser, imports nothing client-side and no value of it is ever NEXT_PUBLIC.
//   * The credentials only ever travel in the request headers. They are never logged, never part of a thrown error, never part of the returned value.
//   * No redirect is followed (`redirect: 'manual'`): the credentials must never be replayed to a host the operator did not configure.
//   * The answer is MINIMIZED before it leaves this file: the service returns customer data (sender, recipient, amounts, contents…); only the fields the
//     classifier needs survive (status flags/dates, order.entregado, degraded_reason, error.code). Nothing of the customer is kept or logged.
//   * Interpreting the answer (states, errors, breaker) stays in classify.ts / normalize.ts; this file only turns HTTP into a ProviderResponse.
//   * No HTTP answer at all -> ShalomProviderError('timeout' | 'network'); a failure never throws anything else.

export interface HttpProviderOptions {
  /** Origin (+ optional path prefix) of the intermediate service. https only (plain http only for localhost outside production). */
  baseUrl: string
  apiKey: string
  email: string
  password: string
  /** Injectable for tests: the suite never touches the network. */
  fetchImpl?: typeof fetch
}

/** Hard cap on the body that is read: a normal answer is a few KB. Anything bigger is treated as an invalid answer, never parsed. */
export const MAX_BODY_CHARS = 1_000_000
const MAX_DATE_CHARS = 40

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const shortText = (v: unknown, max = MAX_DATE_CHARS): string | null => (typeof v === 'string' ? v.slice(0, max) : null)

/** The service base URL, validated; `null` when it is unusable (the provider then cannot be selected). */
export function parseShalomBaseUrl(raw: string | undefined, env: Record<string, string | undefined> = process.env): URL | null {
  const value = (raw ?? '').trim()
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.username || url.password || url.search || url.hash) return null // no credentials, no query in the base: they would leak or be ignored
  if (url.protocol === 'https:') return url
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol === 'http:' && local && env.NODE_ENV !== 'production') return url
  return null
}

/** `Retry-After` as seconds: either a number of seconds or an HTTP-date. Anything else is null (the caller falls back to its own pause). */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  if (!value) return null
  const trimmed = value.trim()
  if (/^\d{1,6}$/.test(trimmed)) return Number(trimmed)
  if (!/[A-Za-z]{3}/.test(trimmed)) return null // an HTTP-date has month / day names; Date.parse would accept junk like "-5"
  const at = Date.parse(trimmed)
  if (!Number.isFinite(at)) return null
  return Math.max(0, Math.ceil((at - now) / 1000))
}

const flagOrDate = (v: unknown): { fecha: string | null } | null => (isObj(v) ? { fecha: shortText(v.fecha) } : v ? { fecha: null } : null)
const stageObject = (v: unknown): { completo: unknown; fecha: string | null } | null =>
  isObj(v) ? { completo: typeof v.completo === 'boolean' || typeof v.completo === 'string' ? v.completo : null, fecha: shortText(v.fecha) } : null

/**
 * Keeps ONLY what the classifier reads. Everything else (sender, recipient, amounts, contents, carrier names, receipt, ids…) is dropped here, so it can
 * neither be stored nor logged by anything downstream. `status.entregado` as an OBJECT is kept as `{ fecha }`: it is NOT a terminal signal by itself.
 */
export function minimizeSuccessBody(raw: unknown): Obj | null {
  if (!isObj(raw)) return null
  const data = isObj(raw.data) ? raw.data : raw
  const status = isObj(data.status) ? data.status : {}
  const order = isObj(data.order) ? data.order : {}
  const entregado = status.entregado
  const out: Obj = {
    status: {
      registrado: flagOrDate(status.registrado),
      origen: flagOrDate(status.origen),
      transito: stageObject(status.transito),
      destino: stageObject(status.destino),
      entregado: typeof entregado === 'boolean' || typeof entregado === 'string' ? entregado : isObj(entregado) ? { fecha: shortText(entregado.fecha) } : null,
      reparto: isObj(status.reparto) ? { fecha: shortText(status.reparto.fecha) } : status.reparto === true ? true : null,
      demora: isObj(status.demora) ? {} : status.demora === true ? true : null,
    },
    order: { entregado: typeof order.entregado === 'boolean' || typeof order.entregado === 'string' ? order.entregado : null },
    detailed: raw.detailed === true,
  }
  const reason = shortText(raw.degraded_reason, 60)
  if (reason) out.degraded_reason = reason
  return out
}

/** On an error status only the machine code survives (classify.ts reads `error.code`); the human message may carry anything. */
export function minimizeErrorBody(raw: unknown): Obj | null {
  if (!isObj(raw) || !isObj(raw.error)) return null
  const code = shortText(raw.error.code, 60)
  return code ? { error: { code } } : null
}

async function readLimitedText(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_CHARS) return null
  const text = await res.text()
  return text.length > MAX_BODY_CHARS ? null : text
}

export function createHttpShalomProvider(options: HttpProviderOptions): ShalomTrackingProvider {
  const base = options.baseUrl.trim().replace(/\/+$/, '')
  const doFetch = options.fetchImpl ?? fetch
  const { apiKey, email, password } = options

  return {
    name: 'shalom_http',
    async fetchTracking(query: TrackingQuery): Promise<ProviderResponse> {
      const url = `${base}/v1/tracking?${new URLSearchParams({ numero: query.numero, codigo: query.codigo }).toString()}`
      let res: Response
      let text: string | null
      try {
        res = await doFetch(url, {
          method: 'GET',
          redirect: 'manual',
          cache: 'no-store',
          signal: query.signal,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-API-Key': apiKey,
            'X-Shalom-Email': email,
            'X-Shalom-Password': password,
          },
        })
        text = await readLimitedText(res)
      } catch (error) {
        // Nothing of the error is propagated: its message may contain the URL. Only a machine code leaves.
        const aborted = query.signal?.aborted === true || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
        throw new ShalomProviderError(aborted ? 'timeout' : 'network')
      }

      const httpStatus = res.status
      const retryAfterSeconds = parseRetryAfter(res.headers.get('retry-after'))

      let parsed: unknown = null
      let invalidJson = false
      if (text === null) invalidJson = true
      else if (text.trim() !== '') {
        try {
          parsed = JSON.parse(text)
        } catch {
          invalidJson = true
        }
      } else invalidJson = true

      if (httpStatus >= 200 && httpStatus < 300) {
        const body = invalidJson ? null : minimizeSuccessBody(parsed)
        return body === null ? { httpStatus, body: null, invalidJson: true, retryAfterSeconds } : { httpStatus, body, retryAfterSeconds }
      }
      return { httpStatus, body: invalidJson ? null : minimizeErrorBody(parsed), retryAfterSeconds }
    },
  }
}
