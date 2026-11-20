import {
  MetaApiError,
  messagingAccountField,
  parseRetryAfterSeconds,
} from './meta-api'

/**
 * Keep Calling on a current Graph API version without changing the
 * existing WhatsApp messaging version used by the rest of WACRM.
 * Upgrade this independently after checking Meta's version support.
 */
export const META_CALLING_API_VERSION = process.env.WHATSAPP_CALLING_API_VERSION ?? 'v27.0'

const META_CALLING_API_BASE = `https://graph.facebook.com/${META_CALLING_API_VERSION}`

export interface WhatsAppCallOffer {
  sdp_type: 'offer'
  sdp: string
}

export interface WhatsAppCallAnswer {
  sdp_type: 'answer'
  sdp: string
}

interface CallActionMetadata {
  bizOpaqueCallbackData?: string
}

export type WhatsAppCallAction =
  | ({
      action: 'connect'
      /** E.164 phone number. The leading + is removed before sending to Meta. */
      to: string
      session: WhatsAppCallOffer
    } & CallActionMetadata)
  | ({
      action: 'pre_accept' | 'accept'
      callId: string
      session: WhatsAppCallAnswer
    } & CallActionMetadata)
  | ({
      action: 'reject' | 'terminate'
      callId: string
    } & CallActionMetadata)

export interface WhatsAppCallActionArgs {
  phoneNumberId: string
  accessToken: string
  messagingAccountId?: string | null
  action: WhatsAppCallAction
}

export type WhatsAppCallActionResult =
  | { action: 'connect'; callId: string }
  | { action: 'pre_accept' | 'accept' | 'reject' | 'terminate'; success: true }

interface MetaCallingErrorResponse {
  error?: {
    message?: string
    code?: number
    error_subcode?: number
    type?: string
    fbtrace_id?: string
    error_data?: unknown
  }
}

interface MetaCallingSuccessResponse {
  success?: boolean
  calls?: Array<{ id?: string }>
}

/** Parse Meta's error envelope without logging or returning credentials or SDP. */
async function throwCallingMetaError(response: Response): Promise<never> {
  let error: MetaCallingErrorResponse['error']

  try {
    error = (await response.json() as MetaCallingErrorResponse)?.error
  } catch {
    // Keep a safe fallback for non-JSON responses.
  }

  throw new MetaApiError({
    message: error?.message ?? `Meta WhatsApp Calling API error: ${response.status}`,
    code: error?.code,
    errorSubcode: error?.error_subcode,
    type: error?.type,
    httpStatus: response.status,
    retryAfterSeconds: parseRetryAfterSeconds(response.headers.get('retry-after')),
    fbtraceId: error?.fbtrace_id,
    errorData: error?.error_data,
  })
}

function normalizeCallPhoneNumber(value: string): string {
  const normalized = value.trim().replace(/^\+/, '')
  if (!/^\d{6,20}$/.test(normalized)) {
    throw new Error('WhatsApp call recipient must be an E.164 phone number.')
  }
  return normalized
}

function validateCallId(value: string): string {
  const normalized = value.trim()
  if (!/^wacid\.[A-Za-z0-9._~+/=-]{1,512}$/.test(normalized)) {
    throw new Error('WhatsApp call ID is invalid.')
  }
  return normalized
}

function validateSession<T extends WhatsAppCallOffer | WhatsAppCallAnswer>(
  session: T,
  expectedType: T['sdp_type'],
): T {
  if (
    !session ||
    session.sdp_type !== expectedType ||
    typeof session.sdp !== 'string' ||
    session.sdp.length === 0 ||
    session.sdp.length > 65_536 ||
    !/^v=0(?:\r?\n)/.test(session.sdp)
  ) {
    throw new Error(`A valid SDP ${expectedType} is required for this WhatsApp call action.`)
  }
  return session
}

function validateCallbackData(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\u0000-\u001f]/.test(value)) {
    throw new Error('WhatsApp call callback data must contain 1-512 printable characters.')
  }
  return value
}

/**
 * Execute one Meta WhatsApp Calling signaling action.
 *
 * This helper performs signaling only. A browser WebRTC PeerConnection (or
 * another supported media stack) must create the SDP offer/answer; this
 * function never creates, transforms, stores, or logs SDP.
 */
export async function callWhatsApp(
  args: WhatsAppCallActionArgs,
): Promise<WhatsAppCallActionResult> {
  const phoneNumberId = args.phoneNumberId.trim()
  if (!/^\d{5,25}$/.test(phoneNumberId)) {
    throw new Error('WhatsApp phone_number_id is invalid.')
  }
  if (typeof args.accessToken !== 'string' || args.accessToken.trim() === '') {
    throw new Error('WhatsApp access token is required.')
  }

  const payload: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    action: args.action.action,
    ...messagingAccountField(args.messagingAccountId),
  }

  const callbackData = validateCallbackData(args.action.bizOpaqueCallbackData)
  if (callbackData !== undefined) payload.biz_opaque_callback_data = callbackData

  switch (args.action.action) {
    case 'connect': {
      payload.to = normalizeCallPhoneNumber(args.action.to)
      payload.session = validateSession(args.action.session, 'offer')
      break
    }
    case 'pre_accept':
    case 'accept': {
      payload.call_id = validateCallId(args.action.callId)
      payload.session = validateSession(args.action.session, 'answer')
      break
    }
    case 'reject':
    case 'terminate': {
      payload.call_id = validateCallId(args.action.callId)
      break
    }
  }

  const response = await fetch(`${META_CALLING_API_BASE}/${phoneNumberId}/calls`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.accessToken}`,
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    await throwCallingMetaError(response)
  }

  let data: MetaCallingSuccessResponse
  try {
    data = await response.json() as MetaCallingSuccessResponse
  } catch {
    throw new Error('Meta WhatsApp Calling API returned an invalid response.')
  }

  if (args.action.action === 'connect') {
    const callId = data.calls?.[0]?.id
    if (typeof callId !== 'string' || !callId.startsWith('wacid.')) {
      throw new Error('Meta WhatsApp Calling API did not return a call ID.')
    }
    return { action: 'connect', callId }
  }

  if (data.success !== true) {
    throw new Error('Meta WhatsApp Calling API did not confirm the call action.')
  }

  return { action: args.action.action, success: true }
}

export interface WhatsAppCallPermission {
  status: 'no_permission' | 'temporary' | 'permanent'
  expirationTime?: number
  canStartCall: boolean
  canRequestPermission: boolean
  actions: Array<{
    actionName: string
    canPerformAction: boolean
    limits: Array<{
      timePeriod: string
      maxAllowed: number
      currentUsage: number
      limitExpirationTime?: number
    }>
  }>
}

interface MetaCallPermissionResponse {
  permission?: { status?: string; expiration_time?: number }
  actions?: Array<{
    action_name?: string
    can_perform_action?: boolean
    limits?: Array<{
      time_period?: string
      max_allowed?: number
      current_usage?: number
      limit_expiration_time?: number
    }>
  }>
}

function normalizePermissionTarget(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256 || !/^[A-Za-z0-9._~+/-]+$/.test(normalized)) {
    throw new Error(`WhatsApp call permission ${label} is invalid.`)
  }
  return normalized
}

/** Read Meta's authoritative permission and current action quotas for one customer. */
export async function getWhatsAppCallPermission(args: {
  phoneNumberId: string
  accessToken: string
  userWaId?: string
  recipient?: string
}): Promise<WhatsAppCallPermission> {
  if (!/^\d{5,25}$/.test(args.phoneNumberId.trim())) throw new Error('WhatsApp phone_number_id is invalid.')
  if (Boolean(args.userWaId) === Boolean(args.recipient)) {
    throw new Error('Provide exactly one WhatsApp user phone or BSUID.')
  }
  const params = new URLSearchParams()
  if (args.userWaId) params.set('user_wa_id', normalizeCallPhoneNumber(args.userWaId))
  if (args.recipient) params.set('recipient', normalizePermissionTarget(args.recipient, 'recipient'))
  const response = await fetch(`${META_CALLING_API_BASE}/${args.phoneNumberId}/call_permissions?${params.toString()}`, {
    headers: { Authorization: `Bearer ${args.accessToken}` },
  })
  if (!response.ok) await throwCallingMetaError(response)
  const data = await response.json() as MetaCallPermissionResponse
  const rawStatus = data.permission?.status
  if (rawStatus !== 'no_permission' && rawStatus !== 'temporary' && rawStatus !== 'permanent') {
    throw new Error('Meta returned an unknown WhatsApp call permission status.')
  }
  const actions = (data.actions ?? []).flatMap((item) => {
    if (typeof item.action_name !== 'string' || typeof item.can_perform_action !== 'boolean') return []
    return [{
      actionName: item.action_name,
      canPerformAction: item.can_perform_action,
      limits: (item.limits ?? []).flatMap((limit) => {
        if (typeof limit.time_period !== 'string' || typeof limit.max_allowed !== 'number' || typeof limit.current_usage !== 'number') return []
        return [{
          timePeriod: limit.time_period,
          maxAllowed: limit.max_allowed,
          currentUsage: limit.current_usage,
          ...(typeof limit.limit_expiration_time === 'number' ? { limitExpirationTime: limit.limit_expiration_time } : {}),
        }]
      }),
    }]
  })
  return {
    status: rawStatus,
    ...(typeof data.permission?.expiration_time === 'number' ? { expirationTime: data.permission.expiration_time } : {}),
    canStartCall: actions.find((item) => item.actionName === 'start_call')?.canPerformAction ?? false,
    canRequestPermission: actions.find((item) => item.actionName === 'send_call_permission_request')?.canPerformAction ?? false,
    actions,
  }
}

/** Send the Meta free-form interactive call-permission request (requires an open customer-service window). */
export async function sendWhatsAppCallPermissionRequest(args: {
  phoneNumberId: string
  accessToken: string
  userWaId?: string
  recipient?: string
  messagingAccountId?: string | null
  bodyText?: string
}): Promise<{ messageId: string }> {
  if (!/^\d{5,25}$/.test(args.phoneNumberId.trim())) throw new Error('WhatsApp phone_number_id is invalid.')
  if (Boolean(args.userWaId) === Boolean(args.recipient)) {
    throw new Error('Provide exactly one WhatsApp user phone or BSUID.')
  }
  const bodyText = args.bodyText?.trim()
  if (bodyText && bodyText.length > 1024) throw new Error('Call permission request body exceeds 1024 characters.')
  const payload: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    ...messagingAccountField(args.messagingAccountId),
    ...(args.userWaId ? { to: normalizeCallPhoneNumber(args.userWaId) } : {}),
    ...(args.recipient ? { recipient: normalizePermissionTarget(args.recipient, 'recipient') } : {}),
    type: 'interactive',
    interactive: {
      type: 'call_permission_request',
      action: { name: 'call_permission_request' },
      ...(bodyText ? { body: { text: bodyText } } : {}),
    },
  }
  const response = await fetch(`${META_CALLING_API_BASE}/${args.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.accessToken}`,
    },
    body: JSON.stringify(payload),
  })
  if (!response.ok) await throwCallingMetaError(response)
  const data = await response.json() as { messages?: Array<{ id?: string }> }
  const messageId = data.messages?.[0]?.id
  if (typeof messageId !== 'string' || !messageId.startsWith('wamid.')) {
    throw new Error('Meta did not return a message ID for the call permission request.')
  }
  return { messageId }
}
