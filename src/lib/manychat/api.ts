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
 * Implements only `sendManyChatText` — the single call the outbound
 * bridge needs today. Request shape follows ManyChat's documented
 * `sendContent` (dynamic content v2) envelope for WhatsApp:
 *   POST /fb/sending/sendContent
 *   { "subscriber_id": <integer, required>,
 *     "data": { "version": "v2",
 *                "content": { "type": "whatsapp",
 *                              "messages": [{ "type": "text", "text": "…" }] } } }
 * (https://api.manychat.com/swagger#/Sending/post_fb_sending_sendContent).
 * `subscriber_id` is validated as a positive, `Number.isSafeInteger`
 * value BEFORE any network call — see `toSubscriberId`.
 *
 * ManyChat's documented success envelope is `{ "status": "success" }`,
 * with no confirmed message-id field, so callers must not assume one —
 * see `SendManyChatTextResult.raw`. A 2xx HTTP status alone is not
 * treated as success: the body's `status` field must literally read
 * `"success"`, or the call throws `ManyChatApiError`.
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

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  let response: Response
  try {
    response = await fetch(`${MANYCHAT_API_BASE}/fb/sending/sendContent`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        subscriber_id: subscriberId,
        data: {
          version: 'v2',
          content: {
            type: 'whatsapp',
            messages: [{ type: 'text', text }],
          },
        },
      }),
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

  return { raw: body }
}
