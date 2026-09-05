import {
  sendInteractiveButtons,
  sendInteractiveList,
  sendMediaMessage,
  sendTextMessage,
  type InteractiveButton,
  type InteractiveListSection,
  type MediaKind,
} from '@/lib/whatsapp/meta-api'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import { resolveOutboundTransport } from '@/lib/whatsapp/send-message'
import { sendManyChatTextToContact, sendManyChatFlowToContact } from '@/lib/manychat/contact-send'
import { supabaseAdmin } from './admin-client'

// ------------------------------------------------------------
// Flows-side Meta sender (interactive variants).
//
// Mirrors src/lib/automations/meta-send.ts (engineSendText /
// engineSendTemplate) but emits interactive button + list messages.
// Kept separate from the automations file so the two engines don't
// fight over each other's shape — once both stabilize, the
// phone-variant retry + DB persistence are obvious extraction
// candidates into a shared base.
//
// PR #1 ships this in isolation: callers don't exist yet. PR #2
// brings the flow runner online and wires it up. Shipping it now
// keeps the foundation PR self-contained and unit-testable.
// ------------------------------------------------------------

interface SendTextEngineArgs {
  /** Account-level tenancy key. Drives contact + whatsapp_config
   *  lookups so a flow authored by user A still sends through the
   *  WhatsApp number user B saved on the same account. */
  accountId: string
  /** Original author of the flow — used for INSERT audit columns
   *  and for resolving the agent's identity in logs. Not consulted
   *  for tenancy. */
  userId: string
  conversationId: string
  contactId: string
  text: string
  /** Marks the persisted message row `ai_generated = true` so the inbox
   *  badges it as an AI reply. Only the auto-reply bot sets this;
   *  deterministic Flow/automation sends leave it false. */
  aiGenerated?: boolean
}

/**
 * Send a plain-text WhatsApp message from the Flows engine.
 *
 * Used by the runner's `send_message` and `collect_input` nodes —
 * both prompt the customer with text and either auto-advance (the
 * send_message case) or suspend awaiting a text reply (collect_input);
 * `collect_input`'s reprompt-on-fallback path also calls this, so all
 * three text-sending call sites become transport-aware from this one
 * change.
 *
 * Transport-aware: routes through ManyChat instead of Meta while this
 * account is bridged (`resolveOutboundTransport` — the SAME helper
 * `src/lib/ai/send.ts` already imports from
 * `@/lib/whatsapp/send-message`, reused here rather than duplicated).
 * AI's own call site into this function only ever reaches the Meta
 * branch below (it pre-checks transport itself and takes a separate
 * ManyChat path before ever calling this), so this change is a no-op
 * for AI and closes the gap for Flows, which previously always used
 * Meta regardless of the account's configured transport.
 *
 * Wraps the same phone-variant retry + DB persistence pattern as the
 * interactive senders; the duplication will be DRY'd into a shared
 * `engineSendBase` once the v2 features (templates with variables,
 * media sends) settle.
 */
export async function engineSendText(
  args: SendTextEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  if (resolveOutboundTransport(args.accountId) === 'manychat') {
    return sendTextViaManyChat(args)
  }

  const db = supabaseAdmin()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
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
    .eq('account_id', args.accountId)
    .single()
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account')
  }

  const accessToken = decrypt(config.access_token)

  const attempt = async (phone: string): Promise<string> => {
    const r = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      text: args.text,
    })
    return r.messageId
  }

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

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: 'text',
    content_text: args.text,
    message_id: waMessageId,
    status: 'sent',
    ai_generated: args.aiGenerated ?? false,
  })
  if (msgErr) {
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text: args.text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)

  return { whatsapp_message_id: waMessageId }
}

/**
 * ManyChat branch of `engineSendText` — mirrors `src/lib/ai/send.ts`'s
 * ManyChat path (same transport primitive, same persistence shape),
 * with the one deliberate difference the spec calls for: `ai_generated`
 * stays false (a Flow send is deterministic, not model-generated) and
 * `sender_type` stays `'bot'` (never `'agent'` — this is not a human
 * reply, so it must never be mistaken for one).
 *
 * Deliberately does NOT touch `flow_runs` — a Flow's own outbound send
 * is not an agent stepping in and must never pause the very run that's
 * sending it.
 */
async function sendTextViaManyChat(
  args: SendTextEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  let whatsappMessageId: string
  try {
    const result = await sendManyChatTextToContact({
      db,
      accountId: args.accountId,
      contactId: args.contactId,
      text: args.text,
    })
    whatsappMessageId = result.whatsappMessageId
  } catch (err) {
    console.error(
      '[flows] ManyChat send failed:',
      err instanceof Error ? err.message : String(err),
    )
    throw err
  }

  const { error: msgError } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: 'text',
    content_text: args.text,
    message_id: whatsappMessageId,
    status: 'sent',
    ai_generated: args.aiGenerated ?? false,
  })
  if (msgError) {
    throw new Error(`sent via ManyChat but DB insert failed: ${msgError.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text: args.text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)

  return { whatsapp_message_id: whatsappMessageId }
}

interface SendMediaEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  kind: MediaKind
  /** Public URL Meta fetches at send time — also the canonical asset
   *  reference persisted regardless of transport (see the ManyChat
   *  branch below). */
  link: string
  caption?: string
  /** Document-only; ignored by Meta for image/video. */
  filename?: string
  /**
   * TEMPORARY ManyChat coexistence bridge (PENDIENTE 02.1B). When set
   * AND this account resolves to ManyChat transport, triggers this
   * ManyChat Automation Flow (via `sendFlow`) instead of failing
   * closed. Ignored entirely under Meta transport. See
   * `SendMediaNodeConfig.manychat_bridge_flow_ns` in types.ts.
   */
  manychatBridgeFlowNs?: string
}

/**
 * Send an image / video / document from the Flows engine.
 *
 * Used by the runner's `send_media` node. Auto-advances after the
 * send lands (same suspend semantics as send_message).
 *
 * Transport-aware, same `resolveOutboundTransport` check
 * `engineSendText` above uses:
 *   - Meta (unchanged): phone-variant retry + DB persistence, same as
 *     before this bridge existed.
 *   - ManyChat: FAILS CLOSED unless `manychatBridgeFlowNs` is set — the
 *     ManyChat Public API has no documented WhatsApp media send, so
 *     rather than guess at one, a configured node instead triggers a
 *     manually-authored ManyChat Automation Flow (containing only the
 *     asset) via `sendManyChatFlowToContact`. Never falls back to
 *     Meta in either sub-case (no bridge configured, or the bridge
 *     call itself fails) — that would silently send through the wrong
 *     number's channel while ManyChat still owns it operationally.
 */
export async function engineSendMedia(
  args: SendMediaEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  if (resolveOutboundTransport(args.accountId) === 'manychat') {
    return sendMediaViaManyChatBridge(args)
  }

  const db = supabaseAdmin()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
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
    .eq('account_id', args.accountId)
    .single()
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account')
  }

  const accessToken = decrypt(config.access_token)

  const attempt = async (phone: string): Promise<string> => {
    const r = await sendMediaMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      kind: args.kind,
      link: args.link,
      caption: args.caption,
      filename: args.filename,
    })
    return r.messageId
  }

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

  // content_type='image'|'video'|'document' — these are already in the
  // messages_content_type_check constraint (migration 001 + 010).
  // content_text carries the caption (or empty) so the conversation
  // list preview shows something meaningful when the user glances at it.
  // media_url is the canonical asset reference the Inbox renders from
  // (see src/components/inbox/message-media.tsx) — was missing here
  // even though the ManyChat bridge branch below already persists it;
  // this keeps both transports symmetric for the same send_media node.
  const preview = args.caption?.trim() || `[${args.kind}]`
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: args.kind,
    content_text: args.caption ?? null,
    media_url: args.link,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text: preview,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)

  return { whatsapp_message_id: waMessageId }
}

/**
 * ManyChat branch of `engineSendMedia` — the TEMPORARY media bridge
 * (PENDIENTE 02.1B). FAILS CLOSED when the node has no
 * `manychatBridgeFlowNs` configured: never attempts a send, never
 * falls back to Meta. When one IS configured, triggers it via
 * `sendManyChatFlowToContact` and persists exactly like the Meta
 * branch, with `media_url` set to the canonical WACRM asset URL
 * (`args.link`) even though ManyChat's own relay Flow — not this
 * call — is what actually delivers the asset; that keeps the Inbox
 * showing the right asset AND keeps this same node Meta-native the
 * moment the account cuts over (media_url is already correct; only
 * the bridge field becomes unused).
 *
 * Deliberately does NOT touch `flow_runs` — this send is the Flow
 * itself acting, not a human agent stepping in, so it must never
 * pause the very run that's sending it.
 */
async function sendMediaViaManyChatBridge(
  args: SendMediaEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  if (!args.manychatBridgeFlowNs) {
    throw new Error(
      '[flows] send_media has no manychat_bridge_flow_ns configured — cannot send media while this account is bridged through ManyChat. This send was NOT attempted via Meta. Set a temporary ManyChat bridge Flow ns on this node, or wait for the Meta cutover.',
    )
  }

  const db = supabaseAdmin()

  let whatsappMessageId: string
  try {
    const result = await sendManyChatFlowToContact({
      db,
      accountId: args.accountId,
      contactId: args.contactId,
      flowNs: args.manychatBridgeFlowNs,
    })
    whatsappMessageId = result.whatsappMessageId
  } catch (err) {
    console.error(
      '[flows] ManyChat media bridge send failed:',
      err instanceof Error ? err.message : String(err),
    )
    throw err
  }

  const preview = args.caption?.trim() || `[${args.kind}]`
  const { error: msgError } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: args.kind,
    content_text: args.caption ?? null,
    media_url: args.link,
    message_id: whatsappMessageId,
    status: 'sent',
    ai_generated: false,
  })
  if (msgError) {
    throw new Error(`sent via ManyChat bridge but DB insert failed: ${msgError.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text: preview,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)

  return { whatsapp_message_id: whatsappMessageId }
}

interface SendInteractiveButtonsEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttons: InteractiveButton[]
  headerText?: string
  footerText?: string
}

interface SendInteractiveListEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttonLabel: string
  sections: InteractiveListSection[]
  headerText?: string
  footerText?: string
}

/**
 * Send an interactive-button WhatsApp message from the Flows engine.
 *
 * Persists the outgoing message to `messages` with
 * `content_type='interactive'` and `sender_type='bot'` so the inbox
 * surfaces it with the "Button reply" affordance and the conversation
 * thread reflects the bot's prompt.
 *
 * Returns the Meta message id so the caller (engine) can stash it on
 * the `flow_runs.last_prompt_message_id` field for later reference.
 */
export async function engineSendInteractiveButtons(
  args: SendInteractiveButtonsEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaMeta({ ...args, kind: 'buttons' })
}

/**
 * Send an interactive-list WhatsApp message from the Flows engine.
 * Used when the flow needs more than 3 options (Meta's button cap).
 */
export async function engineSendInteractiveList(
  args: SendInteractiveListEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaMeta({ ...args, kind: 'list' })
}

type SendInput =
  | (SendInteractiveButtonsEngineArgs & { kind: 'buttons' })
  | (SendInteractiveListEngineArgs & { kind: 'list' })

async function sendInteractiveViaMeta(
  input: SendInput,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  // Scope the contact + whatsapp_config lookups by account_id —
  // same defense-in-depth rationale as automations/meta-send.ts.
  // Migration 017 moved both tables to account-scoped tenancy.
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

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'buttons') {
      const r = await sendInteractiveButtons({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        bodyText: input.bodyText,
        buttons: input.buttons,
        headerText: input.headerText,
        footerText: input.footerText,
      })
      return r.messageId
    }
    const r = await sendInteractiveList({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      bodyText: input.bodyText,
      buttonLabel: input.buttonLabel,
      sections: input.sections,
      headerText: input.headerText,
      footerText: input.footerText,
    })
    return r.messageId
  }

  // Same phone-variant retry as automations/meta-send.ts. Numbers
  // registered with/without a trunk 0 + Meta's sandbox quirks all
  // need this to reliably land a message.
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

  // Persist the bot's prompt to the messages table so it appears in
  // the inbox. content_type='interactive' is supported as of
  // migration 010; sender_type='bot' distinguishes flow sends from
  // manual agent sends (the conversation list preview will pick up
  // last_message_text as a sensible summary).
  //
  // We do NOT set interactive_reply_id here — that column is reserved
  // for the customer's tap on this message, populated by the webhook
  // when their reply arrives. We DO persist the structured payload so
  // the inbox thread re-renders the buttons/rows the bot sent (round-
  // trip), matching the composer + automation send paths.
  const interactivePayload: InteractiveMessagePayload =
    input.kind === 'buttons'
      ? {
          kind: 'buttons',
          body: input.bodyText,
          header: input.headerText,
          footer: input.footerText,
          buttons: input.buttons,
        }
      : {
          kind: 'list',
          body: input.bodyText,
          header: input.headerText,
          footer: input.footerText,
          button_label: input.buttonLabel,
          sections: input.sections,
        }

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: input.conversationId,
    sender_type: 'bot',
    content_type: 'interactive',
    content_text: input.bodyText,
    interactive_payload: interactivePayload,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text: input.bodyText,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.conversationId)

  return { whatsapp_message_id: waMessageId }
}
