import { MetaApiError } from './meta-api'

/**
 * Diagnostics for failed outbound Meta sends. DIAGNOSTIC ONLY: nothing in the send path decides anything from this (no retries,
 * no change of semantics). It exists because Node's `fetch` rejects every network-level failure with a `TypeError` whose message is
 * always the useless text "fetch failed"; the real reason lives in `error.cause` (and sometimes in `cause.errors[]`).
 *
 * The output is a whitelist of short, safe fields. It NEVER contains an error message, a URL, a header, a token, a body or a
 * phone number: only upper-case error codes (`ECONNRESET`, `UND_ERR_HEADERS_TIMEOUT`, ...), the syscall name, an HTTP status and
 * Meta's own numeric/trace identifiers.
 *
 * `sent_state` says whether Meta can possibly have accepted the message:
 *   - `not_sent`: the failure happened before the request reached Meta (DNS, refused/unreachable connection, connect timeout, TLS
 *     handshake) or Meta answered with a definite rejection (4xx).
 *   - `unknown`: the request may have been written; Meta may or may not have processed it (reset/timeout after writing, 5xx,
 *     anything we cannot classify). Callers must treat this as "possibly delivered".
 *   - `sent`: Meta accepted the message but a later step failed (the message exists on WhatsApp).
 */
export type SendErrorClass =
  | 'dns'
  | 'connect'
  | 'tls'
  | 'timeout'
  | 'socket_reset'
  | 'network_unknown'
  | 'meta_http'
  | 'sent_persist_failed'
  | 'other'

export type SendSentState = 'not_sent' | 'unknown' | 'sent'

export interface SendErrorDiagnostics {
  error_class: SendErrorClass
  sent_state: SendSentState
  /** Safe error code found in the cause chain (e.g. ECONNRESET). */
  cause_code?: string
  /** Constructor name of the innermost cause (e.g. SocketError, ConnectTimeoutError). */
  cause_name?: string
  syscall?: string
  http_status?: number
  meta_code?: number
  meta_subcode?: number
  fbtrace_id?: string
  retry_after_s?: number
  /** Milliseconds between starting the send and the failure. */
  elapsed_ms?: number
  /** Seconds the Node process had been up when the send failed (flags failures right after a restart). */
  process_uptime_s?: number
}

const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const SAFE_TRACE = /^[A-Za-z0-9_\-+/=]{1,64}$/
const MAX_DEPTH = 4

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA', 'EAI_NONAME'])
const CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
])
const TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_REQUEST_TIMEOUT', 'ETIMEDOUT'])
const RESET_CODES = new Set(['ECONNRESET', 'ECONNABORTED', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'UND_ERR_DESTROYED'])
const TLS_PREFIXES = ['ERR_TLS_', 'ERR_SSL_', 'CERT_', 'DEPTH_ZERO_', 'UNABLE_TO_VERIFY', 'SELF_SIGNED', 'HPE_']

interface CauseInfo {
  code?: string
  name?: string
  syscall?: string
}

function safeCode(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : undefined
}

function safeName(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_NAME.test(value) ? value : undefined
}

/** Walk `error.cause` (and the first `errors[]` entry of an AggregateError) collecting the first safe code and the innermost name. */
function readCauseChain(error: unknown): CauseInfo {
  const info: CauseInfo = {}
  let current: unknown = error
  for (let depth = 0; depth < MAX_DEPTH && current && typeof current === 'object'; depth += 1) {
    const record = current as { code?: unknown; name?: unknown; syscall?: unknown; cause?: unknown; errors?: unknown }
    if (!info.code) info.code = safeCode(record.code)
    if (!info.syscall && typeof record.syscall === 'string' && SAFE_NAME.test(record.syscall)) info.syscall = record.syscall
    if (depth > 0) info.name = safeName(record.name) ?? info.name
    let next: unknown = record.cause
    if (!next && Array.isArray(record.errors) && record.errors.length > 0) next = record.errors[0]
    current = next
  }
  return info
}

function classifyCode(code: string | undefined, syscall: string | undefined): { cls: SendErrorClass; state: SendSentState } | null {
  if (!code) return null
  if (DNS_CODES.has(code)) return { cls: 'dns', state: 'not_sent' }
  if (CONNECT_CODES.has(code)) return { cls: 'connect', state: 'not_sent' }
  // A TCP connect that times out reports ETIMEDOUT with syscall "connect": the request was never written.
  if (code === 'ETIMEDOUT' && syscall === 'connect') return { cls: 'connect', state: 'not_sent' }
  if (TLS_PREFIXES.some((prefix) => code.startsWith(prefix))) return { cls: 'tls', state: 'not_sent' }
  if (TIMEOUT_CODES.has(code)) return { cls: 'timeout', state: 'unknown' }
  if (RESET_CODES.has(code)) return { cls: 'socket_reset', state: 'unknown' }
  return null
}

/**
 * Describe a failed send. `startedAtMs` is `Date.now()` taken right before the send; when given, the elapsed time is included.
 * Never throws.
 */
export function describeSendError(error: unknown, startedAtMs?: number): SendErrorDiagnostics {
  const extra: Pick<SendErrorDiagnostics, 'elapsed_ms' | 'process_uptime_s'> = {}
  if (typeof startedAtMs === 'number') extra.elapsed_ms = Math.max(0, Date.now() - startedAtMs)
  try {
    extra.process_uptime_s = Math.round(process.uptime())
  } catch {
    // process.uptime is unavailable in some runtimes; the field is optional.
  }

  try {
    if (error instanceof MetaApiError) {
      const status = error.httpStatus
      return {
        error_class: 'meta_http',
        // A definite 4xx rejection means Meta did not accept the message; 5xx is ambiguous.
        sent_state: status >= 400 && status < 500 ? 'not_sent' : 'unknown',
        http_status: status,
        ...(typeof error.code === 'number' ? { meta_code: error.code } : {}),
        ...(typeof error.errorSubcode === 'number' ? { meta_subcode: error.errorSubcode } : {}),
        ...(typeof error.fbtraceId === 'string' && SAFE_TRACE.test(error.fbtraceId) ? { fbtrace_id: error.fbtraceId } : {}),
        ...(typeof error.retryAfterSeconds === 'number' ? { retry_after_s: error.retryAfterSeconds } : {}),
        ...extra,
      }
    }

    if (error instanceof Error && error.message.startsWith('sent to Meta but DB insert failed')) {
      return { error_class: 'sent_persist_failed', sent_state: 'sent', ...extra }
    }

    const chain = readCauseChain(error)
    const verdict = classifyCode(chain.code, chain.syscall)
    const errorName = error && typeof error === 'object' ? safeName((error as { name?: unknown }).name) : undefined
    const base = {
      ...(chain.code ? { cause_code: chain.code } : {}),
      ...(chain.name ? { cause_name: chain.name } : {}),
      ...(chain.syscall ? { syscall: chain.syscall } : {}),
      ...extra,
    }
    if (verdict) return { error_class: verdict.cls, sent_state: verdict.state, ...base }

    if (errorName === 'AbortError' || errorName === 'TimeoutError') {
      return { error_class: 'timeout', sent_state: 'unknown', ...base }
    }
    // Node's fetch signals every network failure with TypeError("fetch failed") and puts the reason in `cause`.
    if (error instanceof TypeError && error.message === 'fetch failed') {
      return { error_class: 'network_unknown', sent_state: 'unknown', ...base }
    }
    return { error_class: 'other', sent_state: 'unknown', ...base }
  } catch {
    return { error_class: 'other', sent_state: 'unknown', ...extra }
  }
}
