import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary, HANDOFF_CUSTOMER_NOTICE } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { sendAiTextToConversation } from './send'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import type { AiConfig, ChatMessage } from './types'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
  /**
   * Stand down when the account has an active `new_message_received` /
   * `keyword_match` automation, to avoid double-texting the customer.
   * Default `true` — the correct behavior for any inbound path that
   * ALSO dispatches Automations for this same message (the native Meta
   * webhook: `runAutomationsForTrigger` runs alongside this call).
   *
   * The ManyChat bridge (`POST /api/integrations/manychat/inbound`)
   * deliberately never dispatches Automations at all — a CRM automation
   * being "active" there is irrelevant noise, not a real competing
   * responder — so it passes `false` to skip this check entirely.
   */
  suppressWhenAutomationsActive?: boolean
}

/**
 * Pause the bot on this thread, route it to a human, and tell the
 * customer — used both when the model itself hands off (or fails to
 * answer) and when the deterministic reply cap is reached.
 *
 * Fail-safe ordering, deliberately in this order and no other:
 *   1. Persist the handoff on the conversation (disabled + summary +
 *      assignee) — this is the state that MUST survive no matter what
 *      happens next. Supabase can resolve `{ error }` WITHOUT throwing,
 *      so the persisted-or-not question is answered by inspecting that
 *      `error`, never by "the await resolved". If it's set, the handoff
 *      did NOT happen: log a safe message and throw, so this never
 *      falls through to step 2 (which would tell the customer a human
 *      is coming when nothing was actually routed) — the caller's own
 *      try/catch (`dispatchInboundToAiReply`) absorbs the throw.
 *   2. Only once step 1 confirms no error, attempt the customer-facing
 *      notice.
 * If step 2 throws (ManyChat/Meta down, rate-limited, etc.), the error
 * is swallowed here and logged — the handoff from step 1 is already
 * committed and is NOT rolled back, retried, or used to reactivate the
 * bot. A customer never seeing the notice is an acceptable, recoverable
 * gap (the agent picking up the thread can still see the conversation
 * and reply); a bot that resumes replying after a failed handoff, or a
 * duplicated notice from a naive retry, would not be.
 */
async function handOffConversation(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  conv: { assigned_agent_id: string | null; ai_reply_count: number | null }
  config: AiConfig
  messages: ChatMessage[]
  reason: 'model' | 'cap'
}): Promise<void> {
  const { db, accountId, conversationId, contactId, configOwnerUserId, conv, config, messages, reason } =
    args

  const summary = buildHandoffSummary({
    messages,
    replyCount: conv.ai_reply_count ?? 0,
    reason,
    maxReplies: config.autoReplyMaxPerConversation,
  })
  const update: Record<string, unknown> = {
    ai_autoreply_disabled: true,
    ai_handoff_summary: summary,
  }
  // Only set the assignee when a target is configured AND the thread
  // isn't already owned — never stomp an existing human assignment.
  if (config.handoffAgentId && !conv.assigned_agent_id) {
    update.assigned_agent_id = config.handoffAgentId
  }

  // Step 1 — commit the handoff. Assigning fires the
  // `on_conversation_assigned` trigger, which notifies the agent.
  const { error: handoffError } = await db
    .from('conversations')
    .update(update)
    .eq('id', conversationId)

  if (handoffError) {
    // Never assume persistence just because the await resolved —
    // Supabase reports failures as `{ error }`, not a thrown exception.
    // Nothing below this point may run: no customer notice (it would
    // falsely promise a human is coming), no reply-slot claim, no
    // re-enabling the bot. Safe message only — never the raw error
    // object, which can carry query/DB internals.
    console.error(
      '[ai auto-reply] failed to persist handoff:',
      handoffError.message,
    )
    throw new Error('Failed to persist AI handoff')
  }

  // Step 2 — best-effort customer notice. Deterministic text, never
  // LLM-generated: no extra call, no risk of inventing a timeframe or a
  // detail we don't actually know. Deliberately does NOT go through the
  // reply-slot claim — this isn't a counted auto-reply.
  try {
    await sendAiTextToConversation({
      accountId,
      conversationId,
      contactId,
      text: HANDOFF_CUSTOMER_NOTICE,
      configOwnerUserId,
    })
  } catch (err) {
    console.error(
      '[ai auto-reply] handoff notice failed to send — handoff remains active:',
      err instanceof Error ? err.message : String(err),
    )
  }
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const {
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    suppressWhenAutomationsActive,
  } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — but
    // only on paths that actually dispatch Automations for this same
    // inbound (the native Meta webhook). Message-level automations
    // (`new_message_received` / `keyword_match`) are dispatched
    // independently there and may send their own reply, so if the
    // account has any active one we stand down to avoid double-texting
    // the customer. (Relationship triggers like `first_inbound_message`
    // don't count — they're not per-message auto-responders.)
    //
    // Skipped entirely when `suppressWhenAutomationsActive === false`
    // (the ManyChat bridge): that route never runs Automations at all,
    // so an active automation there is irrelevant — checking it would
    // only ever silence the AI for no reason.
    if (suppressWhenAutomationsActive !== false) {
      const { data: autoResponders } = await db
        .from('automations')
        .select('id')
        .eq('account_id', accountId)
        .eq('is_active', true)
        .in('trigger_type', ['new_message_received', 'keyword_match'])
        .limit(1)
      if (autoResponders && autoResponders.length > 0) return
    }

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    // Handed off / turned off here already — also makes the cap-reached
    // handoff below idempotent: once this fires, no later inbound on
    // this thread reaches the cap branch again, so it can never send a
    // second handoff notice.
    if (conv.ai_autoreply_disabled) return

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // Cheap early-out; the authoritative cap check is the atomic claim
    // further down for a normal reply (this read can race a concurrent
    // inbound). Reaching the cap is itself a handoff — the bot pausing
    // silently here would leave the customer stuck with no reply and no
    // human routed in, contradicting the documented "hits the reply cap
    // → pauses and routes the chat" behavior. Never calls the model.
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) {
      await handOffConversation({
        db,
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        conv,
        config,
        messages,
        reason: 'cap',
      })
      return
    }

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
    })

    const { text, handoff, usage } = await generateReply({
      config,
      systemPrompt,
      messages,
    })

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    if (handoff || !text) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human (pause, route, notify the
      // customer). See handOffConversation for the fail-safe ordering.
      await handOffConversation({
        db,
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        conv,
        config,
        messages,
        reason: 'model',
      })
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) return // lost the per-conversation cap race

    // Transport-aware: sends via ManyChat while this account is bridged
    // (WHATSAPP_OUTBOUND_TRANSPORT=manychat + MANYCHAT_INGEST_ACCOUNT_ID
    // matches), or via Meta's engineSendText otherwise — see
    // src/lib/ai/send.ts for the full contract. Either way this persists
    // sender_type='bot' + ai_generated=true and never pauses flow_runs.
    await sendAiTextToConversation({
      accountId,
      conversationId,
      contactId,
      text,
      configOwnerUserId,
    })
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
