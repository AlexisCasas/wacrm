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
export const META_CALLING_API_VERSION = 'v27.0'

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
      to?: string
      /** Business-scoped WhatsApp user ID (BSUID), when Meta supplies one. */
      recipient?: string
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
  const normalized = value.trim().replace(/^\\+/, '')
  if (!/^\\d{6,20}$/.test(normalized)) {
    throw new Error('WhatsApp call recipient must be an E.164 phone number.')
  }
  return normalized
}

function validateCallRecipientId(value: string): string {
  const normalized = value.trim()
  if (!/^[A-Za-z0-9._~+/-]{1,256}$/.test(normalized)) {
    throw new Error('WhatsApp call recipient ID is invalid.')
  }
  return normalized
}

function validateCallId(value: string): string {
  const normalized = value.trim()
  if (!/^wacid\\.[A-Za-z0-9._~+/=-]{1,512}$/.test(normalized)) {
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
    !/^v=0(?:\\r?\\n)/.test(session.sdp)
  ) {
    throw new Error(`A valid SDP ${expectedType} is required for this WhatsApp call action.`)
  }
  return session
}

function validateCallbackData(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\\u0000-\\u001f]/.test(value)) {
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
  if (!/^\\d{5,25}$/.test(phoneNumberId)) {
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
      if (!args.action.to && !args.action.recipient) {
        throw new Error('A phone number or BSUID recipient is required to connect a WhatsApp call.')
      }
      if (args.action.to) payload.to = normalizeCallPhoneNumber(args.action.to)
      if (args.action.recipient) payload.recipient = validateCallRecipientId(args.action.recipient)
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
