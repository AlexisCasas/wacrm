import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  getWhatsAppCallPermission,
  sendWhatsAppCallPermissionRequest,
} from '@/lib/whatsapp/calling-api'

const CALL_ID_PATTERN = /^wacid\.[A-Za-z0-9._~+/=-]{1,512}$/

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

/**
 * GET /api/whatsapp/calls
 * Lists this account's recent calls. A call_id query returns one call;
 * decrypted SDP is returned only to the agent holding the active claim.
 */
export async function GET(request: Request) {
  try {
    const { accountId, userId } = await requireRole('agent')
    const db = supabaseAdmin()
    const callId = new URL(request.url).searchParams.get('call_id')

    if (callId) {
      if (!CALL_ID_PATTERN.test(callId)) {
        return NextResponse.json({ error: 'Invalid call_id' }, { status: 400 })
      }
      const { data: call, error } = await db
        .from('whatsapp_call_sessions')
        .select('id,phone_number_id,call_id,direction,customer_key,customer_phone,customer_bsuid,customer_parent_bsuid,customer_name,state,claimed_by_user_id,claimed_at,claim_expires_at,started_at,ended_at,duration_seconds,created_at,updated_at,session_sdp_encrypted,session_sdp_type,session_sdp_expires_at')
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
      const sdpIsFresh = typeof call.session_sdp_expires_at === 'string'
        && Date.parse(call.session_sdp_expires_at) > now
      let session: { sdp_type: 'offer' | 'answer'; sdp: string } | null = null

      if (ownsClaim && sdpIsFresh && call.session_sdp_encrypted
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

      const { session_sdp_encrypted: _encrypted, ...safeCall } = call
      return NextResponse.json({
        call: safeCall,
        session,
        session_available: Boolean(session),
        claim_owned_by_me: ownsClaim,
      })
    }

    const { data, error } = await db
      .from('whatsapp_call_sessions')
      .select('id,phone_number_id,call_id,direction,customer_key,customer_phone,customer_bsuid,customer_parent_bsuid,customer_name,state,claimed_by_user_id,claimed_at,claim_expires_at,started_at,ended_at,duration_seconds,created_at,updated_at,session_sdp_type,session_sdp_expires_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) {
      console.error('[calling/api] call list lookup failed', { code: error.code ?? 'unknown' })
      return NextResponse.json({ error: 'Failed to list calls' }, { status: 500 })
    }

    const now = Date.now()
    const calls = (data ?? []).map((call) => ({
      ...call,
      claim_owned_by_me: call.claimed_by_user_id === userId
        && typeof call.claim_expires_at === 'string'
        && Date.parse(call.claim_expires_at) > now,
      claim_available: !call.claimed_by_user_id
        || (typeof call.claim_expires_at === 'string' && Date.parse(call.claim_expires_at) <= now)
        || call.claimed_by_user_id === userId,
      session_available: Boolean(
        call.session_sdp_type
        && call.session_sdp_expires_at
        && Date.parse(call.session_sdp_expires_at) > now
      ),
    }))
    return NextResponse.json({ calls })
  } catch (error) {
    return toErrorResponse(error)
  }
}

/**
 * POST /api/whatsapp/calls
 * Actions: claim, release, check_permission, request_permission.
 * Actual connect/accept signaling is reserved for CALL-03 when WebRTC
 * can supply a browser-generated SDP offer/answer.
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('agent')
    const limit = checkRateLimit(`calling:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 })
    }

    const action = typeof body.action === 'string' ? body.action : ''
    const callId = typeof body.call_id === 'string' ? body.call_id.trim() : ''
    const contactId = typeof body.contact_id === 'string' ? body.contact_id.trim() : ''

    if (['claim','release'].includes(action)) {
      if (!CALL_ID_PATTERN.test(callId)) {
        return NextResponse.json({ error: 'A valid call_id is required' }, { status: 400 })
      }
      const db = supabaseAdmin()
      const { data: callRow, error: callLookupError } = await db
        .from('whatsapp_call_sessions')
        .select('phone_number_id')
        .eq('account_id', accountId)
        .eq('call_id', callId)
        .maybeSingle()
      if (callLookupError) {
        console.error('[calling/api] claim target lookup failed', { code: callLookupError.code ?? 'unknown' })
        return NextResponse.json({ error: 'Failed to locate call' }, { status: 500 })
      }
      if (!callRow) return NextResponse.json({ error: 'Call not found' }, { status: 404 })

      const rpcName = action === 'claim' ? 'whatsapp_call_claim' : 'whatsapp_call_release'
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
          error: action === 'claim' ? 'Call is already claimed or no longer available' : 'Call is not claimed by you',
        }, { status: 409 })
      }
      return NextResponse.json({ success: true, action, lease_seconds: action === 'claim' ? 90 : 0 })
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
