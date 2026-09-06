import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import {
  engineSendText as flowsEngineSendText,
  engineSendMedia as flowsEngineSendMedia,
  engineSendInteractiveButtons,
  engineSendInteractiveList,
} from '@/lib/flows/meta-send'
import type { MediaKind } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import {
  resolveTemplateRow,
  templateContentText,
} from '@/lib/whatsapp/template-body'
import { supabaseAdmin } from './admin-client'

// ------------------------------------------------------------
// Automation-side Meta sender.
//
// Mirrors the logic in src/app/api/whatsapp/send/route.ts but uses
// the service-role client (engine has no cookies) and accepts the
// user / conversation / contact identifiers the engine already has
// on hand. Kept here (rather than refactoring the user-facing send
// route) to avoid risk to the working manual-send path — they can
// converge in a later refactor.
//
// `send_message` (plain text) is now a thin delegate to
// `@/lib/flows/meta-send`'s `engineSendText` — see that module for
// why: it already resolves `WHATSAPP_OUTBOUND_TRANSPORT` (Meta vs the
// temporary ManyChat bridge) and both engines want byte-identical
// persistence (sender_type='bot', conversation last_message_* update).
// Reusing it here means Automations and Flows can never drift on that
// logic. `send_template` / interactive sends have no ManyChat
// equivalent (ManyChat's Public API has no template-send primitive to
// bridge to), so `sendViaMeta` below stays Meta-only, template-scoped.
// ------------------------------------------------------------

interface SendTextArgs {
  /** Account-level tenancy key. Drives contact + whatsapp_config
   *  lookups so an automation authored by user A still sends through
   *  the WhatsApp number user B saved on the same account. */
  accountId: string
  /** Original author of the automation/flow — used for INSERT audit
   *  columns (messages.sender_id-ish) and for resolving the agent's
   *  identity in logs. Not consulted for tenancy. */
  userId: string
  conversationId: string
  contactId: string
  text: string
}

interface SendTemplateArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  templateName: string
  language?: string
  params?: string[]
}

/**
 * Transport-aware: Meta by default, or the temporary ManyChat bridge
 * when `WHATSAPP_OUTBOUND_TRANSPORT=manychat` resolves this account —
 * see `resolveOutboundTransport` inside `@/lib/flows/meta-send`'s
 * `engineSendText`, which owns 100% of that decision and the resulting
 * persistence. Automations never re-implements or re-checks transport.
 */
export async function engineSendText(args: SendTextArgs): Promise<{ whatsapp_message_id: string }> {
  return flowsEngineSendText(args)
}

export async function engineSendTemplate(
  args: SendTemplateArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendTemplateViaMeta(args)
}

interface SendMediaArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  kind: MediaKind
  link: string
  caption?: string
  filename?: string
  /** Temporary ManyChat coexistence bridge — see `send_media`'s
   *  `manychat_bridge_flow_ns` config field. */
  manychatBridgeFlowNs?: string
}

/**
 * Transport-aware, same delegation pattern as `engineSendText` above:
 * Meta by default, or the temporary ManyChat media bridge
 * (`manychat_bridge_flow_ns`) when this account is bridged. Fails
 * closed under ManyChat transport with no bridge configured — never
 * silently falls back to Meta. All of that logic lives once in
 * `@/lib/flows/meta-send`'s `engineSendMedia`; Automations' `send_media`
 * step reuses it rather than re-implementing the bridge.
 */
export async function engineSendMedia(
  args: SendMediaArgs,
): Promise<{ whatsapp_message_id: string }> {
  return flowsEngineSendMedia({
    accountId: args.accountId,
    userId: args.userId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    kind: args.kind,
    link: args.link,
    caption: args.caption,
    filename: args.filename,
    manychatBridgeFlowNs: args.manychatBridgeFlowNs,
  })
}

interface SendInteractiveArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  payload: InteractiveMessagePayload
}

/**
 * Send an interactive (reply-buttons or list) message from the
 * automation engine.
 *
 * Delegates to the Flows interactive senders
 * (`engineSendInteractiveButtons` / `engineSendInteractiveList`), which
 * already own the account-scoped lookup, phone-variant retry, and the
 * `messages` insert with `interactive_payload` + `sender_type='bot'`.
 * Both engines want identical behaviour here, so there's one
 * implementation rather than a second hand-rolled copy that could drift.
 */
export async function engineSendInteractive(
  args: SendInteractiveArgs,
): Promise<{ whatsapp_message_id: string }> {
  const { payload, accountId, userId, conversationId, contactId } = args
  const common = { accountId, userId, conversationId, contactId }
  if (payload.kind === 'buttons') {
    return engineSendInteractiveButtons({
      ...common,
      bodyText: payload.body,
      headerText: payload.header,
      footerText: payload.footer,
      buttons: payload.buttons,
    })
  }
  return engineSendInteractiveList({
    ...common,
    bodyText: payload.body,
    buttonLabel: payload.button_label,
    headerText: payload.header,
    footerText: payload.footer,
    sections: payload.sections,
  })
}

/**
 * Meta-only, template-scoped. Plain text no longer flows through here —
 * see `engineSendText` above — so this stays a direct sender with no
 * transport branch of its own (ManyChat's Public API has no template
 * send to bridge to).
 */
async function sendTemplateViaMeta(
  input: SendTemplateArgs,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  // Scope the contact + config lookups by account_id, not user_id.
  // The engine uses the service-role client (bypassing RLS); without
  // this filter, an authenticated user could fire their own
  // automations against another tenant's contact UUID and send via
  // their own WhatsApp config to that contact's phone. The 017
  // migration moved both tables to account-scoped tenancy, so the
  // check is the same defense-in-depth as before, just keyed on the
  // new tenancy column.
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', input.contactId)
    .eq('account_id', input.accountId)
    .maybeSingle()
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account')
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', input.accountId)
    .single()
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account')
  }

  const accessToken = decrypt(config.access_token)

  // Local template row — read for the body we persist below, not for
  // the Meta payload (the wire shape is deliberately unchanged here).
  // A missing row is fine: the send still goes out, we just can't
  // reconstruct the text the customer saw.
  const templateRow = (
    await resolveTemplateRow(db, input.accountId, input.templateName, input.language)
  ).row

  const attempt = async (phone: string): Promise<string> => {
    const r = await sendTemplateMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      templateName: input.templateName,
      language: input.language,
      params: input.params,
    })
    return r.messageId
  }

  // Same phone-variant retry as /api/whatsapp/send — Meta sandbox and
  // numbers registered with/without a trunk 0 both require this to
  // reliably land a message.
  const variants = phoneVariants(sanitized)
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const v of variants) {
    try {
      waMessageId = await attempt(v)
      workingPhone = v
      lastError = null
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(msg)) throw err
      lastError = err
    }
  }
  if (lastError) throw lastError

  if (workingPhone !== sanitized) {
    await db.from('contacts').update({ phone: workingPhone }).eq('id', contact.id)
  }

  // Persist the sent message so it appears in the inbox with a real
  // Meta message id. sender_type='bot' distinguishes automation sends
  // from manual agent sends.
  //
  // Templates persist the substituted body, same as the manual and
  // public-API send paths. This was unconditionally null, so every
  // automation template send rendered as an empty bubble (issue #483).
  const content_text = templateContentText(templateRow, input.params ?? [])

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: input.conversationId,
    sender_type: 'bot',
    content_type: 'template',
    content_text,
    template_name: input.templateName,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    // Meta already has the message; record the DB error but don't pretend
    // the send failed. The engine wraps this in a log line.
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text: content_text ?? `[template:${input.templateName}]`,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.conversationId)

  return { whatsapp_message_id: waMessageId }
}
