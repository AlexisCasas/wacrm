import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { isWhatsAppCallingPilotAllowed } from '@/lib/whatsapp/calling-pilot'
import {
  callWhatsApp,
  getWhatsAppCallPermission,
  sendWhatsAppCallPermissionRequest,
} from '@/lib/whatsapp/calling-api'

const CALL_ID_PATTERN = /^wacid\.[A-Za-z0-9._~+/=-]{1,512}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type CallConfig = {
  phone_number_id: string
  access_token: string
  messaging_account_id: string | null
  status: string
}

type CallTarget = {
  key: string
  phone: string | null
  bsuid: string | null
  parentBsuid: string | null
}

function normalizePhone(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const digits = value.replace(/\D/g, '').slice(0, 20)
  return /^\d{6,20}$/.test(digits) ? digits : null
}

function validBsuid(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{1,256}$/.test(value)
    ? value
    : null
}

async function loadConfig(accountId: string): Promise<CallConfig | null> {
  const { data, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('phone_number_id,access_token,messaging_account_id,status')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) {
    console.error('[calling/api] WhatsApp config lookup failed', { code: error.code ?? 'unknown' })
    throw new Error('calling_config_lookup_failed')
  }
  return data as CallConfig | null
}

async function loadCallTarget(
  accountId: string,
  callId: string | null,
  contactId: string | null,
): Promise<CallTarget | null> {
  const db = supabaseAdmin()

  if (callId) {
    const { data, error } = await db
      .from('whatsapp_call_sessions')
      .select('customer_key,customer_phone,customer_bsuid,customer_parent_bsuid')
      .eq('account_id', accountId)
      .eq('call_id', callId)
      .maybeSingle()
    if (error) {
      console.error('[calling/api] call target lookup failed', { code: error.code ?? 'unknown' })
      throw new Error('calling_target_lookup_failed')
    }
    if (!data) return null
    const phone = normalizePhone(data.customer_phone)
    const bsuid = validBsuid(data.customer_bsuid)
    const parentBsuid = validBsuid(data.customer_parent_bsuid)
    const key = bsuid ?? parentBsuid ?? phone
    return key ? { key, phone, bsuid, parentBsuid } : null
  }

  if (!contactId) return null
  const { data: contact, error: contactError } = await db
    .from('contacts')
    .select('id,phone')
    .eq('account_id', accountId)
    .eq('id', contactId)
    .maybeSingle()
  if (contactError) {
    console.error('[calling/api] contact lookup failed', { code: contactError.code ?? 'unknown' })
    throw new Error('calling_contact_lookup_failed')
  }
  if (!contact) return null

  const { data: identityRows, error: identityError } = await db
    .from('contact_identities')
    .select('value')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('kind', 'bsuid')
    .limit(1)
  if (identityError) {
    console.error('[calling/api] contact BSUID lookup failed', { code: identityError.code ?? 'unknown' })
    throw new Error('calling_contact_identity_lookup_failed')
  }
  const { data: parentRows, error: parentError } = await db
    .from('contact_identities')
    .select('value')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('kind', 'parent_bsuid')
    .limit(1)
  if (parentError) {
    console.error('[calling/api] contact parent BSUID lookup failed', { code: parentError.code ?? 'unknown' })
    throw new Error('calling_contact_identity_lookup_failed')
  }

  const phone = normalizePhone(contact.phone)
  const bsuid = validBsuid(identityRows?.[0]?.value)
  const parentBsuid = validBsuid(parentRows?.[0]?.value)
  const key = bsuid ?? parentBsuid ?? phone
  return key ? { key, phone, bsuid, parentBsuid } : null
}

function metaTarget(target: CallTarget) {
  if (target.phone) return { userWaId: target.phone }
  const recipient = target.bsuid ?? target.parentBsuid
  return recipient ? { recipient } : null
}

type SignalCallRow = {
  phone_number_id: string
  call_id: string
  direction: 'USER_INITIATED' | 'BUSINESS_INITIATED' | null
  contact_id: string | null
  conversation_id: string | null
  customer_key: string | null
  customer_phone: string | null
  customer_bsuid: string | null
  customer_parent_bsuid: string | null
  claimed_by_user_id: string | null
  last_claimed_by_user_id: string | null
  claim_expires_at: string | null
  initiated_by_user_id: string | null
  accepted_by_user_id: string | null
  rejected_by_user_id: string | null
  ended_by_user_id: string | null
  biz_opaque_callback_data: string | null
  agent_sdp_encrypted: string | null
  agent_sdp_type: 'offer' | 'answer' | null
  agent_sdp_expires_at: string | null
  state: string
}

function validSdp(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 65_536
    && /^v=0(?:\\r?\\n)/.test(value)
}

async function loadSignalCall(accountId: string, callId: string): Promise<SignalCallRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('whatsapp_call_sessions')
    .select('phone_number_id,call_id,direction,contact_id,conversation_id,customer_key,customer_phone,customer_bsuid,customer_parent_bsuid,claimed_by_user_id,last_claimed_by_user_id,claim_expires_at,initiated_by_user_id,accepted_by_user_id,rejected_by_user_id,ended_by_user_id,biz_opaque_callback_data,agent_sdp_encrypted,agent_sdp_type,agent_sdp_expires_at,state')
    .eq('account_id', accountId)
    .eq('call_id', callId)
    .maybeSingle()
  if (error) {
    console.error('[calling/api] signal call lookup failed', { code: error.code ?? 'unknown' })
    throw new Error('calling_signal_lookup_failed')
  }
  return data as SignalCallRow | null
}

async function loadAccessToken(config: CallConfig): Promise<string | null> {
  try {
    return decrypt(config.access_token)
  } catch {
    console.error('[calling/api] WhatsApp access token decryption failed')
    return null
  }
}

async function pruneExpiredSdp(): Promise<void> {
  const { error } = await supabaseAdmin().rpc('whatsapp_call_sdp_prune', { p_limit: 25 })
  if (error) {
    console.error('[calling/api] expired SDP cleanup failed', { code: error.code ?? 'unknown' })
  }
}

/**
 * GET /api/whatsapp/calls
 * Lists this account's recent calls. A call_id query returns one call;
 * decrypted SDP is returned only to the active claimant or outbound initiator.
 */
export async function GET(request: Request) {
  try {
    const { accountId, userId } = await requireRole('agent')
    await pruneExpiredSdp()
    const db = supabaseAdmin()
    const callId = new URL(request.url).searchParams.get('call_id')

    if (callId) {
      if (!CALL_ID_PATTERN.test(callId)) {
        return NextResponse.json({ error: 'Invalid call_id' }, { status: 400 })
      }
      const { data: call, error } = await db
        .from('whatsapp_call_sessions')
        .select('id,phone_number_id,call_id,contact_id,conversation_id,initiated_by_user_id,accepted_by_user_id,rejected_by_user_id,ended_by_user_id,direction,customer_key,customer_phone,customer_bsuid,customer_parent_bsuid,customer_name,state,claimed_by_user_id,claimed_at,claim_expires_at,started_at,ended_at,duration_seconds,created_at,updated_at,session_sdp_encrypted,session_sdp_type,session_sdp_expires_at')
        .eq('account_id', accountId)
        .eq('call_id', callId)
        .maybeSingle()
      if (error) {
        console.error('[calling/api] call detail lookup failed', { code: error.code ?? 'unknown' })
        return NextResponse.json({ error: 'Failed to load call' }, { status: 500 })
      }
      if (!call) return NextResponse.json({ error: 'Call not found' }, { status: 404 })

      const now = Date.now()
      const ownsClaim = call.claimed_by_user_id === userId
        && typeof call.claim_expires_at === 'string'
        && Date.parse(call.claim_expires_at) > now
      const callIsActive = !['terminated','failed','rejected'].includes(call.state)
      const pilotAllowed = isWhatsAppCallingPilotAllowed(call.phone_number_id, call.customer_phone)
      const ownsOutboundCall = call.direction === 'BUSINESS_INITIATED' && call.initiated_by_user_id === userId
      const canReadSession = callIsActive && pilotAllowed && (ownsClaim || ownsOutboundCall)
      const sdpIsFresh = typeof call.session_sdp_expires_at === 'string'
        && Date.parse(call.session_sdp_expires_at) > now
      let session: { sdp_type: 'offer' | 'answer'; sdp: string } | null = null

      if (canReadSession && sdpIsFresh && call.session_sdp_encrypted
        && (call.session_sdp_type === 'offer' || call.session_sdp_type === 'answer')) {
        try {
          session = {
            sdp_type: call.session_sdp_type,
            sdp: decrypt(call.session_sdp_encrypted),
          }
        } catch {
          console.error('[calling/api] ephemeral SDP decryption failed')
        }
      }

      const safeCall = { ...call }
      delete safeCall.session_sdp_encrypted
      return NextResponse.json({
        call: safeCall,
        session,
        session_available: Boolean(session),
        claim_owned_by_me: ownsClaim,
        initiated_by_me: ownsOutboundCall,
      })
    }

    const { data, error } = await db
      .from('whatsapp_call_sessions')
      .select('id,phone_number_id,call_id,contact_id,conversation_id,initiated_by_user_id,accepted_by_user_id,rejected_by_user_id,ended_by_user_id,direction,customer_key,customer_phone,customer_bsuid,customer_parent_bsuid,customer_name,state,claimed_by_user_id,claimed_at,claim_expires_at,started_at,ended_at,duration_seconds,created_at,updated_at,session_sdp_type,session_sdp_expires_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) {
      console.error('[calling/api] call list lookup failed', { code: error.code ?? 'unknown' })
      return NextResponse.json({ error: 'Failed to list calls' }, { status: 500 })
    }

    const now = Date.now()
    const calls = (data ?? []).map((call) => {
      const ownsClaim = call.claimed_by_user_id === userId
        && typeof call.claim_expires_at === 'string'
        && Date.parse(call.claim_expires_at) > now
      const ownsOutboundCall = call.direction === 'BUSINESS_INITIATED'
        && call.initiated_by_user_id === userId
      const callIsActive = !['terminated','failed','rejected'].includes(call.state)
      const pilotAllowed = isWhatsAppCallingPilotAllowed(call.phone_number_id, call.customer_phone)
      return {
        ...call,
        claim_owned_by_me: ownsClaim,
        initiated_by_me: ownsOutboundCall,
        claim_available: pilotAllowed && call.direction === 'USER_INITIATED'
          && ['offered','ringing','connected'].includes(call.state)
          && !call.rejected_by_user_id && !call.ended_by_user_id
          && (
            !call.claimed_by_user_id
            || (typeof call.claim_expires_at === 'string' && Date.parse(call.claim_expires_at) <= now)
            || call.claimed_by_user_id === userId
          ),
        session_available: Boolean(
          callIsActive && pilotAllowed && (ownsClaim || ownsOutboundCall)
          && call.session_sdp_type
          && call.session_sdp_expires_at
          && Date.parse(call.session_sdp_expires_at) > now
        ),
      }
    })
    return NextResponse.json({ calls })
  } catch (error) {
    return toErrorResponse(error)
  }
}

/**
 * POST /api/whatsapp/calls
 * Actions: claim, release, renew_claim, check_permission, request_permission, connect, pre_accept, accept, reject, terminate.
 * Actual connect/accept signaling is reserved for CALL-03 when WebRTC
 * can supply a browser-generated SDP offer/answer.
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId, role } = await requireRole('agent')
    await pruneExpiredSdp()
    const limit = checkRateLimit(`calling:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 })
    }

    const action = typeof body.action === 'string' ? body.action : ''
    const callId = typeof body.call_id === 'string' ? body.call_id.trim() : ''
    const contactId = typeof body.contact_id === 'string' ? body.contact_id.trim() : ''

    if (['claim','release','renew_claim'].includes(action)) {
      if (!CALL_ID_PATTERN.test(callId)) {
        return NextResponse.json({ error: 'A valid call_id is required' }, { status: 400 })
      }
      const db = supabaseAdmin()
      const { data: callRow, error: callLookupError } = await db
        .from('whatsapp_call_sessions')
        .select('phone_number_id,customer_phone')
        .eq('account_id', accountId)
        .eq('call_id', callId)
        .maybeSingle()
      if (callLookupError) {
        console.error('[calling/api] claim target lookup failed', { code: callLookupError.code ?? 'unknown' })
        return NextResponse.json({ error: 'Failed to locate call' }, { status: 500 })
      }
      if (!callRow) return NextResponse.json({ error: 'Call not found' }, { status: 404 })
      if (action !== 'release'
        && !isWhatsAppCallingPilotAllowed(callRow.phone_number_id, callRow.customer_phone)) {
        return NextResponse.json({ error: 'WhatsApp Calling is disabled for this customer' }, { status: 403 })
      }

      const rpcName = action === 'claim' ? 'whatsapp_call_claim'
        : action === 'renew_claim' ? 'whatsapp_call_claim_renew'
        : 'whatsapp_call_release'
      const { data, error } = await db.rpc(rpcName, {
        p_account_id: accountId,
        p_phone_number_id: callRow.phone_number_id,
        p_call_id: callId,
        p_actor_user_id: userId,
      })
      if (error) {
        console.error('[calling/api] call claim operation failed', { code: error.code ?? 'unknown' })
        if (error.code === '42501') {
          return NextResponse.json({ error: 'You are not allowed to claim or release this call' }, { status: 403 })
        }
        return NextResponse.json({ error: 'Call claim operation failed' }, { status: 500 })
      }
      if (data !== true) {
        return NextResponse.json({
          error: action === 'claim' ? 'Call is already claimed or no longer available'
            : action === 'renew_claim' ? 'Call claim has expired or is no longer owned by you'
            : 'Call is not claimed by you',
        }, { status: 409 })
      }
      return NextResponse.json({ success: true, action, lease_seconds: action === 'claim' || action === 'renew_claim' ? 90 : 0 })
    }

    if (action === 'connect') {
      const contactId = typeof body.contact_id === 'string' ? body.contact_id.trim() : ''
      const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id.trim() : ''
      const requestId = typeof body.request_id === 'string' ? body.request_id.trim() : ''
      const session = body.session && typeof body.session === 'object'
        ? body.session as Record<string, unknown>
        : null
      const offer = session?.sdp_type === 'offer' && validSdp(session.sdp) ? session.sdp : ''
      if (!UUID_PATTERN.test(contactId) || !UUID_PATTERN.test(conversationId)
        || !UUID_PATTERN.test(requestId) || !offer) {
        return NextResponse.json({ error: 'Valid contact_id, conversation_id, request_id and SDP offer are required' }, { status: 400 })
      }

      const config = await loadConfig(accountId)
      if (!config || config.status !== 'connected') {
        return NextResponse.json({ error: 'WhatsApp account is not connected' }, { status: 409 })
      }
      const target = await loadCallTarget(accountId, null, contactId)
      if (!target) return NextResponse.json({ error: 'WhatsApp contact not found' }, { status: 404 })
      if (!isWhatsAppCallingPilotAllowed(config.phone_number_id, target.phone)) {
        return NextResponse.json({ error: 'WhatsApp Calling is disabled for this customer' }, { status: 403 })
      }
      const targetArgs = metaTarget(target)
      if (!targetArgs) return NextResponse.json({ error: 'Contact has no usable WhatsApp identity' }, { status: 409 })
      const accessToken = await loadAccessToken(config)
      if (!accessToken) return NextResponse.json({ error: 'WhatsApp credentials are unavailable' }, { status: 503 })

      const encryptedOffer = encrypt(offer)
      const offerExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()
      const db = supabaseAdmin()
      const { data: attemptData, error: attemptError } = await db.rpc('whatsapp_call_outbound_attempt_begin', {
        p_account_id: accountId,
        p_phone_number_id: config.phone_number_id,
        p_request_id: requestId,
        p_actor_user_id: userId,
        p_contact_id: contactId,
        p_conversation_id: conversationId,
        p_customer_key: target.key,
        p_customer_phone: target.phone,
        p_customer_bsuid: target.bsuid,
        p_customer_parent_bsuid: target.parentBsuid,
        p_customer_name: null,
        p_agent_sdp_encrypted: encryptedOffer,
        p_agent_sdp_expires_at: offerExpiresAt,
      })
      if (attemptError) {
        console.error('[calling/api] outbound attempt begin failed', { code: attemptError.code ?? 'unknown' })
        if (attemptError.code === '42501') return NextResponse.json({ error: 'Contact, conversation or account does not match' }, { status: 403 })
        return NextResponse.json({ error: 'Could not reserve outbound call attempt' }, { status: 500 })
      }
      const attempt = attemptData as {
        attempt_id?: string
        state?: string
        call_id?: string | null
        callback_data?: string
        created?: boolean
      }
      if (!attempt.created) {
        if (attempt.state === 'submitted' && typeof attempt.call_id === 'string') {
          return NextResponse.json({ success: true, call_id: attempt.call_id, duplicate: true }, { status: 200 })
        }
        if (attempt.state === 'failed') {
          return NextResponse.json({
            error: 'This request was already rejected or blocked. Use a new request_id only after reviewing the failure.',
            code: 'call_attempt_failed',
          }, { status: 409 })
        }
        return NextResponse.json({
          error: 'This outbound call request is already pending or has an uncertain result. Do not submit it again with the same request_id.',
          code: attempt.state === 'unknown' ? 'call_attempt_unknown' : 'call_attempt_pending',
        }, { status: 409 })
      }

      let permission: Awaited<ReturnType<typeof getWhatsAppCallPermission>>
      try {
        permission = await getWhatsAppCallPermission({
          phoneNumberId: config.phone_number_id,
          accessToken,
          ...targetArgs,
        })
      } catch (error) {
        console.error('[calling/api] outbound permission lookup failed', {
          status: typeof error === 'object' && error !== null && 'httpStatus' in error
            ? Number((error as { httpStatus?: unknown }).httpStatus) || 'unknown'
            : 'unknown',
        })
        await supabaseAdmin().rpc('whatsapp_call_outbound_attempt_fail', {
          p_account_id: accountId,
          p_phone_number_id: config.phone_number_id,
          p_request_id: requestId,
          p_actor_user_id: userId,
          p_state: 'failed',
          p_failure_code: 'permission_lookup_failed',
        })
        return NextResponse.json({ error: 'Could not verify current Meta call permission' }, { status: 503 })
      }

      const permissionIsCurrent = permission.status === 'permanent'
        || (permission.status === 'temporary'
          && typeof permission.expirationTime === 'number'
          && permission.expirationTime * 1000 > Date.now())
      if (!permission.canStartCall || !permissionIsCurrent) {
        await supabaseAdmin().rpc('whatsapp_call_outbound_attempt_fail', {
          p_account_id: accountId,
          p_phone_number_id: config.phone_number_id,
          p_request_id: requestId,
          p_actor_user_id: userId,
          p_state: 'failed',
          p_failure_code: 'call_permission_not_current',
        })
        return NextResponse.json({
          error: 'A current approved WhatsApp call permission is required before connecting',
          code: 'call_permission_required',
          permission,
        }, { status: 409 })
      }

      try {
        const result = await callWhatsApp({
          phoneNumberId: config.phone_number_id,
          accessToken,
          messagingAccountId: config.messaging_account_id,
          action: {
            action: 'connect',
            ...(target.phone ? { to: target.phone } : {}),
            ...(!target.phone && (target.bsuid || target.parentBsuid)
              ? { recipient: target.bsuid ?? target.parentBsuid ?? undefined }
              : {}),
            session: { sdp_type: 'offer', sdp: offer },
            bizOpaqueCallbackData: attempt.callback_data ?? requestId,
          },
        })
        if (result.action !== 'connect') throw new Error('unexpected_call_connect_response')
        const { data: completed, error: completeError } = await supabaseAdmin().rpc('whatsapp_call_outbound_attempt_complete', {
          p_account_id: accountId,
          p_phone_number_id: config.phone_number_id,
          p_request_id: requestId,
          p_actor_user_id: userId,
          p_call_id: result.callId,
          p_agent_sdp_encrypted: encryptedOffer,
          p_agent_sdp_expires_at: offerExpiresAt,
        })
        if (completeError || completed !== true) {
          console.error('[calling/api] outbound attempt completion failed', { code: completeError?.code ?? (completed === false ? 'not_completed' : 'unknown') })
          await supabaseAdmin().rpc('whatsapp_call_outbound_attempt_fail', {
            p_account_id: accountId,
            p_phone_number_id: config.phone_number_id,
            p_request_id: requestId,
            p_actor_user_id: userId,
            p_state: 'unknown',
            p_failure_code: 'local_completion_failed',
          })
          return NextResponse.json({
            success: true,
            call_id: result.callId,
            session_persisted: false,
            warning: 'Meta accepted the request but WACRM could not finish local persistence. Do not retry this request_id.',
          }, { status: 202 })
        }
        return NextResponse.json({ success: true, call_id: result.callId, session_persisted: true }, { status: 201 })
      } catch (error) {
        const status = typeof error === 'object' && error !== null && 'httpStatus' in error
          ? Number((error as { httpStatus?: unknown }).httpStatus)
          : 0
        const attemptState = status >= 400 && status < 500 ? 'failed' : 'unknown'
        await supabaseAdmin().rpc('whatsapp_call_outbound_attempt_fail', {
          p_account_id: accountId,
          p_phone_number_id: config.phone_number_id,
          p_request_id: requestId,
          p_actor_user_id: userId,
          p_state: attemptState,
          p_failure_code: attemptState === 'failed' ? 'meta_request_rejected' : 'meta_request_outcome_unknown',
        })
        console.error('[calling/api] outbound connect failed', { status: status || 'unknown', attempt_state: attemptState })
        return NextResponse.json({
          error: attemptState === 'failed' ? 'Meta rejected the outbound call request' : 'The outbound call result is unknown; check call history before retrying',
          code: attemptState === 'failed' ? 'meta_call_rejected' : 'meta_call_outcome_unknown',
        }, { status: attemptState === 'failed' ? 502 : 202 })
      }
    }

    if (['pre_accept','accept','reject','terminate'].includes(action)) {
      if (!CALL_ID_PATTERN.test(callId)) {
        return NextResponse.json({ error: 'A valid call_id is required' }, { status: 400 })
      }
      const config = await loadConfig(accountId)
      if (!config || config.status !== 'connected') {
        return NextResponse.json({ error: 'WhatsApp account is not connected' }, { status: 409 })
      }
      const call = await loadSignalCall(accountId, callId)
      if (!call || call.phone_number_id !== config.phone_number_id) {
        return NextResponse.json({ error: 'Call not found' }, { status: 404 })
      }
      if (!isWhatsAppCallingPilotAllowed(config.phone_number_id, call.customer_phone)) {
        return NextResponse.json({ error: 'WhatsApp Calling is disabled for this customer' }, { status: 403 })
      }
      const accessToken = await loadAccessToken(config)
      if (!accessToken) return NextResponse.json({ error: 'WhatsApp credentials are unavailable' }, { status: 503 })

      if (action === 'pre_accept') {
        const incomingSession = body.session && typeof body.session === 'object'
          ? body.session as Record<string, unknown>
          : null
        const incomingAnswer = incomingSession?.sdp_type === 'answer' && validSdp(incomingSession.sdp) ? incomingSession.sdp : ''
        if (call.direction !== 'USER_INITIATED' || !incomingAnswer) {
          return NextResponse.json({ error: 'An inbound call and SDP answer are required' }, { status: 400 })
        }
        if (!['offered','ringing'].includes(call.state)
          || call.accepted_by_user_id || call.rejected_by_user_id || call.ended_by_user_id) {
          return NextResponse.json({ error: 'This incoming call is no longer awaiting acceptance' }, { status: 409 })
        }
        const claimOwned = call.claimed_by_user_id === userId
          && typeof call.claim_expires_at === 'string'
          && Date.parse(call.claim_expires_at) > Date.now()
        if (!claimOwned) return NextResponse.json({ error: 'Claim this incoming call before accepting it' }, { status: 409 })

        let answer = incomingAnswer
        const storedAnswerIsFresh = call.agent_sdp_type === 'answer'
          && typeof call.agent_sdp_expires_at === 'string'
          && Date.parse(call.agent_sdp_expires_at) > Date.now()
        if (call.agent_sdp_encrypted && storedAnswerIsFresh) {
          try {
            answer = decrypt(call.agent_sdp_encrypted)
          } catch {
            return NextResponse.json({ error: 'Stored call answer is unavailable; release and reclaim the call' }, { status: 503 })
          }
        } else {
          const { data, error } = await supabaseAdmin().rpc('whatsapp_call_session_agent_sdp_store', {
            p_account_id: accountId,
            p_phone_number_id: call.phone_number_id,
            p_call_id: callId,
            p_actor_user_id: userId,
            p_agent_sdp_encrypted: encrypt(incomingAnswer),
            p_agent_sdp_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          })
          if (error || data !== true) {
            console.error('[calling/api] inbound SDP storage failed', { code: error?.code ?? 'claim_or_state_conflict' })
            return NextResponse.json({ error: 'Could not store the SDP answer for this call' }, { status: 409 })
          }
        }

        await callWhatsApp({
          phoneNumberId: config.phone_number_id,
          accessToken,
          messagingAccountId: config.messaging_account_id,
          action: {
            action: 'pre_accept',
            callId,
            session: { sdp_type: 'answer', sdp: answer },
            ...(call.biz_opaque_callback_data ? { bizOpaqueCallbackData: call.biz_opaque_callback_data } : {}),
          },
        })
        return NextResponse.json({ success: true, action: 'pre_accept', sdp_reused: answer !== incomingAnswer }, { status: 200 })
      }

      if (action === 'accept') {
        if (call.direction !== 'USER_INITIATED') {
          return NextResponse.json({ error: 'Only incoming calls can be accepted' }, { status: 400 })
        }
        if (['terminated','failed','rejected'].includes(call.state)
          || call.rejected_by_user_id || call.ended_by_user_id) {
          return NextResponse.json({ error: 'This incoming call is already terminal' }, { status: 409 })
        }
        if (call.accepted_by_user_id) {
          if (call.accepted_by_user_id !== userId) {
            return NextResponse.json({ error: 'This call was accepted by another agent' }, { status: 409 })
          }
          return NextResponse.json({ success: true, action: 'accept', already_accepted: true }, { status: 200 })
        }
        const claimOwned = call.claimed_by_user_id === userId
          && typeof call.claim_expires_at === 'string'
          && Date.parse(call.claim_expires_at) > Date.now()
        if (!claimOwned && call.accepted_by_user_id !== userId) {
          return NextResponse.json({ error: 'Claim this incoming call before accepting it' }, { status: 409 })
        }
        if (call.agent_sdp_type !== 'answer' || !call.agent_sdp_encrypted
          || typeof call.agent_sdp_expires_at !== 'string'
          || Date.parse(call.agent_sdp_expires_at) <= Date.now()) {
          return NextResponse.json({ error: 'A fresh pre_accept SDP answer is required' }, { status: 409 })
        }
        let answer: string
        try { answer = decrypt(call.agent_sdp_encrypted) } catch {
          return NextResponse.json({ error: 'Stored call answer is unavailable' }, { status: 503 })
        }
        if (call.state === 'connected') {
          const { data: auditRecorded, error: auditError } = await supabaseAdmin().rpc('whatsapp_call_session_agent_action', {
            p_account_id: accountId,
            p_phone_number_id: call.phone_number_id,
            p_call_id: callId,
            p_actor_user_id: userId,
            p_action: 'accepted',
            p_conversation_id: typeof body.conversation_id === 'string' ? body.conversation_id : null,
          })
          if (auditError || auditRecorded !== true) {
            console.error('[calling/api] accepted agent attribution failed', { code: auditError?.code ?? (auditRecorded === false ? 'not_recorded' : 'unknown') })
            return NextResponse.json({ success: true, action: 'accept', agent_attribution_recorded: false }, { status: 202 })
          }
          return NextResponse.json({ success: true, action: 'accept', already_accepted: true, agent_attribution_recorded: true }, { status: 200 })
        }
        await callWhatsApp({
          phoneNumberId: config.phone_number_id,
          accessToken,
          messagingAccountId: config.messaging_account_id,
          action: {
            action: 'accept',
            callId,
            session: { sdp_type: 'answer', sdp: answer },
            ...(call.biz_opaque_callback_data ? { bizOpaqueCallbackData: call.biz_opaque_callback_data } : {}),
          },
        })
        const { data: auditRecorded, error: auditError } = await supabaseAdmin().rpc('whatsapp_call_session_agent_action', {
          p_account_id: accountId,
          p_phone_number_id: call.phone_number_id,
          p_call_id: callId,
          p_actor_user_id: userId,
          p_action: 'accepted',
          p_conversation_id: typeof body.conversation_id === 'string' ? body.conversation_id : null,
        })
        if (auditError || auditRecorded !== true) {
          console.error('[calling/api] accepted agent attribution failed', { code: auditError?.code ?? (auditRecorded === false ? 'not_recorded' : 'unknown') })
          return NextResponse.json({ success: true, action: 'accept', agent_attribution_recorded: false }, { status: 202 })
        }
        return NextResponse.json({ success: true, action: 'accept', agent_attribution_recorded: true }, { status: 200 })
      }

      const claimIsActive = typeof call.claim_expires_at === 'string'
        && Date.parse(call.claim_expires_at) > Date.now()
      if (action === 'reject') {
        if (call.direction !== 'USER_INITIATED') {
          return NextResponse.json({ error: 'Only incoming calls can be rejected' }, { status: 400 })
        }
        if (call.ended_by_user_id || (call.rejected_by_user_id && call.rejected_by_user_id !== userId)) {
          return NextResponse.json({ error: 'This call is already terminal' }, { status: 409 })
        }
        if (call.claimed_by_user_id && claimIsActive && call.claimed_by_user_id !== userId) {
          return NextResponse.json({ error: 'Another agent currently owns this call' }, { status: 409 })
        }
        if (call.state === 'rejected' && call.last_claimed_by_user_id === userId) {
          const { data, error } = await supabaseAdmin().rpc('whatsapp_call_session_agent_action', {
            p_account_id: accountId,
            p_phone_number_id: call.phone_number_id,
            p_call_id: callId,
            p_actor_user_id: userId,
            p_action: 'rejected',
            p_conversation_id: typeof body.conversation_id === 'string' ? body.conversation_id : null,
          })
          if (error || data !== true) {
            return NextResponse.json({ success: true, action: 'reject', agent_attribution_recorded: false }, { status: 202 })
          }
          return NextResponse.json({ success: true, action: 'reject', already_terminal: true }, { status: 200 })
        }
        if (!['offered','ringing'].includes(call.state)) {
          return NextResponse.json({ error: 'Call is no longer rejectable' }, { status: 409 })
        }
      } else {
        const ownsCall = call.initiated_by_user_id === userId
          || call.accepted_by_user_id === userId
          || call.last_claimed_by_user_id === userId
          || (call.claimed_by_user_id === userId && claimIsActive)
          || role === 'owner'
          || role === 'admin'
        if (!ownsCall) {
          return NextResponse.json({ error: 'Only the initiating, accepting or assigned agent can terminate this call' }, { status: 403 })
        }
        if (call.rejected_by_user_id && call.ended_by_user_id !== userId) {
          return NextResponse.json({ error: 'A rejected call cannot be terminated' }, { status: 409 })
        }
        if (['terminated','failed','rejected'].includes(call.state)) {
          const { data, error } = await supabaseAdmin().rpc('whatsapp_call_session_agent_action', {
            p_account_id: accountId,
            p_phone_number_id: call.phone_number_id,
            p_call_id: callId,
            p_actor_user_id: userId,
            p_action: 'ended',
            p_conversation_id: typeof body.conversation_id === 'string' ? body.conversation_id : null,
          })
          if (error || data !== true) {
            return NextResponse.json({ success: true, action: 'terminate', agent_attribution_recorded: false }, { status: 202 })
          }
          return NextResponse.json({ success: true, action: 'terminate', already_terminal: true }, { status: 200 })
        }
      }

      const metaAction = action === 'reject' ? 'reject' : 'terminate'
      await callWhatsApp({
        phoneNumberId: config.phone_number_id,
        accessToken,
        messagingAccountId: config.messaging_account_id,
        action: {
          action: metaAction,
          callId,
          ...(call.biz_opaque_callback_data ? { bizOpaqueCallbackData: call.biz_opaque_callback_data } : {}),
        },
      })
      const { data: auditRecorded, error: auditError } = await supabaseAdmin().rpc('whatsapp_call_session_agent_action', {
        p_account_id: accountId,
        p_phone_number_id: call.phone_number_id,
        p_call_id: callId,
        p_actor_user_id: userId,
        p_action: action === 'reject' ? 'rejected' : 'ended',
        p_conversation_id: typeof body.conversation_id === 'string' ? body.conversation_id : null,
      })
      if (auditError || auditRecorded !== true) {
        console.error('[calling/api] terminal agent attribution failed', { code: auditError.code ?? 'unknown' })
        return NextResponse.json({ success: true, action, agent_attribution_recorded: false }, { status: 202 })
      }
      return NextResponse.json({ success: true, action, agent_attribution_recorded: true }, { status: 200 })
    }

    if (action !== 'check_permission' && action !== 'request_permission') {
      return NextResponse.json({ error: 'Unsupported Calling action' }, { status: 400 })
    }
    if ((callId && !CALL_ID_PATTERN.test(callId)) || (!callId && !contactId)) {
      return NextResponse.json({ error: 'Provide a valid call_id or contact_id' }, { status: 400 })
    }

    const target = await loadCallTarget(accountId, callId || null, contactId || null)
    if (!target) return NextResponse.json({ error: 'WhatsApp contact or call not found' }, { status: 404 })
    const targetArgs = metaTarget(target)
    if (!targetArgs) return NextResponse.json({ error: 'Contact has no usable WhatsApp identity' }, { status: 409 })

    const config = await loadConfig(accountId)
    if (!config || config.status !== 'connected') {
      return NextResponse.json({ error: 'WhatsApp account is not connected' }, { status: 409 })
    }

    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch {
      console.error('[calling/api] WhatsApp access token decryption failed')
      return NextResponse.json({ error: 'WhatsApp credentials are unavailable' }, { status: 503 })
    }

    if (!isWhatsAppCallingPilotAllowed(config.phone_number_id, target.phone)) {
      return NextResponse.json({ error: 'WhatsApp Calling is disabled for this customer' }, { status: 403 })
    }

    const permission = await getWhatsAppCallPermission({
      phoneNumberId: config.phone_number_id,
      accessToken,
      ...targetArgs,
    })

    if (action === 'check_permission') {
      return NextResponse.json({ permission })
    }

    if (!permission.canRequestPermission) {
      return NextResponse.json({
        error: 'Meta does not currently allow another call permission request for this customer',
        code: 'permission_request_not_allowed',
        permission,
      }, { status: 409 })
    }

    const bodyText = typeof body.body_text === 'string' ? body.body_text : undefined
    const sent = await sendWhatsAppCallPermissionRequest({
      phoneNumberId: config.phone_number_id,
      accessToken,
      messagingAccountId: config.messaging_account_id,
      ...targetArgs,
      bodyText,
    })

    const { error: auditError } = await supabaseAdmin()
      .from('whatsapp_call_permission_requests')
      .insert({
        account_id: accountId,
        phone_number_id: config.phone_number_id,
        customer_key: target.key,
        customer_phone: target.phone,
        customer_bsuid: target.bsuid,
        customer_parent_bsuid: target.parentBsuid,
        actor_user_id: userId,
        message_id: sent.messageId,
        request_type: 'free_form',
      })
    if (auditError) {
      // Meta has already accepted the request. Report the successful send
      // and expose the audit gap instead of inviting a duplicate retry.
      console.error('[calling/api] permission request audit insert failed', { code: auditError.code ?? 'unknown' })
      return NextResponse.json({
        success: true,
        message_id: sent.messageId,
        audit_recorded: false,
      }, { status: 202 })
    }

    return NextResponse.json({
      success: true,
      message_id: sent.messageId,
      audit_recorded: true,
    }, { status: 201 })
  } catch (error) {
    return toErrorResponse(error)
  }
}
