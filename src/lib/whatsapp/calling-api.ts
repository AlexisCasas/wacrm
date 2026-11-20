import { isValidBsuid } from './bsuid'
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


export interface WhatsAppCallPermissionLimit {
  timePeriod: string
  maxAllowed: number
  currentUsage: number
  limitExpirationTime?: number
}

export interface WhatsAppCallPermissionAction {
  actionName: 'send_call_permission_request' | 'start_call' | string
  canPerformAction: boolean
  limits: WhatsAppCallPermissionLimit[]
}

export interface WhatsAppCallPermissionSnapshot {
  status: 'no_permission' | 'temporary' | 'permanent'
  expirationTime?: number
  actions: WhatsAppCallPermissionAction[]
}

interface MetaCallPermissionResponse {
  permission?: {
    status?: string
    expiration_time?: number
  }
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

interface MetaMessageSendResponse {
  messages?: Array<{ id?: string }>
}

/**
 * Read the live permission and action limits for one WhatsApp user.
 * Meta's can_perform_action is authoritative for permission-request
 * and call limits; callers must fail closed when the relevant action is absent.
 */
export async function getWhatsAppCallPermission(args: {
  phoneNumberId: string
  accessToken: string
  userWaId?: string
  recipient?: string
}): Promise<WhatsAppCallPermissionSnapshot> {
  const phoneNumberId = args.phoneNumberId.trim()
  if (!/^\d{5,25}$/.test(phoneNumberId)) {
    throw new Error('WhatsApp phone_number_id is invalid.')
  }
  if (typeof args.accessToken !== 'string' || args.accessToken.trim() === '') {
    throw new Error('WhatsApp access token is required.')
  }

  const hasPhone = typeof args.userWaId === 'string' && args.userWaId.trim() !== ''
  const hasRecipient = typeof args.recipient === 'string' && args.recipient.trim() !== ''
  if (hasPhone === hasRecipient) {
    throw new Error('Provide exactly one WhatsApp user phone number or BSUID recipient.')
  }

  const query = new URLSearchParams()
  if (hasPhone) query.set('user_wa_id', normalizeCallPhoneNumber(args.userWaId!))
  if (hasRecipient) query.set('recipient', validateCallPermissionRecipient(args.recipient!))

  const response = await fetch(
    META_CALLING_API_BASE + '/' + phoneNumberId + '/call_permissions?' + query.toString(),
    { headers: { Authorization: 'Bearer ' + args.accessToken } },
  )
  if (!response.ok) await throwCallingMetaError(response)

  let data: MetaCallPermissionResponse
  try {
    data = await response.json() as MetaCallPermissionResponse
  } catch {
    throw new Error('Meta WhatsApp call-permission API returned an invalid response.')
  }

  const status = data.permission?.status
  if (status !== 'no_permission' && status !== 'temporary' && status !== 'permanent') {
    throw new Error('Meta WhatsApp call-permission API returned an unknown permission state.')
  }

  const expirationTime = data.permission?.expiration_time
  if (expirationTime !== undefined && (!Number.isInteger(expirationTime) || expirationTime <= 0)) {
    throw new Error('Meta WhatsApp call-permission API returned an invalid expiration time.')
  }
  if (status === 'temporary' && expirationTime === undefined) {
    throw new Error('Meta WhatsApp temporary call permission is missing its expiration time.')
  }

  const actions = Array.isArray(data.actions)
    ? data.actions.flatMap((item) => {
        if (
          typeof item.action_name !== 'string' ||
          typeof item.can_perform_action !== 'boolean'
        ) return []
        const limits = Array.isArray(item.limits)
          ? item.limits.flatMap((limit) => {
              if (
                typeof limit.time_period !== 'string' ||
                !Number.isInteger(limit.max_allowed) ||
                !Number.isInteger(limit.current_usage)
              ) return []
              return [{
                timePeriod: limit.time_period,
                maxAllowed: limit.max_allowed!,
                currentUsage: limit.current_usage!,
                ...(Number.isInteger(limit.limit_expiration_time) && limit.limit_expiration_time! > 0
                  ? { limitExpirationTime: limit.limit_expiration_time }
                  : {}),
              }]
            })
          : []
        return [{
          actionName: item.action_name,
          canPerformAction: item.can_perform_action,
          limits,
        }]
      })
    : []

  return {
    status,
    ...(expirationTime ? { expirationTime } : {}),
    actions,
  }
}

/** True only when Meta confirms the requested action is currently allowed. */
export function canPerformWhatsAppCallAction(
  permission: WhatsAppCallPermissionSnapshot,
  actionName: 'send_call_permission_request' | 'start_call',
): boolean {
  return permission.actions.find((action) => action.actionName === actionName)?.canPerformAction === true
}

/**
 * Permission status alone is not sufficient: Meta also supplies a live
 * start_call.can_perform_action gate that accounts for current limits.
 */
export function hasActiveWhatsAppCallPermission(
  permission: WhatsAppCallPermissionSnapshot,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (permission.status === 'permanent') return true
  return permission.status === 'temporary' &&
    typeof permission.expirationTime === 'number' &&
    permission.expirationTime > nowSeconds
}

function validateCallPermissionRecipient(value: string): string {
  const normalized = value.trim()
  if (!isValidBsuid(normalized)) {
    throw new Error('WhatsApp call-permission recipient ID is invalid.')
  }
  return normalized
}

/**
 * Send Meta's free-form interactive call-permission request.
 * This message is only valid inside the 24-hour customer-service window;
 * the route must enforce that before calling this helper. Template-based
 * permission requests outside the window are a separate path.
 */
export async function sendWhatsAppCallPermissionRequest(args: {
  phoneNumberId: string
  accessToken: string
  messagingAccountId?: string | null
  to?: string
  recipient?: string
  bodyText: string
}): Promise<{ messageId: string }> {
  const phoneNumberId = args.phoneNumberId.trim()
  if (!/^\d{5,25}$/.test(phoneNumberId)) {
    throw new Error('WhatsApp phone_number_id is invalid.')
  }
  if (typeof args.accessToken !== 'string' || args.accessToken.trim() === '') {
    throw new Error('WhatsApp access token is required.')
  }
  const hasPhone = typeof args.to === 'string' && args.to.trim() !== ''
  const hasRecipient = typeof args.recipient === 'string' && args.recipient.trim() !== ''
  if (hasPhone === hasRecipient) {
    throw new Error('Provide exactly one WhatsApp user phone number or BSUID recipient.')
  }
  if (typeof args.bodyText !== 'string' || args.bodyText.trim().length < 1 || args.bodyText.length > 1024) {
    throw new Error('Call-permission request text must contain 1-1024 characters.')
  }

  const payload: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    ...messagingAccountField(args.messagingAccountId),
    ...(hasPhone ? { to: normalizeCallPhoneNumber(args.to!) } : { recipient: validateCallPermissionRecipient(args.recipient!) }),
    type: 'interactive',
    interactive: {
      type: 'call_permission_request',
      action: { name: 'call_permission_request' },
      body: { text: args.bodyText.trim() },
    },
  }

  const response = await fetch(META_CALLING_API_BASE + '/' + phoneNumberId + '/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + args.accessToken,
    },
    body: JSON.stringify(payload),
  })
  if (!response.ok) await throwCallingMetaError(response)

  let data: MetaMessageSendResponse
  try {
    data = await response.json() as MetaMessageSendResponse
  } catch {
    throw new Error('Meta WhatsApp message API returned an invalid permission-request response.')
  }
  const messageId = data.messages?.[0]?.id
  if (typeof messageId !== 'string' || !messageId.startsWith('wamid.')) {
    throw new Error('Meta WhatsApp message API did not return a permission-request message ID.')
  }
  return { messageId }
}
