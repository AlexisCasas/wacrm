import { isRecipientNotAllowedError, isValidE164, phoneVariants, sanitizePhoneForMeta } from '../whatsapp/phone-utils'
import type { EffectSender, OutboundPayload, OutboundRequest, SendOutcome } from './versioned-messaging'

/**
 * WhatsApp Cloud API adapter for the versioned runtime (E4.2C3.1). An `EffectSender` that talks to Meta ONLY through
 * an injected `HttpTransport`; this file has no `fetch`, no environment access and no credential lookup. Credentials
 * and the recipient come from an injected `resolveContext`. Nothing here is connected to a route, dispatcher or cron.
 *
 * The wire shapes are those of src/lib/whatsapp/meta-api.ts (`sendTextMessage` / `sendMediaMessage`); a contract test
 * runs both against a captured transport and compares them, so they cannot drift unnoticed.
 *
 * Classification (the rule the ledger depends on):
 *   accepted        2xx with a well-formed wamid
 *   rejected        Meta received the request and refused it (4xx with a verdict): definitive
 *   not_dispatched  PROVEN that no byte of any request left (the transport says so, or we never built a request)
 *   ambiguous       everything else once transmission may have started: timeouts, resets, aborts, lost or malformed
 *                   responses, 5xx, 408, a 2xx without a usable id. Never retried here.
 *
 * Recipient variants (legacy parity): the next variant is tried ONLY after a definitive "recipient not allowed"
 * rejection of the previous one. An ambiguous result on any variant stops the attempt immediately (no other
 * number is tried) and the variant is recorded in the error code for reconciliation.
 */

export const META_GRAPH_BASE_URL = 'https://graph.facebook.com/v21.0'

export interface HttpRequest { url: string; method: 'POST'; headers: Record<string, string>; body: string }
export interface HttpResponse { status: number; headers?: Record<string, string>; body: string }
export interface HttpTransport { post(request: HttpRequest): Promise<HttpResponse> }

/**
 * Thrown by a transport. `before_transmission` is a PROMISE that no byte of the request was written (invalid URL,
 * name resolution failed, connection refused before anything was sent). Any other error, typed or not, is treated as
 * ambiguous because the request may already have been received.
 */
export class HttpTransportError extends Error {
  constructor(message: string, readonly phase: 'before_transmission' | 'in_flight', readonly code: string = 'transport_error') {
    super(message)
    this.name = 'HttpTransportError'
  }
}

export type MetaSendContext =
  | { ok: true; phoneNumberId: string; accessToken: string; recipientPhone: string }
  /** `config_unavailable`: nothing can be sent yet (retryable). `recipient_unavailable`: the contact has no usable number (definitive). */
  | { ok: false; kind: 'config_unavailable' | 'recipient_unavailable'; code: string }

export interface MetaSenderEvent {
  type: 'request' | 'result'
  occurrenceKey: string
  attempt: number
  variantIndex: number
  variantCount: number
  /** `***1234`: never the full number, the token or the message content. */
  recipient: string
  httpStatus?: number
  metaCode?: number
  classification?: SendOutcome['kind']
  errorCode?: string
}

export interface MetaSenderOptions {
  transport: HttpTransport
  resolveContext(request: OutboundRequest): Promise<MetaSendContext>
  onEvent?: (event: MetaSenderEvent) => void
  /** Upper bound on recipient variants tried after "not allowed" rejections. Default: all of them (legacy parity). */
  maxVariants?: number
  /**
   * `attempt` also sends the attempt id as `biz_opaque_callback_data`, which Meta echoes in status webhooks and which
   * would let an ambiguous effect be reconciled automatically. Default `none` keeps the body identical to the legacy
   * sender until the field has been validated against the real API.
   */
  callbackData?: 'none' | 'attempt'
}

const WAMID = /^wamid\.[A-Za-z0-9+/=_-]{4,190}$/

export function buildMetaRequestBody(payload: OutboundPayload, to: string, attemptId?: string): Record<string, unknown> {
  const body: Record<string, unknown> = payload.kind === 'text'
    ? { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: payload.text } }
    : {
        messaging_product: 'whatsapp', recipient_type: 'individual', to, type: payload.media_type,
        [payload.media_type]: {
          link: payload.media_url,
          ...(payload.caption ? { caption: payload.caption } : {}),
          ...(payload.media_type === 'document' && payload.filename ? { filename: payload.filename } : {}),
        },
      }
  if (attemptId) body.biz_opaque_callback_data = attemptId
  return body
}

interface ParsedError { code?: number; message: string }
function parseBody(raw: string): unknown { try { return JSON.parse(raw) } catch { return undefined } }
function parseError(data: unknown): ParsedError {
  const e = data && typeof data === 'object' ? (data as { error?: { code?: unknown; message?: unknown } }).error : undefined
  return { code: typeof e?.code === 'number' ? e.code : undefined, message: typeof e?.message === 'string' ? e.message : '' }
}
const mask = (phone: string) => `***${phone.slice(-4)}`

/** Definitive refusal codes worth naming; anything else becomes `meta_<code>` / `http_<status>`. */
function rejectionCode(status: number, meta: ParsedError): string {
  if (status === 429 || meta.code === 131056 || meta.code === 130429 || meta.code === 80007) return 'rate_limited'
  if (status === 401 || meta.code === 190 || meta.code === 102) return 'auth_error'
  if (meta.code === 131047) return 'outside_window'
  if (meta.code === 131026) return 'undeliverable'
  if (meta.code === 131030 || isRecipientNotAllowedError(meta.message)) return 'recipient_not_allowed'
  return meta.code !== undefined ? `meta_${meta.code}` : `http_${status}`
}

export function createMetaEffectSender(options: MetaSenderOptions): EffectSender {
  const { transport, resolveContext, onEvent } = options
  const emit = (e: MetaSenderEvent) => { try { onEvent?.(e) } catch { /* logging must never change the outcome */ } }

  return {
    async send(request: OutboundRequest): Promise<SendOutcome> {
      let ctx: MetaSendContext
      try { ctx = await resolveContext(request) } catch { return { kind: 'not_dispatched', errorCode: 'context_error' } }   // no request existed
      if (!ctx.ok) return ctx.kind === 'recipient_unavailable' ? { kind: 'rejected', errorCode: ctx.code } : { kind: 'not_dispatched', errorCode: ctx.code }

      const sanitized = sanitizePhoneForMeta(ctx.recipientPhone)
      if (!isValidE164(sanitized)) return { kind: 'rejected', errorCode: 'invalid_recipient' }            // nothing was built or sent
      const all = phoneVariants(sanitized)
      const variants = all.slice(0, Math.max(1, options.maxVariants ?? all.length))

      for (let i = 0; i < variants.length; i++) {
        const to = variants[i]
        const base = { occurrenceKey: request.occurrenceKey, attempt: request.attempt, variantIndex: i, variantCount: variants.length, recipient: mask(to) }
        const http: HttpRequest = {
          url: `${META_GRAPH_BASE_URL}/${ctx.phoneNumberId}/messages`, method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.accessToken}` },
          body: JSON.stringify(buildMetaRequestBody(request.payload, to, options.callbackData === 'attempt' ? request.attemptId : undefined)),
        }
        emit({ type: 'request', ...base })

        let res: HttpResponse
        try {
          res = await transport.post(http)
        } catch (e) {
          if (e instanceof HttpTransportError && e.phase === 'before_transmission') {
            emit({ type: 'result', ...base, classification: 'not_dispatched', errorCode: e.code })
            return { kind: 'not_dispatched', errorCode: `${e.code}@v${i}`.slice(0, 60) }
          }
          const code = e instanceof HttpTransportError ? e.code : 'transport_unknown'
          emit({ type: 'result', ...base, classification: 'ambiguous', errorCode: code })
          return { kind: 'ambiguous', errorCode: `${code}@v${i}`.slice(0, 60) }                           // never try another variant
        }

        const data = parseBody(res.body)
        if (res.status >= 200 && res.status < 300) {
          const id = data && typeof data === 'object' ? (data as { messages?: Array<{ id?: unknown }> }).messages?.[0]?.id : undefined
          if (typeof id === 'string' && WAMID.test(id)) {
            emit({ type: 'result', ...base, httpStatus: res.status, classification: 'accepted' })
            return { kind: 'accepted', providerMessageId: id }
          }
          emit({ type: 'result', ...base, httpStatus: res.status, classification: 'ambiguous', errorCode: 'accepted_without_wamid' })
          return { kind: 'ambiguous', errorCode: `accepted_without_wamid@v${i}`.slice(0, 60) }
        }

        const meta = parseError(data)
        const definitive = res.status >= 400 && res.status < 500 && res.status !== 408
        if (!definitive) {
          const code = `http_${res.status}`
          emit({ type: 'result', ...base, httpStatus: res.status, metaCode: meta.code, classification: 'ambiguous', errorCode: code })
          return { kind: 'ambiguous', errorCode: `${code}@v${i}` }                                         // 5xx / 408 / 3xx: Meta may have processed it
        }
        const code = rejectionCode(res.status, meta)
        emit({ type: 'result', ...base, httpStatus: res.status, metaCode: meta.code, classification: 'rejected', errorCode: code })
        if (code === 'recipient_not_allowed' && i < variants.length - 1) continue                          // the only reason to try another number
        return { kind: 'rejected', errorCode: code }
      }
      return { kind: 'rejected', errorCode: 'invalid_recipient' }
    },
  }
}
