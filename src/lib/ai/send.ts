import { supabaseAdmin } from './admin-client'
import { resolveOutboundTransport } from '@/lib/whatsapp/send-message'
import {
  sendManyChatTextToContact,
  ManyChatNotConfiguredError,
  ManyChatContactNotLinkedError,
  ManyChatMappingLookupError,
} from '@/lib/manychat/contact-send'
import { ManyChatApiError } from '@/lib/manychat/api'
import { engineSendText } from '@/lib/flows/meta-send'

export interface SendAiTextArgs {
  accountId: string
  conversationId: string
  contactId: string
  text: string
  /** WhatsApp config owner — only consulted on the Meta path (it's `engineSendText`'s audit column). */
  configOwnerUserId: string
}

export interface SendAiTextResult {
  whatsapp_message_id: string
}

/**
 * Transport-aware AI outbound sender.
 *
 * `dispatchInboundToAiReply` calls this instead of `engineSendText`
 * directly, so the AI's transport tracks the account's
 * `WHATSAPP_OUTBOUND_TRANSPORT` + `MANYCHAT_INGEST_ACCOUNT_ID` scoping
 * (see `resolveOutboundTransport`) without the AI engine itself
 * knowing or caring which transport is live. When a future cutover
 * flips the account back to 'meta', this same call site keeps working
 * unchanged — no AI engine rewrite needed.
 *
 * ManyChat branch (`resolveOutboundTransport(accountId) === 'manychat'`):
 *   - text only (the caller only ever passes generated text — there is
 *     no media/template/interactive concept for an AI reply);
 *   - resolves the account-scoped `manychat_contact_links` mapping and
 *     calls ManyChat's Public API via the shared transport primitive
 *     `sendManyChatTextToContact` (also used by the manual-agent send
 *     path in `send-message.ts`) — NEVER falls back to Meta;
 *   - persists ONLY after ManyChat confirms success, with
 *     `sender_type='bot'` + `ai_generated=true` — NEVER 'agent';
 *   - deliberately does NOT touch `flow_runs`: an AI auto-reply is not
 *     a human agent stepping in, so it must not trigger the
 *     "pause on agent send" signal `send-message.ts` uses for manual
 *     replies.
 *   On any failure (missing mapping, missing MANYCHAT_API_KEY, a
 *   ManyChat error/timeout/non-success status, or a DB insert failure)
 *   this throws — never persists a false "sent" message. The caller,
 *   `dispatchInboundToAiReply`, already wraps its whole dispatch in a
 *   try/catch that logs `[ai auto-reply] dispatch failed:` and never
 *   rethrows, so no additional handling is required at the call site.
 *
 * Meta branch: delegates to `engineSendText` with `aiGenerated: true`
 * — EXACTLY today's behavior, unchanged.
 */
export async function sendAiTextToConversation(
  args: SendAiTextArgs,
): Promise<SendAiTextResult> {
  const { accountId, conversationId, contactId, text, configOwnerUserId } = args

  if (resolveOutboundTransport(accountId) !== 'manychat') {
    return engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiGenerated: true,
    })
  }

  const db = supabaseAdmin()

  let whatsappMessageId: string
  try {
    const result = await sendManyChatTextToContact({ db, accountId, contactId, text })
    whatsappMessageId = result.whatsappMessageId
  } catch (err) {
    const message =
      err instanceof ManyChatNotConfiguredError ||
      err instanceof ManyChatContactNotLinkedError ||
      err instanceof ManyChatMappingLookupError ||
      err instanceof ManyChatApiError ||
      err instanceof Error
        ? err.message
        : 'Unknown ManyChat send failure'
    console.error('[ai send] ManyChat send failed:', message)
    throw err
  }

  const { error: msgError } = await db.from('messages').insert({
    conversation_id: conversationId,
    sender_type: 'bot',
    content_type: 'text',
    content_text: text,
    message_id: whatsappMessageId,
    status: 'sent',
    ai_generated: true,
  })
  if (msgError) {
    console.error('[ai send] sent via ManyChat but DB insert failed:', msgError.message)
    throw new Error(`AI reply sent via ManyChat but failed to save to DB: ${msgError.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text: text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)

  // Deliberately NOT touching flow_runs here — see the module doc
  // comment above: an AI auto-reply is not a human agent stepping in.

  return { whatsapp_message_id: whatsappMessageId }
}
