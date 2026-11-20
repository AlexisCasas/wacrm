import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { callingSupabaseAdmin } from '@/lib/whatsapp/calling-admin'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getWhatsAppCallingConfig } from '@/lib/whatsapp/calling-config'
import {
  canPerformWhatsAppCallAction,
  getWhatsAppCallPermission,
  hasActiveWhatsAppCallPermission,
  sendWhatsAppCallPermissionRequest,
} from '@/lib/whatsapp/calling-api'

const PHONE = /^\d{6,20}$/

async function loadContact(supabase: Awaited<ReturnType<typeof requireRole>>['supabase'], accountId: string, contactId: string) {
  const { data, error } = await supabase
    .from('contacts')
    .select('id, phone, blocked')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw new Error('calling_contact_lookup_failed')
  return data
}

async function loadPermissionTarget(
  supabase: Awaited<ReturnType<typeof requireRole>>['supabase'],
  accountId: string,
  contact: { id: string; phone: string | null; blocked?: boolean },
) {
  const phone = String(contact.phone ?? '').replace(/\D/g, '')
  if (PHONE.test(phone)) return { userWaId: phone }

  const { data, error } = await supabase
    .from('contact_identities')
    .select('value')
    .eq('account_id', accountId)
    .eq('contact_id', contact.id)
    .eq('kind', 'bsuid')
    .is('superseded_at', null)
    .maybeSingle()
  if (error) throw new Error('calling_contact_identity_lookup_failed')
  if (data?.value) return { recipient: data.value }
  return null
}

export async function GET(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const limit = checkRateLimit('calls:permission-read:' + userId, RATE_LIMITS.react)
    if (!limit.success) return rateLimitResponse(limit)

    const { searchParams } = new URL(request.url)
    const contactId = searchParams.get('contact_id') ?? ''
    if (!/^[0-9a-f-]{36}$/i.test(contactId)) {
      return NextResponse.json({ error: 'A valid contact_id is required' }, { status: 400 })
    }

    const contact = await loadContact(supabase, accountId, contactId)
    if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    if (contact.blocked) return NextResponse.json({ error: 'Calls are unavailable for blocked contacts' }, { status: 403 })

    const target = await loadPermissionTarget(supabase, accountId, contact)
    if (!target) return NextResponse.json({ error: 'Contact has no usable WhatsApp identity' }, { status: 409 })

    const config = await getWhatsAppCallingConfig(supabase, accountId)
    const permission = await getWhatsAppCallPermission({
      phoneNumberId: config.phoneNumberId,
      accessToken: config.accessToken,
      ...target,
    })

    const expirationTime = permission.status === 'temporary' ? permission.expirationTime! : null
    const { error: saveError } = await callingSupabaseAdmin()
      .from('whatsapp_call_permissions')
      .upsert({
        account_id: accountId,
        phone_number_id: config.phoneNumberId,
        contact_id: contact.id,
        status: permission.status,
        expiration_time: expirationTime,
        last_checked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'phone_number_id,contact_id' })

    if (saveError) {
      console.error('[calling-api] permission snapshot persistence failed', { code: saveError.code ?? 'unknown' })
      return NextResponse.json({ error: 'Could not save permission status' }, { status: 500 })
    }

    return NextResponse.json({
      permission,
      can_request_permission: canPerformWhatsAppCallAction(permission, 'send_call_permission_request'),
      can_start_call: hasActiveWhatsAppCallPermission(permission) &&
        canPerformWhatsAppCallAction(permission, 'start_call'),
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const limit = checkRateLimit('calls:permission-request:' + userId, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    let body: { contact_id?: unknown; body_text?: unknown }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const contactId = typeof body.contact_id === 'string' ? body.contact_id : ''
    if (!/^[0-9a-f-]{36}$/i.test(contactId)) {
      return NextResponse.json({ error: 'A valid contact_id is required' }, { status: 400 })
    }

    const contact = await loadContact(supabase, accountId, contactId)
    if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    if (contact.blocked) return NextResponse.json({ error: 'Calls are unavailable for blocked contacts' }, { status: 403 })

    const phone = String(contact.phone ?? '').replace(/\D/g, '')
    if (!PHONE.test(phone)) {
      return NextResponse.json({
        error: 'Permission requests to phone-less / BSUID-only contacts are not enabled in CALL-02.',
      }, { status: 409 })
    }

    // A free-form call-permission request is allowed only inside the
    // 24-hour customer-service window. Template requests are a later path.
    const { data: conversations, error: conversationError } = await supabase
      .from('conversations')
      .select('id')
      .eq('account_id', accountId)
      .eq('contact_id', contact.id)
      .order('created_at', { ascending: true })
      .limit(1)

    if (conversationError) throw new Error('calling_conversation_lookup_failed')
    const conversationId = conversations?.[0]?.id
    if (!conversationId) {
      return NextResponse.json({
        error: 'A WhatsApp customer-service window is required for a free-form permission request.',
        code: 'template_required',
      }, { status: 409 })
    }

    const { data: lastInbound, error: inboundError } = await supabase
      .from('messages')
      .select('created_at')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (inboundError) throw new Error('calling_service_window_lookup_failed')
    const lastInboundAt = lastInbound?.created_at ? new Date(lastInbound.created_at).getTime() : 0
    const windowOpen = Number.isFinite(lastInboundAt) &&
      lastInboundAt > 0 &&
      Date.now() - lastInboundAt >= 0 &&
      Date.now() - lastInboundAt < 24 * 60 * 60 * 1000

    if (!windowOpen) {
      return NextResponse.json({
        error: 'The 24-hour customer-service window is closed. An approved call-permission template is required.',
        code: 'template_required',
      }, { status: 409 })
    }

    const config = await getWhatsAppCallingConfig(supabase, accountId)
    const permission = await getWhatsAppCallPermission({
      phoneNumberId: config.phoneNumberId,
      accessToken: config.accessToken,
      userWaId: phone,
    })

    if (hasActiveWhatsAppCallPermission(permission)) {
      return NextResponse.json({
        error: 'The customer already has an active call permission.',
        code: 'permission_already_active',
        permission,
      }, { status: 409 })
    }

    if (!canPerformWhatsAppCallAction(permission, 'send_call_permission_request')) {
      return NextResponse.json({
        error: 'Meta currently does not allow another call-permission request for this customer.',
        code: 'meta_permission_request_limit',
        permission,
      }, { status: 429 })
    }

    const bodyText = typeof body.body_text === 'string' && body.body_text.trim()
      ? body.body_text.trim()
      : '¿Nos autorizas a llamarte por WhatsApp para atender tu consulta?'
    if (bodyText.length > 1024) {
      return NextResponse.json({ error: 'body_text must be 1024 characters or fewer' }, { status: 400 })
    }

    const sent = await sendWhatsAppCallPermissionRequest({
      phoneNumberId: config.phoneNumberId,
      accessToken: config.accessToken,
      messagingAccountId: config.messagingAccountId,
      to: phone,
      bodyText,
    })

    const { error: requestSaveError } = await callingSupabaseAdmin()
      .from('whatsapp_call_permission_requests')
      .insert({
        account_id: accountId,
        phone_number_id: config.phoneNumberId,
        contact_id: contact.id,
        request_message_id: sent.messageId,
        requested_by_user_id: userId,
      })

    if (requestSaveError) {
      console.error('[calling-api] permission request audit insert failed after Meta accepted send', {
        account_id: accountId,
        code: requestSaveError.code ?? 'unknown',
      })
      return NextResponse.json({
        error: 'Meta accepted the permission request, but WACRM could not record its audit row. Do not resend until the conversation is checked.',
        code: 'permission_request_sent_audit_failed',
      }, { status: 502 })
    }

    return NextResponse.json({
      success: true,
      message_id: sent.messageId,
      permission_request_status: 'pending',
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
