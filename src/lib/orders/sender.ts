import { buildInkaclickPayload, type OrderRow } from './payload'

// Server-to-server delivery of one confirmed order to InkaClick. The token is read from the environment by the caller and only ever goes in the
// Authorization header; it is never logged and never part of a returned detail. Error details are SANITISED: only a short machine code taken from
// the receiver's response (letters and underscores), never the body, so no customer name, DNI or phone reaches the logs or the history table.

export interface InkaclickConfig {
  url: string
  token: string
  timeoutMs?: number
}

export type SendOutcome =
  | { kind: 'sent'; httpStatus: number; inkaclickId: string }
  | { kind: 'retry'; httpStatus: number | null; code: string; detail: string; retryAfterMs?: number }
  | { kind: 'rejected'; httpStatus: number; code: string; detail: string }

const SAFE_CODE = /^[a-z][a-z0-9_]{0,59}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function receiverCode(body: unknown): string | null {
  const c = (body as { code?: unknown } | null)?.code
  return typeof c === 'string' && SAFE_CODE.test(c) ? c : null
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 3600) * 1000
  return undefined
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

export async function sendOrderToInkaclick(
  order: OrderRow,
  cfg: InkaclickConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<SendOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 10_000)
  try {
    const res = await fetchImpl(cfg.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.token}`,
        'idempotency-key': order.id,
      },
      body: JSON.stringify(buildInkaclickPayload(order)),
      signal: controller.signal,
    })
    const body = await readJson(res)
    const id = (body as { id?: unknown } | null)?.id

    if (res.status >= 200 && res.status < 300) {
      // HTTP success alone is not enough: the receiver must hand back the id of the row it holds.
      if (typeof id === 'string' && UUID.test(id)) return { kind: 'sent', httpStatus: res.status, inkaclickId: id }
      return { kind: 'retry', httpStatus: res.status, code: 'bad_receiver_response', detail: 'success without an order id' }
    }
    // 409 with an id = "already created" (idempotent replay): that is success, not a duplicate.
    if (res.status === 409 && typeof id === 'string' && UUID.test(id)) return { kind: 'sent', httpStatus: 409, inkaclickId: id }

    const code = receiverCode(body) ?? `http_${res.status}`
    if (res.status === 429 || res.status >= 500 || res.status === 408) {
      return { kind: 'retry', httpStatus: res.status, code, detail: `receiver answered ${res.status}`, retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) }
    }
    return { kind: 'rejected', httpStatus: res.status, code, detail: `receiver rejected the order (${res.status})` }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return { kind: 'retry', httpStatus: null, code: aborted ? 'timeout' : 'network_error', detail: aborted ? 'request timed out' : 'network error' }
  } finally {
    clearTimeout(timer)
  }
}

/** Reconciliation: does InkaClick hold this external id? Returns its row id, or null when it does not (or cannot be asked). */
export async function lookupInkaclickOrder(
  externalOrderId: string,
  cfg: InkaclickConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 10_000)
  try {
    const url = new URL(cfg.url)
    url.searchParams.set('external_order_id', externalOrderId)
    const res = await fetchImpl(url.toString(), { method: 'GET', headers: { authorization: `Bearer ${cfg.token}` }, signal: controller.signal })
    if (res.status !== 200) return null
    const id = ((await readJson(res)) as { id?: unknown } | null)?.id
    return typeof id === 'string' && UUID.test(id) ? id : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
