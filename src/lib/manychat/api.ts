/**
 * ManyChat Public API — server-side client.
 *
 * TEMPORARY bridge: while a WhatsApp number is still operated in
 * ManyChat (see src/app/api/integrations/manychat/inbound/route.ts for
 * the inbound half, and src/lib/whatsapp/send-message.ts for where
 * this is called from the outbound side), an agent's reply from the
 * WA CRM Inbox has to leave through ManyChat rather than Meta's Cloud
 * API directly.
 *
 * Two primitives:
 *   - `sendManyChatText` — the outbound bridge's original need. Request
 *     shape follows ManyChat's documented `sendContent` (dynamic
 *     content v2) envelope for WhatsApp:
 *       POST /fb/sending/sendContent
 *       { "subscriber_id": <integer, required>,
 *         "data": { "version": "v2",
 *                    "content": { "type": "whatsapp",
 *                                  "messages": [{ "type": "text", "text": "…" }] } } }
 *     (https://api.manychat.com/swagger#/Sending/post_fb_sending_sendContent).
 *   - `sendManyChatFlow` — the Flows media bridge (see
 *     src/lib/flows/meta-send.ts). ManyChat's Public API has no
 *     documented WhatsApp media send, so instead of sending media
 *     directly this triggers a ManyChat Automation Flow (authored
 *     manually in ManyChat, containing only the asset to relay) by its
 *     `flow_ns`:
 *       POST /fb/sending/sendFlow
 *       { "subscriber_id": <integer, required>, "flow_ns": "<string>" }
 *     (https://api.manychat.com/swagger#/Sending/post_fb_sending_sendFlow).
 *
 * Both share `subscriber_id` validation (positive, `Number.isSafeInteger`,
 * checked BEFORE any network call — see `toSubscriberId`) and the same
 * request/response handling (`postManyChatContent`): timeout via
 * AbortController, non-2xx → `ManyChatApiError`, and ManyChat's
 * documented success envelope `{ "status": "success" }` — a 2xx HTTP
 * status alone is never treated as success; the body's `status` field
 * must literally read `"success"`, or the call throws.
 * `sendManyChatText`'s `SendManyChatTextResult.raw` and
 * `sendManyChatFlow`'s `SendManyChatFlowResult.raw` carry no confirmed
 * message-id field, so callers must not assume one is present.
 */

const MANYCHAT_API_BASE = 'https://api.manychat.com'
const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Typed failure for a non-2xx response, a network error, or a timeout.
 * `body` is ManyChat's parsed JSON error body with the literal API key
 * redacted if it somehow appears in it (defense in depth — ManyChat has
 * no documented reason to echo the Authorization header back).
 */
export class ManyChatApiError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.name = 'ManyChatApiError'
    this.status = status
    this.body = body
  }
}

export interface SendManyChatTextArgs {
  /** MANYCHAT_API_KEY — never logged, never included in a thrown error. */
  apiKey: string
  /** The target subscriber's ManyChat contact id (manychat_contact_links.manychat_contact_id). */
  manyChatContactId: string
  text: string
  /** Abort the request after this many ms. Default 10000. */
  timeoutMs?: number
}

export interface SendManyChatTextResult {
  /**
   * Raw parsed JSON body ManyChat returned on success. Callers may look
   * for a message id opportunistically (`raw.message_id`,
   * `raw.data.message_id`) but must not assume one is present.
   */
  raw: unknown
}

function redactApiKey(value: string, apiKey: string): string {
  return apiKey ? value.split(apiKey).join('[redacted]') : value
}

/** Best-effort redaction of the literal API key from an error body before it's ever thrown/logged. */
function sanitizeErrorBody(body: unknown, apiKey: string): unknown {
  if (!apiKey) return body
  try {
    const serialized = JSON.stringify(body)
    if (!serialized || !serialized.includes(apiKey)) return body
    return JSON.parse(redactApiKey(serialized, apiKey))
  } catch {
    return typeof body === 'string' ? redactApiKey(body, apiKey) : body
  }
}

/**
 * ManyChat's `subscriber_id` is a required integer (their Public API
 * spec: `subscriber_id: integer`) — there is no documented string form.
 * Validate BEFORE any network call: a non-digit string, a non-positive
 * value, or a value outside `Number.isSafeInteger` range all fail here
 * rather than being sent as-is or silently coerced.
 */
function toSubscriberId(manyChatContactId: string): number {
  if (!/^\d+$/.test(manyChatContactId)) {
    throw new ManyChatApiError(
      400,
      `Invalid ManyChat contact id — expected a positive integer, got "${manyChatContactId}"`,
    )
  }
  const n = Number(manyChatContactId)
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new ManyChatApiError(
      400,
      `Invalid ManyChat contact id — not a positive safe integer: "${manyChatContactId}"`,
    )
  }
  return n
}

/**
 * Shared request/response handling for every ManyChat "sending" call:
 * POST with the Bearer auth + timeout, non-2xx → `ManyChatApiError`,
 * and ManyChat's `{ "status": "success" }` envelope check. Extracted so
 * `sendManyChatText` and `sendManyChatFlow` can't drift on error
 * handling or API-key redaction — every caller still does its OWN
 * argument validation (subscriber id, flow_ns, …) BEFORE calling this,
 * since that must happen before any network call.
 */
async function postManyChatContent(args: {
  apiKey: string
  path: string
  payload: Record<string, unknown>
  timeoutMs: number
}): Promise<unknown> {
  const { apiKey, path, payload, timeoutMs } = args

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  let response: Response
  try {
    response = await fetch(`${MANYCHAT_API_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ManyChatApiError(504, `ManyChat request timed out after ${timeoutMs}ms`)
    }
    throw new ManyChatApiError(
      502,
      `ManyChat request failed: ${err instanceof Error ? err.message : 'network error'}`,
    )
  } finally {
    clearTimeout(timeout)
  }

  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // Non-JSON body — response.ok still governs the outcome below.
  }

  if (!response.ok) {
    const sanitized = sanitizeErrorBody(body, apiKey)
    const message =
      sanitized &&
      typeof sanitized === 'object' &&
      'message' in sanitized &&
      typeof (sanitized as Record<string, unknown>).message === 'string'
        ? ((sanitized as Record<string, unknown>).message as string)
        : `ManyChat API error: HTTP ${response.status}`
    throw new ManyChatApiError(response.status, message, sanitized)
  }

  // A 2xx status alone isn't proof of success — ManyChat's own
  // documented envelope is `{ "status": "success" }` / `{ "status":
  // "error" }`. Require the field to say so explicitly; a 200 with an
  // unexpected or missing `status` is treated as a failure, not
  // silently accepted.
  const statusField =
    body && typeof body === 'object' && 'status' in body
      ? (body as Record<string, unknown>).status
      : undefined
  if (statusField !== 'success') {
    const sanitized = sanitizeErrorBody(body, apiKey)
    throw new ManyChatApiError(
      502,
      `ManyChat returned HTTP ${response.status} but did not confirm success (status: ${JSON.stringify(statusField)})`,
      sanitized,
    )
  }

  return body
}

/**
 * Send a WhatsApp text message through ManyChat's Public API, targeting
 * a subscriber by their ManyChat contact id.
 *
 * Never logs `apiKey` or the `Authorization` header. Throws
 * `ManyChatApiError` on: an invalid `manyChatContactId` (before any
 * network call), a non-2xx response, a 2xx response that doesn't
 * confirm `status: "success"`, a network failure, or a timeout — it
 * never returns a "failed" result, so a caller that awaits this
 * successfully can persist the message as sent.
 */
export async function sendManyChatText(
  args: SendManyChatTextArgs,
): Promise<SendManyChatTextResult> {
  const { apiKey, manyChatContactId, text, timeoutMs = DEFAULT_TIMEOUT_MS } = args

  // Validated BEFORE the fetch — an invalid id must never reach the
  // network call.
  const subscriberId = toSubscriberId(manyChatContactId)

  const body = await postManyChatContent({
    apiKey,
    path: '/fb/sending/sendContent',
    payload: {
      subscriber_id: subscriberId,
      data: {
        version: 'v2',
        content: {
          type: 'whatsapp',
          messages: [{ type: 'text', text }],
        },
      },
    },
    timeoutMs,
  })

  return { raw: body }
}

/**
 * ManyChat contact/subscriber ids are pure integers, but Flow
 * namespaces (`flow_ns`) are ManyChat-generated slugs. Their
 * documented shape is `content<alphanumeric>` — validated BEFORE any
 * network call, same discipline as `toSubscriberId`, so a typo'd or
 * empty value never reaches the network.
 */
const FLOW_NS_PATTERN = /^content[A-Za-z0-9_]+$/

function toFlowNs(flowNs: string): string {
  if (typeof flowNs !== 'string' || !FLOW_NS_PATTERN.test(flowNs)) {
    throw new ManyChatApiError(
      400,
      `Invalid ManyChat flow_ns — expected a "content..." identifier, got ${JSON.stringify(flowNs)}`,
    )
  }
  return flowNs
}

export interface SendManyChatFlowArgs {
  /** MANYCHAT_API_KEY — never logged, never included in a thrown error. */
  apiKey: string
  /** The target subscriber's ManyChat contact id (manychat_contact_links.manychat_contact_id). */
  manyChatContactId: string
  /** The ManyChat Automation Flow's namespace, e.g. "content2026abc123". */
  flowNs: string
  /** Abort the request after this many ms. Default 10000. */
  timeoutMs?: number
}

export interface SendManyChatFlowResult {
  /**
   * Raw parsed JSON body ManyChat returned on success. Callers may look
   * for a message id opportunistically (`raw.message_id`,
   * `raw.data.message_id`) but must not assume one is present.
   */
  raw: unknown
}

/**
 * Trigger a ManyChat Automation Flow for a subscriber — the TEMPORARY
 * media bridge (see src/lib/flows/meta-send.ts): ManyChat's Public API
 * has no documented WhatsApp media send, so a `send_media` Flow node
 * relays through a manually-authored ManyChat Flow (containing only the
 * asset) instead, identified by `flowNs`.
 *
 * Same guarantees as `sendManyChatText`: `manyChatContactId` and
 * `flowNs` are both validated BEFORE any network call; never logs
 * `apiKey`; throws `ManyChatApiError` on any non-success outcome
 * (invalid input, non-2xx, missing `status: "success"`, network
 * failure, or timeout) — never returns a "failed" result.
 */
export async function sendManyChatFlow(
  args: SendManyChatFlowArgs,
): Promise<SendManyChatFlowResult> {
  const { apiKey, manyChatContactId, flowNs, timeoutMs = DEFAULT_TIMEOUT_MS } = args

  const subscriberId = toSubscriberId(manyChatContactId)
  const validFlowNs = toFlowNs(flowNs)

  const body = await postManyChatContent({
    apiKey,
    path: '/fb/sending/sendFlow',
    payload: {
      subscriber_id: subscriberId,
      flow_ns: validFlowNs,
    },
    timeoutMs,
  })

  return { raw: body }
}
