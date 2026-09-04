// ============================================================
// Outbound message send — the core that both the dashboard's
// `/api/whatsapp/send` route and the public `/api/v1/messages`
// endpoint call.
//
// Given a conversation and message params, this:
//   1. validates the params for the message type,
//   2. loads the conversation + contact + WhatsApp config,
//   3. sends to Meta (with phone-variant retry + contact auto-fix),
//   4. persists the message + updates the conversation,
//   5. pauses any active Flow run for the contact (agent stepped in).
//
// It is transport-agnostic: it takes a `SupabaseClient` and an
// `accountId` and throws `SendMessageError` on failure. The callers
// own auth, rate-limiting, body parsing, and mapping the error to
// their respective response shapes (internal `{ error }` vs the v1
// envelope). Behaviour is identical to the original inline route —
// this is a straight extraction so the public endpoint can reuse it
// without duplicating ~250 lines of Meta plumbing.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  type MediaKind,
} from '@/lib/whatsapp/meta-api';
import {
  validateInteractivePayload,
  interactivePayloadPreviewText,
  type InteractiveMessagePayload,
} from '@/lib/whatsapp/interactive';
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import type { MessageTemplate } from '@/types';
import {
  resolveTemplateRow,
  templateBodyParams,
  templateContentText,
} from '@/lib/whatsapp/template-body';
import { ManyChatApiError } from '@/lib/manychat/api';
import {
  sendManyChatTextToContact,
  ManyChatNotConfiguredError,
  ManyChatContactNotLinkedError,
  ManyChatMappingLookupError,
} from '@/lib/manychat/contact-send';

export const MEDIA_KINDS = ['image', 'video', 'document', 'audio'] as const;
export const VALID_MESSAGE_TYPES = [
  'text',
  'template',
  'interactive',
  ...MEDIA_KINDS,
] as const;

/**
 * Typed failure with a machine `code` and a suggested HTTP `status`.
 * Callers map it to their own response shape (`toErrorResponse` for
 * the dashboard route, the v1 envelope for the public endpoint).
 */
export class SendMessageError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'SendMessageError';
    this.code = code;
    this.status = status;
  }
}

export interface SendMessageParams {
  conversationId: string;
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  filename?: string | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  /** Legacy positional body params (only used if messageParams.body unset). */
  templateParams?: string[];
  /** Structured template params (header/body/buttons). */
  templateMessageParams?: unknown;
  /** Structured payload for `messageType === 'interactive'`. */
  interactivePayload?: InteractiveMessagePayload | null;
  replyToMessageId?: string | null;
}

export interface SendMessageResult {
  /** Our `messages.id` (the persisted row). */
  messageId: string;
  /**
   * The transport's own message id — Meta's `wamid` when sent via Meta,
   * or `manychat-out:<id>` when sent via the ManyChat bridge (see
   * `resolveOutboundTransport`). Always what's stored in
   * `messages.message_id`.
   */
  whatsappMessageId: string;
}

// ============================================================
// Outbound transport selection (ManyChat coexistence bridge, temporary).
//
// While a WhatsApp number is still operated in ManyChat (see
// src/app/api/integrations/manychat/inbound/route.ts for the inbound
// half), WHATSAPP_OUTBOUND_TRANSPORT=manychat routes agent-composed
// sends through ManyChat's Public API instead of Meta's Cloud API.
//
// This is deliberately scoped to ONE account, not global: wacrm is
// multi-account, and MANYCHAT_INGEST_ACCOUNT_ID already names the
// single account this temporary bridge exists for (the inbound route
// resolves its whatsapp_config from the same var). Reusing it here
// means flipping WHATSAPP_OUTBOUND_TRANSPORT=manychat can never change
// outbound behavior for any OTHER account on this deployment — every
// other account keeps sending via Meta regardless of this env var.
//
// Resolution:
//   transport=manychat AND accountId === MANYCHAT_INGEST_ACCOUNT_ID → manychat
//   transport=manychat AND any other accountId                      → meta
//   transport=meta (or unset/garbage)                                → meta
// ============================================================
export type WhatsAppOutboundTransport = 'meta' | 'manychat';

export function resolveOutboundTransport(accountId: string): WhatsAppOutboundTransport {
  const bridgeAccountId = process.env.MANYCHAT_INGEST_ACCOUNT_ID;
  if (
    process.env.WHATSAPP_OUTBOUND_TRANSPORT === 'manychat' &&
    !!bridgeAccountId &&
    accountId === bridgeAccountId
  ) {
    return 'manychat';
  }
  return 'meta';
}

/**
 * Send a message in an existing conversation and persist it.
 *
 * `db` may be an RLS-scoped user client (dashboard) or the service-
 * role client (public API) — every query is filtered by `accountId`
 * either way, so tenancy holds regardless of which client is passed.
 */
/**
 * Validate the message-shape params (type, required content, caption
 * cap) independently of any DB state, throwing `SendMessageError` on a
 * bad payload. Exported so a caller can reject a malformed request
 * *before* it finds-or-creates a contact/conversation — otherwise an
 * invalid payload leaves an orphan empty conversation behind. The send
 * core calls this too, so validation can't be skipped.
 */
export function validateSendMessageParams(params: {
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  templateName?: string | null;
  interactivePayload?: InteractiveMessagePayload | null;
}): void {
  const { messageType, contentText, mediaUrl, templateName, interactivePayload } =
    params;

  if (!messageType) {
    throw new SendMessageError('bad_request', 'message_type is required', 400);
  }

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(messageType)) {
    throw new SendMessageError(
      'bad_request',
      `Unsupported message_type "${messageType}"`,
      400
    );
  }

  if (messageType === 'text' && !contentText) {
    throw new SendMessageError(
      'bad_request',
      'content_text is required for text messages',
      400
    );
  }

  if (messageType === 'template' && !templateName) {
    throw new SendMessageError(
      'bad_request',
      'template_name is required for template messages',
      400
    );
  }

  // Interactive: validate the full structured payload against Meta's
  // limits up front so a bad payload 400s before we touch Meta.
  if (messageType === 'interactive') {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      throw new SendMessageError('bad_request', result.error, 400);
    }
  }

  if (isMediaKind && !mediaUrl) {
    throw new SendMessageError(
      'bad_request',
      `media_url is required for ${messageType} messages`,
      400
    );
  }

  // Meta caps media captions at 1024 chars (audio carries none).
  if (
    isMediaKind &&
    messageType !== 'audio' &&
    typeof contentText === 'string' &&
    contentText.length > 1024
  ) {
    throw new SendMessageError(
      'bad_request',
      'Caption exceeds the 1024-character limit',
      400
    );
  }
}

export async function sendMessageToConversation(
  db: SupabaseClient,
  accountId: string,
  params: SendMessageParams
): Promise<SendMessageResult> {
  const {
    conversationId,
    messageType,
    contentText,
    mediaUrl,
    filename,
    templateName,
    templateLanguage,
    templateParams,
    templateMessageParams,
    interactivePayload,
    replyToMessageId,
  } = params;

  if (!conversationId) {
    throw new SendMessageError(
      'bad_request',
      'conversation_id is required',
      400
    );
  }

  validateSendMessageParams({
    messageType,
    contentText,
    mediaUrl,
    templateName,
    interactivePayload,
  });

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  // Conversation + contact, account-scoped.
  const { data: conversation, error: convError } = await db
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .single();

  if (convError || !conversation) {
    throw new SendMessageError('not_found', 'Conversation not found', 404);
  }

  // Transport branch — MUST come before any Meta-specific validation
  // below (phone format, whatsapp_config lookup) since accounts bridged
  // through ManyChat deliberately have no whatsapp_config row yet
  // (the number isn't registered directly in WA CRM during this
  // coexistence phase). Everything from here to the end of this
  // function, when this branch is NOT taken, is byte-for-byte the
  // pre-existing Meta send path.
  if (resolveOutboundTransport(accountId) === 'manychat') {
    return sendViaManyChat(db, accountId, {
      conversationId,
      contactId: conversation.contact_id as string,
      messageType,
      contentText,
      replyToMessageId,
    });
  }

  const contact = conversation.contact;
  if (!contact?.phone) {
    throw new SendMessageError(
      'bad_request',
      'Contact phone number not found',
      400
    );
  }

  const sanitizedPhone = sanitizePhoneForMeta(contact.phone);
  if (!isValidE164(sanitizedPhone)) {
    throw new SendMessageError(
      'bad_request',
      'Invalid phone number format',
      400
    );
  }

  // WhatsApp config, account-scoped.
  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single();

  if (configError || !config) {
    throw new SendMessageError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }

  const accessToken = decrypt(config.access_token);

  // Self-heal legacy CBC ciphertexts. Fire-and-forget; idempotent.
  if (isLegacyFormat(config.access_token)) {
    void db
      .from('whatsapp_config')
      .update({ access_token: encrypt(accessToken) })
      .eq('id', config.id)
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) {
          console.warn(
            '[send-message] access_token GCM upgrade failed:',
            error.message
          );
        }
      });
  }

  // Resolve the reply target to its Meta message_id. The parent must
  // belong to this same conversation — otherwise a caller could quote
  // messages they can't see by guessing UUIDs.
  let contextMessageId: string | undefined;
  if (replyToMessageId) {
    const { data: parent, error: parentError } = await db
      .from('messages')
      .select('message_id, conversation_id')
      .eq('id', replyToMessageId)
      .eq('conversation_id', conversationId)
      .maybeSingle();

    if (parentError || !parent) {
      throw new SendMessageError(
        'bad_request',
        'reply_to_message_id not found in this conversation',
        400
      );
    }
    if (!parent.message_id) {
      console.warn(
        '[send-message] reply target has no Meta message_id; sending without context'
      );
    } else {
      contextMessageId = parent.message_id;
    }
  }

  // Template row — needed for the send-builder's header + button
  // components AND for the body we persist. The lookup tolerates the
  // en / en_US split so a caller that omits the language still resolves
  // a row (see resolveTemplateRow).
  let templateRow: MessageTemplate | null = null;
  let sendLanguage = templateLanguage || 'en_US';
  if (messageType === 'template' && templateName) {
    const resolved = await resolveTemplateRow(
      db,
      accountId,
      templateName,
      templateLanguage
    );
    if (resolved.malformed) {
      throw new SendMessageError(
        'template_malformed',
        'Template row is malformed locally — run "Sync from Meta" in Settings to repair it.',
        500
      );
    }
    templateRow = resolved.row;
    sendLanguage = resolved.language;
  }

  const attempt = async (phone: string): Promise<string> => {
    if (messageType === 'template') {
      const result = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        templateName: templateName!,
        language: sendLanguage,
        template: templateRow ?? undefined,
        messageParams: templateMessageParams ?? undefined,
        params: templateParams || [],
        contextMessageId,
      });
      return result.messageId;
    }
    if (isMediaKind) {
      const result = await sendMediaMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        kind: messageType as MediaKind,
        link: mediaUrl!,
        caption: contentText || undefined,
        filename: filename || undefined,
        contextMessageId,
      });
      return result.messageId;
    }
    if (messageType === 'interactive') {
      const p = interactivePayload!;
      if (p.kind === 'buttons') {
        const result = await sendInteractiveButtons({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: phone,
          bodyText: p.body,
          headerText: p.header || undefined,
          footerText: p.footer || undefined,
          buttons: p.buttons,
          contextMessageId,
        });
        return result.messageId;
      }
      const result = await sendInteractiveList({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        bodyText: p.body,
        buttonLabel: p.button_label,
        headerText: p.header || undefined,
        footerText: p.footer || undefined,
        sections: p.sections,
        contextMessageId,
      });
      return result.messageId;
    }
    const result = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      text: contentText!,
      contextMessageId,
    });
    return result.messageId;
  };

  // Send via Meta — retry across phone-number variants if Meta rejects
  // with "recipient not in allowed list"; persist a working variant
  // back to the contact so the next send goes straight through.
  let waMessageId = '';
  let workingPhone = sanitizedPhone;
  try {
    const variants = phoneVariants(sanitizedPhone);
    let lastError: unknown = null;

    for (const variant of variants) {
      try {
        waMessageId = await attempt(variant);
        workingPhone = variant;
        lastError = null;
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isRecipientNotAllowedError(message)) {
          throw err;
        }
        lastError = err;
        console.warn(
          `[send-message] variant "${variant}" rejected by Meta, trying next…`
        );
      }
    }

    if (lastError) throw lastError;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unknown Meta API error';
    console.error('[send-message] Meta send failed for all variants:', message);
    throw new SendMessageError('meta_error', `Meta API error: ${message}`, 502);
  }

  if (workingPhone !== sanitizedPhone) {
    console.log(
      `[send-message] Auto-corrected contact phone: ${sanitizedPhone} → ${workingPhone}`
    );
    await db
      .from('contacts')
      .update({ phone: workingPhone })
      .eq('id', contact.id);
  }

  // Persist the sent message. Field names MUST match the messages
  // schema (see 001_initial_schema.sql).
  // Interactive messages persist the body as content_text (so the
  // conversation-list preview reads sensibly) plus the full structured
  // payload so the thread can re-render the buttons / rows.
  //
  // Templates persist the *substituted* body. The composer pre-renders
  // and posts it as contentText; every other caller (the public API,
  // most importantly) sends none, and storing null there left the
  // Inbox rendering an empty bubble — issue #483.
  const persistedText =
    messageType === 'interactive'
      ? interactivePayload!.body
      : messageType === 'template'
        ? templateContentText(
            templateRow,
            templateBodyParams(templateParams, templateMessageParams),
            contentText
          )
        : (contentText ?? null);

  const { data: messageRecord, error: msgError } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      content_type: messageType,
      content_text: persistedText,
      media_url: mediaUrl || null,
      template_name: templateName || null,
      interactive_payload:
        messageType === 'interactive' ? interactivePayload : null,
      message_id: waMessageId,
      status: 'sent',
      reply_to_message_id: replyToMessageId || null,
    })
    .select()
    .single();

  if (msgError) {
    console.error('[send-message] error inserting sent message:', msgError);
    throw new SendMessageError(
      'db_error',
      `Message sent to Meta but failed to save to DB: ${msgError.message}`,
      500
    );
  }

  const lastMessageText =
    messageType === 'interactive'
      ? interactivePayloadPreviewText(interactivePayload!)
      : persistedText || `[${messageType}]`;

  await db
    .from('conversations')
    .update({
      last_message_text: lastMessageText,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);

  // Pause any active Flow run for this contact — the agent stepping in
  // is the strongest "yield, human is here" signal. Best-effort.
  try {
    const { error: pauseErr } = await supabaseAdmin()
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
        end_reason: 'agent_replied',
      })
      .eq('account_id', accountId)
      .eq('contact_id', contact.id)
      .eq('status', 'active');
    if (pauseErr) {
      console.error('[flows] pause-on-agent-send failed:', pauseErr.message);
    }
  } catch (err) {
    console.error(
      '[flows] pause-on-agent-send threw:',
      err instanceof Error ? err.message : err
    );
  }

  return { messageId: messageRecord.id, whatsappMessageId: waMessageId };
}

// ============================================================
// ManyChat outbound path (temporary coexistence bridge).
//
// Mirrors the shape of the Meta path above — validate → send →
// persist → update conversation → pause flows — but:
//   - text only, no phone/whatsapp_config lookup (ManyChat targets a
//     subscriber id, not a phone number through Meta);
//   - the contact must already be linked via `manychat_contact_links`
//     (populated by the inbound bridge) — no mapping means no send,
//     ever, with no fallback to Meta;
//   - a message is persisted ONLY after ManyChat accepts the send —
//     same ordering guarantee as the Meta path, so a failed send never
//     shows up as delivered in the Inbox.
// ============================================================
interface ManyChatSendArgs {
  conversationId: string;
  contactId: string;
  messageType: string;
  contentText?: string | null;
  replyToMessageId?: string | null;
}

async function sendViaManyChat(
  db: SupabaseClient,
  accountId: string,
  args: ManyChatSendArgs,
): Promise<SendMessageResult> {
  const { conversationId, contactId, messageType, contentText, replyToMessageId } = args;

  // No silent fallback to Meta for anything ManyChat can't carry yet —
  // a clear, typed rejection instead.
  if (messageType !== 'text') {
    throw new SendMessageError(
      'manychat_unsupported_type',
      `ManyChat outbound only supports text messages while WHATSAPP_OUTBOUND_TRANSPORT=manychat (got "${messageType}")`,
      409,
    );
  }

  // Transport only — mapping lookup + the ManyChat wire call, shared
  // with the AI send path (src/lib/ai/send.ts). Carries no opinion
  // about sender_type; that's decided right here, below.
  let messageId: string;
  try {
    const result = await sendManyChatTextToContact({
      db,
      accountId,
      contactId,
      text: contentText!,
    });
    messageId = result.whatsappMessageId;
  } catch (err) {
    if (err instanceof ManyChatNotConfiguredError) {
      throw new SendMessageError('manychat_not_configured', err.message, 503);
    }
    if (err instanceof ManyChatContactNotLinkedError) {
      throw new SendMessageError('manychat_contact_not_linked', err.message, 409);
    }
    if (err instanceof ManyChatMappingLookupError) {
      throw new SendMessageError('db_error', err.message, 500);
    }
    if (err instanceof ManyChatApiError) {
      console.error('[send-message] ManyChat send failed:', err.message);
      throw new SendMessageError('manychat_error', `ManyChat API error: ${err.message}`, 502);
    }
    throw err;
  }

  const { data: messageRecord, error: msgError } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      content_type: 'text',
      content_text: contentText,
      message_id: messageId,
      status: 'sent',
      reply_to_message_id: replyToMessageId || null,
    })
    .select()
    .single();

  if (msgError) {
    console.error('[send-message] error inserting sent (manychat) message:', msgError);
    throw new SendMessageError(
      'db_error',
      `Message sent via ManyChat but failed to save to DB: ${msgError.message}`,
      500,
    );
  }

  await db
    .from('conversations')
    .update({
      last_message_text: contentText || '[text]',
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);

  // Pause any active Flow run — same "agent stepped in" signal as the
  // Meta path. Best-effort.
  try {
    const { error: pauseErr } = await supabaseAdmin()
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
        end_reason: 'agent_replied',
      })
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .eq('status', 'active');
    if (pauseErr) {
      console.error('[flows] pause-on-agent-send failed:', pauseErr.message);
    }
  } catch (err) {
    console.error(
      '[flows] pause-on-agent-send threw:',
      err instanceof Error ? err.message : err,
    );
  }

  return { messageId: messageRecord.id, whatsappMessageId: messageId };
}
