type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown, maxLength = 4096): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    ? value
    : undefined
}

function readTimestamp(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0 && value.length <= 32) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

export interface WhatsAppCallingSession {
  sdp_type: 'offer' | 'answer'
  sdp: string
}

export interface WhatsAppCallingContact {
  profile?: {
    name?: string
    username?: string
  }
  wa_id?: string
  user_id?: string
  parent_user_id?: string
}

export interface WhatsAppCallingEvent {
  id: string
  event: string
  timestamp: string
  direction?: 'USER_INITIATED' | 'BUSINESS_INITIATED'
  from?: string
  to?: string
  from_user_id?: string
  to_user_id?: string
  from_parent_user_id?: string
  to_parent_user_id?: string
  session?: WhatsAppCallingSession
  status?: string
  start_time?: string
  end_time?: string
  duration?: number
  biz_opaque_callback_data?: string
  error_codes?: number[]
}

export interface WhatsAppCallingStatus {
  id: string
  status: string
  timestamp: string
  recipient_id?: string
  recipient_user_id?: string
  recipient_parent_user_id?: string
  type?: string
  biz_opaque_callback_data?: string
}

export interface ParsedWhatsAppCallingWebhook {
  phoneNumberId: string
  contacts: WhatsAppCallingContact[]
  calls: WhatsAppCallingEvent[]
  statuses: WhatsAppCallingStatus[]
}

function parseContact(value: unknown): WhatsAppCallingContact | null {
  if (!isRecord(value)) return null
  const profileValue = isRecord(value.profile) ? value.profile : undefined
  const profile = profileValue
    ? {
        ...(readString(profileValue.name, 256) ? { name: readString(profileValue.name, 256) } : {}),
        ...(readString(profileValue.username, 256) ? { username: readString(profileValue.username, 256) } : {}),
      }
    : undefined

  return {
    ...(profile && Object.keys(profile).length > 0 ? { profile } : {}),
    ...(readString(value.wa_id, 256) ? { wa_id: readString(value.wa_id, 256) } : {}),
    ...(readString(value.user_id, 256) ? { user_id: readString(value.user_id, 256) } : {}),
    ...(readString(value.parent_user_id, 256) ? { parent_user_id: readString(value.parent_user_id, 256) } : {}),
  }
}

function parseCall(value: unknown): WhatsAppCallingEvent | null {
  if (!isRecord(value)) return null
  const id = readString(value.id, 512)
  const event = readString(value.event, 64)
  const timestamp = readTimestamp(value.timestamp)
  if (!id || !event || !timestamp) return null

  const sessionValue = isRecord(value.session) ? value.session : undefined
  const sessionType = sessionValue?.sdp_type
  const sessionSdp = readString(sessionValue?.sdp, 65_536)
  const session =
    (sessionType === 'offer' || sessionType === 'answer') && sessionSdp
      ? { sdp_type: sessionType, sdp: sessionSdp } as WhatsAppCallingSession
      : undefined

  const direction =
    value.direction === 'USER_INITIATED' || value.direction === 'BUSINESS_INITIATED'
      ? value.direction
      : undefined

  const errorCodes = Array.isArray(value.errors)
    ? value.errors.flatMap((item) => {
        if (!isRecord(item) || typeof item.code !== 'number' || !Number.isInteger(item.code)) return []
        return [item.code]
      }).slice(0, 10)
    : undefined

  return {
    id,
    event,
    timestamp,
    ...(direction ? { direction } : {}),
    ...(readString(value.from, 256) ? { from: readString(value.from, 256) } : {}),
    ...(readString(value.to, 256) ? { to: readString(value.to, 256) } : {}),
    ...(readString(value.from_user_id, 256) ? { from_user_id: readString(value.from_user_id, 256) } : {}),
    ...(readString(value.to_user_id, 256) ? { to_user_id: readString(value.to_user_id, 256) } : {}),
    ...(readString(value.from_parent_user_id, 256) ? { from_parent_user_id: readString(value.from_parent_user_id, 256) } : {}),
    ...(readString(value.to_parent_user_id, 256) ? { to_parent_user_id: readString(value.to_parent_user_id, 256) } : {}),
    ...(session ? { session } : {}),
    ...(readString(value.status, 64) ? { status: readString(value.status, 64) } : {}),
    ...(readTimestamp(value.start_time) ? { start_time: readTimestamp(value.start_time) } : {}),
    ...(readTimestamp(value.end_time) ? { end_time: readTimestamp(value.end_time) } : {}),
    ...(typeof value.duration === 'number' && Number.isFinite(value.duration) && value.duration >= 0
      ? { duration: value.duration }
      : {}),
    ...(readString(value.biz_opaque_callback_data, 512)
      ? { biz_opaque_callback_data: readString(value.biz_opaque_callback_data, 512) }
      : {}),
    ...(errorCodes && errorCodes.length > 0 ? { error_codes: errorCodes } : {}),
  }
}

function parseStatus(value: unknown): WhatsAppCallingStatus | null {
  if (!isRecord(value)) return null
  const id = readString(value.id, 512)
  const status = readString(value.status, 64)
  const timestamp = readTimestamp(value.timestamp)
  if (!id || !status || !timestamp) return null

  return {
    id,
    status,
    timestamp,
    ...(readString(value.recipient_id, 256) ? { recipient_id: readString(value.recipient_id, 256) } : {}),
    ...(readString(value.recipient_user_id, 256) ? { recipient_user_id: readString(value.recipient_user_id, 256) } : {}),
    ...(readString(value.recipient_parent_user_id, 256) ? { recipient_parent_user_id: readString(value.recipient_parent_user_id, 256) } : {}),
    ...(readString(value.type, 32) ? { type: readString(value.type, 32) } : {}),
    ...(readString(value.biz_opaque_callback_data, 512)
      ? { biz_opaque_callback_data: readString(value.biz_opaque_callback_data, 512) }
      : {}),
  }
}

/**
 * Parse only a WhatsApp Business Account change with field="calls".
 * Invalid or unrouteable envelopes fail closed (null); raw payloads and
 * SDP are never logged by this module.
 */
export function parseWhatsAppCallingWebhookChange(
  change: unknown,
): ParsedWhatsAppCallingWebhook | null {
  if (!isRecord(change) || change.field !== 'calls' || !isRecord(change.value)) return null

  const value = change.value
  const metadata = isRecord(value.metadata) ? value.metadata : undefined
  const phoneNumberId = readString(metadata?.phone_number_id, 64)
  if (!phoneNumberId || !/^\d{5,25}$/.test(phoneNumberId)) return null

  const contacts = Array.isArray(value.contacts)
    ? value.contacts.flatMap((item) => {
        const parsed = parseContact(item)
        return parsed ? [parsed] : []
      }).slice(0, 20)
    : []

  const calls = Array.isArray(value.calls)
    ? value.calls.flatMap((item) => {
        const parsed = parseCall(item)
        return parsed ? [parsed] : []
      }).slice(0, 20)
    : []

  const statuses = Array.isArray(value.statuses)
    ? value.statuses.flatMap((item) => {
        const parsed = parseStatus(item)
        return parsed ? [parsed] : []
      }).slice(0, 20)
    : []

  if (calls.length === 0 && statuses.length === 0) return null

  return { phoneNumberId, contacts, calls, statuses }
}

export interface WhatsAppCallPermissionReply {
  response: 'accept' | 'reject'
  is_permanent?: boolean
  expiration_timestamp?: string
  response_source?: string
  from?: string
  from_user_id?: string
  from_parent_user_id?: string
  message_id?: string
  timestamp?: string
  context_message_id?: string
}

/**
 * Extract the call-permission reply embedded in a normal messages webhook.
 * A temporary approval carries expiration_timestamp; a permanent approval
 * carries is_permanent=true. Callers must treat missing/expired permission
 * as not authorized and must not infer permission from a generic message.
 */
export function parseWhatsAppCallPermissionReply(
  message: unknown,
): WhatsAppCallPermissionReply | null {
  if (!isRecord(message) || message.type !== 'interactive' || !isRecord(message.interactive)) return null
  const interactive = message.interactive
  if (interactive.type !== 'call_permission_reply' || !isRecord(interactive.call_permission_reply)) return null

  const reply = interactive.call_permission_reply
  if (reply.response !== 'accept' && reply.response !== 'reject') return null

  const expirationTimestamp = readTimestamp(reply.expiration_timestamp)
  const context = isRecord(message.context) ? message.context : undefined

  return {
    response: reply.response,
    ...(typeof reply.is_permanent === 'boolean' ? { is_permanent: reply.is_permanent } : {}),
    ...(expirationTimestamp ? { expiration_timestamp: expirationTimestamp } : {}),
    ...(readString(reply.response_source, 64) ? { response_source: readString(reply.response_source, 64) } : {}),
    ...(readString(message.from, 256) ? { from: readString(message.from, 256) } : {}),
    ...(readString(message.from_user_id, 256) ? { from_user_id: readString(message.from_user_id, 256) } : {}),
    ...(readString(message.from_parent_user_id, 256) ? { from_parent_user_id: readString(message.from_parent_user_id, 256) } : {}),
    ...(readString(message.id, 512) ? { message_id: readString(message.id, 512) } : {}),
    ...(readTimestamp(message.timestamp) ? { timestamp: readTimestamp(message.timestamp) } : {}),
    ...(readString(context?.id, 512) ? { context_message_id: readString(context?.id, 512) } : {}),
  }
}
