import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { encrypt } from './encryption'
import { parseWhatsAppCallPermissionReply, parseWhatsAppCallingWebhookChange, type WhatsAppCallingEvent, type WhatsAppCallingStatus } from './calling-webhook'

type ConfigRow = { account_id: string; user_id: string; phone_number_id: string }

function seconds(value: string | undefined): number | null {
  if (!value) return null
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}
function iso(value: string | undefined): string | null {
  const n = seconds(value)
  return n === null ? null : new Date(n * 1000).toISOString()
}
function hash(parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex')
}
type CallingContact = {
  wa_id?: string
  user_id?: string
  parent_user_id?: string
  profile?: { name?: string }
}

function customerIdentity(call: WhatsAppCallingEvent, contact?: CallingContact) {
  const userInitiated = call.direction === 'USER_INITIATED'
  const businessInitiated = call.direction === 'BUSINESS_INITIATED'
  if (!userInitiated && !businessInitiated) {
    return { key: '', phone: null, bsuid: null, parentBsuid: null }
  }
  // Meta's Calling webhook uses "to" for the WhatsApp user in both directions.
  // The caller-side BSUID field depends on direction: from_user_id for UIC,
  // to_user_id for BIC. The official webhook may omit the phone when a BSUID
  // is used, in which case contacts.wa_id is the fallback.
  const rawPhone = call.to ?? contact?.wa_id
  const rawBsuid = (userInitiated ? call.from_user_id : call.to_user_id) ?? contact?.user_id
  const rawParentBsuid = (userInitiated ? call.from_parent_user_id : call.to_parent_user_id) ?? contact?.parent_user_id
  const phoneValue = typeof rawPhone === 'string' ? rawPhone.trim() : ''
  const phoneIsValid = /^\+?\d{6,20}$/.test(phoneValue)
  const phone = phoneIsValid ? phoneValue.replace(/\D/g, '') : ''
  const bsuid = typeof rawBsuid === 'string' && /^[A-Za-z0-9._~-]{1,256}$/.test(rawBsuid) ? rawBsuid : ''
  const parentBsuid = typeof rawParentBsuid === 'string' && /^[A-Za-z0-9._~-]{1,256}$/.test(rawParentBsuid) ? rawParentBsuid : ''
  return { key: bsuid || parentBsuid || phone, phone: phone || null, bsuid: bsuid || null, parentBsuid: parentBsuid || null }
}
async function persistEvent(db: SupabaseClient, config: ConfigRow, event: WhatsAppCallingEvent, contact?: CallingContact) {
  if (event.event === 'connect') {
    if (!event.direction) throw new Error('call_connect_missing_direction')
    const expectedSdpType = event.direction === 'USER_INITIATED' ? 'offer' : 'answer'
    if (event.session?.sdp_type !== expectedSdpType) throw new Error('call_connect_invalid_sdp_type')
  }
  const timestamp = seconds(event.timestamp)
  if (timestamp === null) throw new Error('invalid_call_event_timestamp')
  const identity = customerIdentity(event, contact)
  if (event.event === 'connect' && !identity.key) throw new Error('call_event_missing_customer_identity')
  const terminal = event.event === 'terminate'
  const terminalStatus = event.status?.toUpperCase()
  const state = terminal
    ? terminalStatus === 'FAILED' ? 'failed' : terminalStatus === 'REJECTED' ? 'rejected' : 'terminated'
    : event.event === 'connect' ? (event.direction === 'USER_INITIATED' ? 'offered' : 'connecting') : null
  const sdp = event.session?.sdp
  // Meta gives the business roughly 30–60 seconds to accept an inbound call.
  // Keep inbound offers for at most 60 seconds; outbound SDP keeps its
  // existing five-minute ephemeral lifetime.
  const sdpTtlMs = event.direction === 'USER_INITIATED' ? 60_000 : 5 * 60 * 1000
  const encryptedSdp = sdp ? encrypt(sdp) : null
  const { error } = await db.rpc('whatsapp_call_event_apply', {
    p_account_id: config.account_id, p_phone_number_id: config.phone_number_id, p_call_id: event.id,
    p_event_key: hash([event.id,event.event,event.timestamp,event.direction ?? '',event.status ?? '']),
    p_event_name: terminal ? 'terminate' : 'connect', p_meta_timestamp: timestamp,
    p_direction: event.direction ?? null, p_customer_key: identity.key || null,
    p_customer_phone: identity.phone, p_customer_bsuid: identity.bsuid,
    p_customer_parent_bsuid: identity.parentBsuid, p_customer_name: contact?.profile?.name?.slice(0,256) ?? null,
    p_state: state, p_session_sdp_encrypted: encryptedSdp,
    p_session_sdp_type: sdp ? event.session?.sdp_type ?? null : null,
    p_session_sdp_expires_at: sdp ? new Date(Date.now()+sdpTtlMs).toISOString() : null,
    p_started_at: iso(event.start_time), p_ended_at: iso(event.end_time),
    p_duration_seconds: typeof event.duration === 'number' ? Math.floor(event.duration) : null,
  })
  if (error) {
    console.error('[calling] call event persistence failed', { code: error.code ?? 'unknown' })
    throw new Error('call_event_persistence_failed')
  }
  if (event.biz_opaque_callback_data) {
    const { error: callbackError } = await db.rpc('whatsapp_call_session_callback_data_apply', {
      p_account_id: config.account_id,
      p_phone_number_id: config.phone_number_id,
      p_call_id: event.id,
      p_callback_data: event.biz_opaque_callback_data,
    })
    if (callbackError) {
      console.error('[calling] call callback data persistence failed', { code: callbackError.code ?? 'unknown' })
      throw new Error('call_callback_data_persistence_failed')
    }
  }
}
async function persistStatus(db: SupabaseClient, config: ConfigRow, status: WhatsAppCallingStatus) {
  const timestamp = seconds(status.timestamp)
  if (timestamp === null) throw new Error('invalid_call_status_timestamp')
  const statusName = status.status.toUpperCase()
  const state = statusName === 'ACCEPTED' ? 'connected'
    : statusName === 'RINGING' ? 'ringing'
    : statusName === 'REJECTED' ? 'rejected'
    : null
  // Unknown future status values must not create a phantom 'offered' session.
  if (!state) return
  const rawRecipient = typeof status.recipient_id === 'string' ? status.recipient_id.trim() : ''
  const recipientIsPhone = /^\+?\d{6,20}$/.test(rawRecipient)
  const recipientPhone = recipientIsPhone ? rawRecipient.replace(/\D/g, '') : null
  const recipientBsuid = typeof status.recipient_user_id === 'string'
    && /^[A-Za-z0-9._~-]{1,256}$/.test(status.recipient_user_id)
    ? status.recipient_user_id : null
  const recipientParentBsuid = typeof status.recipient_parent_user_id === 'string'
    && /^[A-Za-z0-9._~-]{1,256}$/.test(status.recipient_parent_user_id)
    ? status.recipient_parent_user_id : null
  const recipientKey = recipientBsuid ?? recipientParentBsuid ?? recipientPhone
  const { error } = await db.rpc('whatsapp_call_event_apply', {
    p_account_id: config.account_id,p_phone_number_id: config.phone_number_id,p_call_id: status.id,
    p_event_key: hash([status.id,'status',status.status,status.timestamp]),p_event_name:'status',
    p_meta_timestamp:timestamp,p_direction:null,p_customer_key:recipientKey,p_customer_phone:recipientPhone,p_customer_bsuid:recipientBsuid,
    p_customer_parent_bsuid:recipientParentBsuid,p_customer_name:null,p_state:state,p_session_sdp_encrypted:null,p_session_sdp_type:null,p_session_sdp_expires_at:null,
    p_started_at:null,p_ended_at:null,p_duration_seconds:null,
  })
  if (error) {
    console.error('[calling] call status persistence failed', { code: error.code ?? 'unknown' })
    throw new Error('call_status_persistence_failed')
  }
  if (status.biz_opaque_callback_data) {
    const { error: callbackError } = await db.rpc('whatsapp_call_session_callback_data_apply', {
      p_account_id: config.account_id,
      p_phone_number_id: config.phone_number_id,
      p_call_id: status.id,
      p_callback_data: status.biz_opaque_callback_data,
    })
    if (callbackError) {
      console.error('[calling] call status callback data persistence failed', { code: callbackError.code ?? 'unknown' })
      throw new Error('call_callback_data_persistence_failed')
    }
  }
}
export async function processCallingWebhookChange(db: SupabaseClient, change: unknown): Promise<boolean> {
  const parsed = parseWhatsAppCallingWebhookChange(change)
  if (!parsed) throw new Error('invalid_calling_webhook_payload')
  const { data, error } = await db.from('whatsapp_config').select('account_id,user_id,phone_number_id')
    .eq('phone_number_id',parsed.phoneNumberId).maybeSingle()
  if (error || !data) {
    console.error('[calling] phone number configuration unavailable',{code:error?.code ?? 'not_found'})
    throw new Error('calling_config_unavailable')
  }
  const config = data as ConfigRow
  const value = (change as {value?:{contacts?:CallingContact[]} }).value
  const contact = value?.contacts?.[0]
  for (const event of parsed.calls) {
    // Recording/transcript events are intentionally outside CALL-02; do not
    // misclassify a future Meta event as a new connect operation.
    if (event.event === 'connect' || event.event === 'terminate') {
      await persistEvent(db,config,event,contact)
    }
  }
  for (const status of parsed.statuses) if (status.type === 'call') await persistStatus(db,config,status)
  return true
}
export async function processCallPermissionReply(db: SupabaseClient, config: ConfigRow, message: unknown): Promise<boolean> {
  const reply = parseWhatsAppCallPermissionReply(message)
  if (!reply) return false
  const phoneDigits = typeof reply.from === 'string' ? reply.from.replace(/\D/g,'').slice(0,20) : ''
  const phone = /^\d{6,20}$/.test(phoneDigits) ? phoneDigits : ''
  const directBsuid = typeof reply.from_user_id === 'string' && /^[A-Za-z0-9._~-]{1,256}$/.test(reply.from_user_id) ? reply.from_user_id : ''
  const parentBsuid = typeof reply.from_parent_user_id === 'string' && /^[A-Za-z0-9._~-]{1,256}$/.test(reply.from_parent_user_id) ? reply.from_parent_user_id : ''
  const key = directBsuid || parentBsuid || phone
  if (!key) throw new Error('call_permission_reply_missing_identity')
  const permanent = reply.response === 'accept' && reply.is_permanent === true
  const expiry = reply.expiration_timestamp ? seconds(reply.expiration_timestamp) : null
  const temporary = reply.response === 'accept' && !permanent && expiry !== null
  if (reply.response === 'accept' && !permanent && !temporary) throw new Error('call_permission_reply_missing_expiry')
  const { error } = await db.rpc('whatsapp_call_permission_upsert',{
    p_account_id:config.account_id,p_phone_number_id:config.phone_number_id,p_customer_key:key,
    p_customer_phone:phone || null,p_customer_bsuid:directBsuid || null,
    p_customer_parent_bsuid:parentBsuid || null,
    p_permission_state:reply.response === 'accept' ? 'approved' : 'rejected',
    p_permission_type:permanent ? 'permanent' : temporary ? 'temporary' : null,
    p_expires_at:temporary ? new Date(expiry! * 1000).toISOString() : null,
    p_response_source:reply.response_source === 'automatic' || reply.response_source === 'user_action'
      ? reply.response_source : null,
    p_source_message_id:reply.message_id ?? null,
  })
  if (error) {
    console.error('[calling] permission reply persistence failed',{code:error.code ?? 'unknown'})
    throw new Error('call_permission_persistence_failed')
  }
  if (reply.context_message_id) {
    const { error: requestUpdateError } = await db
      .from('whatsapp_call_permission_requests')
      .update({
        response: reply.response,
        response_source: reply.response_source === 'automatic' || reply.response_source === 'user_action'
          ? reply.response_source : null,
        response_message_id: reply.message_id ?? null,
        responded_at: new Date().toISOString(),
      })
      .eq('account_id', config.account_id)
      .eq('phone_number_id', config.phone_number_id)
      .eq('message_id', reply.context_message_id)
    if (requestUpdateError) {
      console.error('[calling] permission request audit update failed', { code: requestUpdateError.code ?? 'unknown' })
      throw new Error('call_permission_request_audit_failed')
    }
  }
  return true
}
