// Meta Conversions API for Business Messaging (WhatsApp, ctwa_clid path). Official reference:
// https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging
//   POST https://graph.facebook.com/{version}/{DATASET_ID}/events   (Authorization: Bearer <token>)
//   event: event_name, event_time (unix s), action_source "business_messaging", messaging_channel "whatsapp",
//          user_data { whatsapp_business_account_id, ctwa_clid }, custom_data { currency, value }
// Meta does not deduplicate these events, so deduplication is done on our side (unique event_id in meta_capi_events).
// Never logs or returns the token, the ctwa_clid or Meta's free-text error message.

export interface CapiRow {
  event_name: string
  event_id: string
  ctwa_clid: string
  event_time: string
  value: number | string | null
  currency: string | null
  dataset_id: string
  waba_id: string
  api_version: string
  partner_agent: string
}

export type CapiOutcome =
  | { kind: 'sent'; httpStatus: number }
  | { kind: 'retry'; httpStatus: number | null; code: string; detail: string; retryAfterMs?: number }
  | { kind: 'rejected'; httpStatus: number; code: string; detail: string }
  | { kind: 'auth'; httpStatus: number; code: string; detail: string }

export function buildCapiBody(row: CapiRow) {
  const custom: Record<string, unknown> = {}
  if (row.value !== null && row.currency) {
    custom.currency = row.currency
    custom.value = Number(row.value)
  }
  return {
    data: [
      {
        event_name: row.event_name,
        event_time: Math.floor(new Date(row.event_time).getTime() / 1000),
        action_source: 'business_messaging',
        messaging_channel: 'whatsapp',
        user_data: { whatsapp_business_account_id: row.waba_id, ctwa_clid: row.ctwa_clid },
        ...(Object.keys(custom).length ? { custom_data: custom } : {}),
      },
    ],
    partner_agent: row.partner_agent,
  }
}

export function capiUrl(row: Pick<CapiRow, 'api_version' | 'dataset_id'>) {
  return `https://graph.facebook.com/${row.api_version}/${row.dataset_id}/events`
}

// Graph API error codes: 190 = invalid/expired token, 10 and 200-299 = missing permission, 4/17/32/613 = rate limits.
const AUTH_CODES = new Set([190, 10])
const RATE_CODES = new Set([4, 17, 32, 613])

export async function sendCapiEvent(row: CapiRow, token: string, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<CapiOutcome> {
  let res: Response
  try {
    res = await fetchImpl(capiUrl(row), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(buildCapiBody(row)),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return { kind: 'retry', httpStatus: null, code: 'network', detail: 'network error or timeout' }
  }
  if (res.ok) return { kind: 'sent', httpStatus: res.status }

  let gcode: number | null = null
  let sub: number | null = null
  try {
    const j = (await res.json()) as { error?: { code?: unknown; error_subcode?: unknown } }
    if (typeof j.error?.code === 'number') gcode = j.error.code
    if (typeof j.error?.error_subcode === 'number') sub = j.error.error_subcode
  } catch {
    /* body is not JSON: classify by status alone */
  }
  const detail = `http ${res.status}${gcode !== null ? ` code ${gcode}` : ''}${sub !== null ? ` sub ${sub}` : ''}`
  const code = gcode !== null ? `meta_${gcode}` : `http_${res.status}`

  if (res.status === 401 || res.status === 403 || (gcode !== null && (AUTH_CODES.has(gcode) || (gcode >= 200 && gcode <= 299)))) {
    return { kind: 'auth', httpStatus: res.status, code, detail }
  }
  if (res.status === 429 || res.status >= 500 || (gcode !== null && RATE_CODES.has(gcode))) {
    const ra = Number(res.headers.get('retry-after'))
    return { kind: 'retry', httpStatus: res.status, code, detail, retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined }
  }
  return { kind: 'rejected', httpStatus: res.status, code, detail }
}
