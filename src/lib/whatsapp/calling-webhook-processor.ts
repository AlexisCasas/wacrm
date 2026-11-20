import type { SupabaseClient } from '@supabase/supabase-js'
import { findExistingContact } from '@/lib/contacts/dedupe'
import { resolveInboundContact } from '@/lib/contacts/resolve-identity'
import { findOrCreateConversation } from '@/lib/conversations/find-or-create'
import { resolveInboundIdentity } from '@/lib/whatsapp/resolve-sender-identity'
import { pairContact } from '@/lib/whatsapp/pair-contact'
import { isBsuidPilotEnabledWithScopes } from '@/lib/whatsapp/bsuid-pilot'
import { getDbPilotScopes } from '@/lib/whatsapp/bsuid-flow-auth'
import { parseWhatsAppCallingWebhookChange } from '@/lib/whatsapp/calling-webhook'

interface CallingConfig {
  account_id: string
  user_id: string
  phone_number_id: string
  waba_id: string | null
}

function unixSecondsToIso(value: string | undefined): string | null {
  if (!value || !/^\d{1,12}$/.test(value)) return null
  const seconds = Number(value)
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null
  const date = new Date(seconds * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

async function findExistingCallContact(
  db: SupabaseClient,
  accountId: string,
  identity: Extract<ReturnType<typeof resolveInboundIdentity>, { ok: true }>,
  bsuidEnabled: boolean,
) {
  if (bsuidEnabled && identity.bsuid) {
    const { data: identityRow, error: identityError } = await db
      .from('contact_identities')
      .select('contact_id')
      .eq('account_id', accountId)
      .eq('kind', 'bsuid')
      .eq('value', identity.bsuid)
      .is('superseded_at', null)
      .maybeSingle()
    if (identityError) throw new Error('calling_contact_identity_lookup_failed')
    if (identityRow?.contact_id) {
      const { data, error } = await db
        .from('contacts')
        .select('id, phone, name, blocked')
        .eq('account_id', accountId)
        .eq('id', identityRow.contact_id)
        .maybeSingle()
      if (error) throw new Error('calling_contact_lookup_failed')
      if (data) return data
    }
  }

  if (identity.phone) {
    return await findExistingContact(db, accountId, identity.phone)
  }
  return null
}

/**
 * Persist signed Meta Calling events. The webhook route has already
 * verified the raw HMAC and replaced plaintext SDP with application-
 * encrypted ciphertext before this durable payload is processed.
 */
export async function processWhatsAppCallingWebhookChange(
  db: SupabaseClient,
  change: unknown,
  envelopeWabaId?: string,
): Promise<void> {
  if (process.env.WHATSAPP_CALLING_ENABLED !== 'true') return
  const parsed = parseWhatsAppCallingWebhookChange(change)
  if (!parsed) throw new Error('calling_webhook_payload_invalid')

  const { data: configs, error: configError } = await db
    .from('whatsapp_config')
    .select('account_id, user_id, phone_number_id, waba_id, calling_enabled')
    .eq('phone_number_id', parsed.phoneNumberId)
    .limit(2)

  if (configError) {
    console.error('[calling-webhook] account lookup failed', { code: configError.code ?? 'unknown' })
    throw new Error('calling_webhook_config_lookup_failed')
  }
  if (!configs || configs.length !== 1) {
    console.error('[calling-webhook] phone number did not resolve to exactly one account')
    throw new Error('calling_webhook_config_ambiguous')
  }

  const config = configs[0] as CallingConfig & { calling_enabled: boolean }
  if (config.calling_enabled !== true) return
  const bsuidEnabled = isBsuidPilotEnabledWithScopes(
    {
      accountId: config.account_id,
      wabaId: config.waba_id,
      phoneNumberId: parsed.phoneNumberId,
      envelopeWabaId,
    },
    await getDbPilotScopes(),
  )

  for (let index = 0; index < parsed.calls.length; index++) {
    const call = parsed.calls[index]
    const userInitiated = call.direction === 'USER_INITIATED'
    const businessInitiated = call.direction === 'BUSINESS_INITIATED'

    let contactId: string | null = null
    let conversationId: string | null = null
    let contactPhone: string | null = null
    let contactUserId: string | null = null

    if (userInitiated || businessInitiated) {
      const senderPhone = userInitiated ? call.from : call.to
      const senderUserId = userInitiated ? call.from_user_id : call.to_user_id
      const senderParentUserId = userInitiated ? call.from_parent_user_id : call.to_parent_user_id
      const pairedContact = pairContact(
        { from: senderPhone, from_user_id: senderUserId },
        parsed.contacts,
        index,
      )
      const resolved = resolveInboundIdentity(
        {
          from: senderPhone,
          from_user_id: senderUserId,
          from_parent_user_id: senderParentUserId,
          type: 'call',
        },
        pairedContact,
      )

      if (resolved.ok && (resolved.phone || (bsuidEnabled && resolved.bsuid))) {
        const identity = bsuidEnabled
          ? resolved
          : { ...resolved, bsuid: undefined, parentBsuid: undefined, previousBsuid: undefined, username: undefined }

        const contact = userInitiated
          ? await resolveInboundContact(
              db,
              config.account_id,
              config.user_id,
              identity,
              pairedContact?.profile?.name?.trim() ?? '',
            )
          : {
              contact: await findExistingCallContact(db, config.account_id, identity, bsuidEnabled),
              wasCreated: false,
            }

        if (contact?.contact) {
          contactId = contact.contact.id
          contactPhone = identity.phone ?? null
          contactUserId = bsuidEnabled ? identity.bsuid ?? null : null

          // Incoming calls open/reuse the same contact conversation used by
          // messages. Blocked contacts remain linked to the call record but
          // are not given a new conversation or any automated response.
          if (userInitiated && !contact.contact.blocked) {
            const conversation = await findOrCreateConversation(
              db,
              config.account_id,
              config.user_id,
              contact.contact.id,
            )
            if (!conversation) throw new Error('calling_conversation_resolution_failed')
            conversationId = conversation.conversation.id
          } else if (businessInitiated) {
            const { data: conversationRows, error: conversationError } = await db
              .from('conversations')
              .select('id')
              .eq('account_id', config.account_id)
              .eq('contact_id', contact.contact.id)
              .order('created_at', { ascending: true })
              .limit(1)
            if (conversationError) throw new Error('calling_conversation_lookup_failed')
            conversationId = conversationRows?.[0]?.id ?? null
          }
        }
      }
    }

    const eventAt = unixSecondsToIso(call.timestamp)
    if (!eventAt) throw new Error('calling_webhook_timestamp_invalid')

    const { error: upsertError } = await db.rpc('upsert_whatsapp_call_session_event', {
      p_account_id: config.account_id,
      p_phone_number_id: parsed.phoneNumberId,
      p_call_id: call.id,
      p_contact_id: contactId,
      p_conversation_id: conversationId,
      p_contact_phone: contactPhone,
      p_contact_user_id: contactUserId,
      p_direction: call.direction ?? null,
      p_event: call.event,
      p_status: call.status ?? null,
      p_event_at: eventAt,
      p_start_time: unixSecondsToIso(call.start_time),
      p_end_time: unixSecondsToIso(call.end_time),
      p_duration_seconds: Number.isInteger(call.duration) ? call.duration : null,
      p_sdp_type: call.session?.sdp_type ?? null,
      p_sdp_ciphertext: call.session?.sdpCiphertext ?? null,
      p_sdp_expires_at: call.session?.sdpCiphertext
        ? new Date(Date.now() + 90_000).toISOString()
        : null,
    })

    if (upsertError) {
      console.error('[calling-webhook] call event persistence failed', {
        account_id: config.account_id,
        code: upsertError.code ?? 'unknown',
      })
      throw new Error('calling_session_persist_failed')
    }
  }

  // Call status notifications can arrive separately from the calls[] event.
  // Update an existing session only; never create an orphan session from a
  // status-only delivery.
  for (const status of parsed.statuses) {
    if (status.type !== 'call' || !status.id.startsWith('wacid.')) continue
    const { data: existing, error: existingError } = await db
      .from('whatsapp_call_sessions')
      .select('id, direction, contact_id, conversation_id, contact_phone, contact_user_id')
      .eq('account_id', config.account_id)
      .eq('phone_number_id', parsed.phoneNumberId)
      .eq('call_id', status.id)
      .maybeSingle()
    if (existingError) throw new Error('calling_status_session_lookup_failed')
    if (!existing) continue

    const eventAt = unixSecondsToIso(status.timestamp)
    if (!eventAt) continue
    const { error } = await db.rpc('upsert_whatsapp_call_session_event', {
      p_account_id: config.account_id,
      p_phone_number_id: parsed.phoneNumberId,
      p_call_id: status.id,
      p_contact_id: existing.contact_id,
      p_conversation_id: existing.conversation_id,
      p_contact_phone: existing.contact_phone,
      p_contact_user_id: existing.contact_user_id,
      p_direction: existing.direction,
      p_event: 'status',
      p_status: status.status,
      p_event_at: eventAt,
      p_start_time: null,
      p_end_time: null,
      p_duration_seconds: null,
      p_sdp_type: null,
      p_sdp_ciphertext: null,
      p_sdp_expires_at: null,
    })
    if (error) throw new Error('calling_status_persist_failed')
  }
}
