import { createHash, timingSafeEqual } from 'node:crypto'
import { NextResponse, after } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findOrCreateContact } from '@/lib/contacts/find-or-create'
import { findOrCreateConversation } from '@/lib/conversations/find-or-create'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchInboundToFlows } from '@/lib/flows/engine'

/**
 * TEMPORARY bridge: mirrors inbound WhatsApp messages from ManyChat
 * (still the live-sending platform during this migration window) into
 * the WA CRM Inbox — contact, conversation, message, mapping, and
 * (optionally) Flow dispatch / AI auto-reply.
 *
 * Deliberately does NOT run Automations for a message that originated
 * here — this route is a read-only mirror of ManyChat's own inbound
 * handling for everything except Flows/AI. Remove this route once
 * ManyChat is decommissioned.
 *
 * Flows and AI auto-reply are BOTH wired up, each behind its own
 * server-only feature flag (+ optional allowlist), and dispatched from
 * a SINGLE deferred `after()` callback, in a fixed order, so they can
 * never race each other:
 *   1. Flow dispatch first (if `MANYCHAT_FLOWS_ENABLED === 'true'` and
 *      the contact passes `MANYCHAT_FLOW_CONTACT_IDS`, when set).
 *   2. AI auto-reply ONLY if the Flow did not consume the message (if
 *      `MANYCHAT_AI_AUTOREPLY_ENABLED === 'true'` and the contact
 *      passes `MANYCHAT_AI_AUTOREPLY_CONTACT_IDS`, when set).
 * Both flags default to 'false' (see .env.local.example) and both
 * apply ONLY to a genuine new message — the idempotent message upsert
 * below already filters out retries/duplicates before either flag is
 * even consulted. Deferred via `after()` (same pattern the native Meta
 * webhook uses) so ManyChat's External Request gets its 201
 * immediately and never blocks on a Flow delay, an LLM call, or
 * anything else — the persistence/idempotency boundary above stays
 * synchronous; only this dispatch step is deferred. Both
 * `dispatchInboundToFlows` and `dispatchInboundToAiReply` own their
 * own eligibility gates and never throw, so this route doesn't
 * duplicate any of that logic. AI is called with
 * `suppressWhenAutomationsActive: false` — unlike the native Meta
 * webhook, this route never dispatches Automations for the same
 * inbound, so an active CRM automation here is irrelevant noise, not a
 * competing responder.
 *
 * Auth: `Authorization: Bearer <MANYCHAT_INGEST_SECRET>`, compared with
 * `timingSafeEqual` (same pattern as GET /api/automations/cron). No
 * user session/cookies — this is a server-to-server endpoint, and the
 * account it writes into comes from `MANYCHAT_INGEST_ACCOUNT_ID`
 * server-side, never from the request body.
 */

const MAX_ID_LENGTH = 200
const MAX_TEXT_LENGTH = 8000

interface ManyChatInboundPayload {
  contact_id: string
  whatsapp_id: string
  full_name: string | null
  text: string
  last_interaction: string | number | null
  external_id: string | null
}

function timingSafeEqualStrings(supplied: string, expected: string): boolean {
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  // Length check first — timingSafeEqual throws on a length mismatch
  // rather than returning false.
  return (
    suppliedBuf.length === expectedBuf.length &&
    timingSafeEqual(suppliedBuf, expectedBuf)
  )
}

function isNonEmptyString(v: unknown, maxLen: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= maxLen
}

/**
 * ManyChat's `last_interaction` shape isn't guaranteed (ISO string, or
 * a unix timestamp in seconds or milliseconds). Accept the common
 * forms; anything unparseable falls back to `new Date()` per spec.
 */
function parseTimestamp(value: string | number | null): Date {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000
    const d = new Date(ms)
    if (!isNaN(d.getTime())) return d
  }
  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim()
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed)
      const ms = trimmed.length >= 13 ? n : n * 1000
      const d = new Date(ms)
      if (!isNaN(d.getTime())) return d
    } else {
      const d = new Date(trimmed)
      if (!isNaN(d.getTime())) return d
    }
  }
  return new Date()
}

/**
 * Stable internal message_id, prefixed `manychat:` so it can never
 * collide with a Meta `wamid.*` id. Idempotency key for retries:
 *   - `external_id` present → used directly (ManyChat's own dedup key).
 *   - otherwise → deterministic SHA-256 of contact_id + last_interaction
 *     + text, so an identical retry (same three fields) always hashes
 *     to the same id.
 * Enforced at the DB layer by the same (conversation_id, message_id)
 * unique index the Meta webhook relies on (migration 037) via
 * upsert(..., { ignoreDuplicates: true }).
 */
function buildMessageId(payload: ManyChatInboundPayload): string {
  if (payload.external_id) {
    return `manychat:${payload.external_id}`
  }
  const hash = createHash('sha256')
    .update(`${payload.contact_id}\u0000${payload.last_interaction ?? ''}\u0000${payload.text}`)
    .digest('hex')
  return `manychat:${hash}`
}

/**
 * Controlled-rollout allowlist for `MANYCHAT_AI_AUTOREPLY_ENABLED`.
 *
 * `MANYCHAT_AI_AUTOREPLY_CONTACT_IDS` is a comma-separated list of
 * ManyChat contact/subscriber ids. Absent or empty (after trimming each
 * entry) → normal production behavior, every eligible contact. Present
 * with at least one entry → AI only fires for an EXACT match against
 * `manyChatContactId` — the value THIS ROUTE already validated as
 * `payload.contact_id`, never anything else from the request body.
 *
 * Defensive parsing only: split on comma, trim, drop empty entries,
 * exact string match. Never logs the parsed list (it's not a secret,
 * but there's no reason to print it either).
 */
function isManyChatAiAutoreplyAllowed(manyChatContactId: string): boolean {
  const raw = process.env.MANYCHAT_AI_AUTOREPLY_CONTACT_IDS
  if (!raw) return true
  const allowlist = raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
  if (allowlist.length === 0) return true
  return allowlist.includes(manyChatContactId)
}

/**
 * Controlled-rollout allowlist for `MANYCHAT_FLOWS_ENABLED`. Same
 * defensive parsing as `isManyChatAiAutoreplyAllowed` above (separate
 * function, separate env var — each feature flag keeps its own
 * allowlist so the AI pilot and the Flows pilot can be rolled out to
 * different contacts independently).
 */
function isManyChatFlowAllowed(manyChatContactId: string): boolean {
  const raw = process.env.MANYCHAT_FLOW_CONTACT_IDS
  if (!raw) return true
  const allowlist = raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
  if (allowlist.length === 0) return true
  return allowlist.includes(manyChatContactId)
}

export async function POST(request: Request) {
  const secret = process.env.MANYCHAT_INGEST_SECRET
  const accountId = process.env.MANYCHAT_INGEST_ACCOUNT_ID
  if (!secret || !accountId) {
    return NextResponse.json(
      { error: 'ManyChat bridge is not configured' },
      { status: 503 },
    )
  }

  const authHeader = request.headers.get('authorization') ?? ''
  const supplied = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!supplied || !timingSafeEqualStrings(supplied, secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!rawBody || typeof rawBody !== 'object') {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  }
  const body = rawBody as Record<string, unknown>

  if (
    !isNonEmptyString(body.contact_id, MAX_ID_LENGTH) ||
    !isNonEmptyString(body.whatsapp_id, MAX_ID_LENGTH) ||
    !isNonEmptyString(body.text, MAX_TEXT_LENGTH) ||
    (body.full_name != null &&
      (typeof body.full_name !== 'string' || body.full_name.length > MAX_ID_LENGTH)) ||
    (body.last_interaction != null &&
      typeof body.last_interaction !== 'string' &&
      typeof body.last_interaction !== 'number') ||
    (body.external_id != null && !isNonEmptyString(body.external_id, MAX_ID_LENGTH))
  ) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  }

  const phone = normalizePhone(body.whatsapp_id as string)
  if (!phone) {
    return NextResponse.json({ error: 'Invalid whatsapp_id' }, { status: 400 })
  }

  const payload: ManyChatInboundPayload = {
    contact_id: (body.contact_id as string).trim(),
    whatsapp_id: body.whatsapp_id as string,
    full_name: typeof body.full_name === 'string' ? body.full_name.trim() || null : null,
    text: body.text as string,
    last_interaction: (body.last_interaction as string | number | undefined) ?? null,
    external_id:
      typeof body.external_id === 'string' ? body.external_id.trim() || null : null,
  }

  const admin = supabaseAdmin()

  // Resolve the WA CRM account this bridge writes into, server-side,
  // from MANYCHAT_INGEST_ACCOUNT_ID — never from the request body.
  const { data: config, error: configError } = await admin
    .from('whatsapp_config')
    .select('account_id, user_id')
    .eq('account_id', accountId)
    .maybeSingle()

  if (configError) {
    console.error('[manychat-inbound] whatsapp_config lookup failed:', configError.message)
    return NextResponse.json({ error: 'Configuration lookup failed' }, { status: 500 })
  }
  if (!config) {
    console.error('[manychat-inbound] no whatsapp_config row for MANYCHAT_INGEST_ACCOUNT_ID')
    return NextResponse.json({ error: 'Account not configured' }, { status: 404 })
  }

  const contactOutcome = await findOrCreateContact(
    admin,
    config.account_id,
    config.user_id,
    phone,
    payload.full_name || phone,
  )
  if (!contactOutcome) {
    return NextResponse.json({ error: 'Failed to resolve contact' }, { status: 500 })
  }

  // Persist the ManyChat↔CRM contact mapping the outbound bridge relies
  // on (src/lib/whatsapp/send-message.ts, WHATSAPP_OUTBOUND_TRANSPORT=
  // manychat). Runs on EVERY delivery, including retries — the mapping
  // has nothing to do with message idempotency, and a retry should
  // still refresh `whatsapp_id`/`updated_at` if either changed. Kept
  // outside the message-dedup branch below on purpose. Best-effort: a
  // failed link write must not drop the inbound message from the Inbox.
  const { error: linkError } = await admin
    .from('manychat_contact_links')
    .upsert(
      {
        account_id: config.account_id,
        contact_id: contactOutcome.contact.id,
        manychat_contact_id: payload.contact_id,
        whatsapp_id: payload.whatsapp_id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'account_id,contact_id' },
    )
  if (linkError) {
    console.error('[manychat-inbound] manychat_contact_links upsert failed:', linkError.message)
  }

  const convResult = await findOrCreateConversation(
    admin,
    config.account_id,
    config.user_id,
    contactOutcome.contact.id,
  )
  if (!convResult) {
    return NextResponse.json({ error: 'Failed to resolve conversation' }, { status: 500 })
  }
  const conversation = convResult.conversation

  const messageId = buildMessageId(payload)
  const createdAt = parseTimestamp(payload.last_interaction)

  // Determine whether this is the contact's very first inbound message
  // BEFORE we insert, so the count is accurate — same semantics and
  // same placement as the native Meta webhook (see
  // src/app/api/whatsapp/webhook/route.ts). Drives the Flow engine's
  // `first_inbound_message` trigger below.
  const { count: priorCustomerMsgCount } = await admin
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  // Idempotent insert — identical to the Meta webhook's idempotency
  // boundary (migration 037's unique index on (conversation_id,
  // message_id)). A retry with the same payload resolves to the same
  // message_id and conflicts here, returning zero rows.
  const { data: insertedRows, error: msgError } = await admin
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: 'text',
        content_text: payload.text,
        message_id: messageId,
        status: 'delivered',
        created_at: createdAt.toISOString(),
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
    )
    .select('id')

  if (msgError) {
    console.error('[manychat-inbound] message insert failed:', msgError.message)
    return NextResponse.json({ error: 'Failed to store message' }, { status: 500 })
  }

  if (!insertedRows || insertedRows.length === 0) {
    // Replayed delivery — no-op. Do not bump unread again, do not
    // re-run anything below.
    return NextResponse.json({ status: 'duplicate' }, { status: 200 })
  }

  const { error: bumpError } = await admin.rpc('bump_conversation_on_inbound', {
    p_conversation_id: conversation.id,
    p_last_message_text: payload.text,
  })
  if (bumpError) {
    console.error('[manychat-inbound] bump_conversation_on_inbound failed:', bumpError.message)
  }

  await reopenClosedConversation(admin, conversation)

  // Flow dispatch + AI auto-reply — each gated behind its own feature
  // flag (+ optional allowlist for a controlled rollout), evaluated
  // ONLY now that we know this was a genuine new message (past the
  // duplicate/retry early-return above). `payload.contact_id` is the
  // ManyChat contact id this route already validated — the only value
  // either allowlist check is ever compared against.
  const flowEnabled =
    process.env.MANYCHAT_FLOWS_ENABLED === 'true' &&
    isManyChatFlowAllowed(payload.contact_id)
  const aiEligible =
    process.env.MANYCHAT_AI_AUTOREPLY_ENABLED === 'true' &&
    payload.text.trim().length > 0 &&
    isManyChatAiAutoreplyAllowed(payload.contact_id)

  // A SINGLE deferred callback, sequential inside it — never two
  // separate after() registrations — so Flow and AI can't race each
  // other. Deferred so ManyChat's External Request gets its 201
  // immediately: neither a Flow delay/send nor an LLM call ever blocks
  // the response. Tenancy args come entirely from server-resolved
  // state (config.account_id/user_id, the contact/conversation just
  // created or found) — never from the request body.
  if (flowEnabled || aiEligible) {
    after(async () => {
      let flowConsumed = false
      if (flowEnabled) {
        try {
          const flowResult = await dispatchInboundToFlows({
            accountId: config.account_id,
            userId: config.user_id,
            contactId: contactOutcome.contact.id,
            conversationId: conversation.id,
            message: {
              kind: 'text',
              text: payload.text,
              // The bridge's own deterministic `manychat:...` id — same
              // idempotency key the outer message upsert above already
              // used, so a retry that somehow reached this callback
              // (it can't: the outer idempotency check already returns
              // before here) would still be a no-op for the engine's
              // own internal dedup check too.
              meta_message_id: messageId,
            },
            isFirstInboundMessage,
          })
          flowConsumed = flowResult.consumed
        } catch (err) {
          // dispatchInboundToFlows already catches internally and never
          // throws — this is belt-and-braces so a future change there
          // can't silently skip the AI fallback below.
          console.error(
            '[manychat-inbound] Flow dispatch threw:',
            err instanceof Error ? err.message : err,
          )
        }
      }

      if (!flowConsumed && aiEligible) {
        await dispatchInboundToAiReply({
          accountId: config.account_id,
          conversationId: conversation.id,
          contactId: contactOutcome.contact.id,
          configOwnerUserId: config.user_id,
          // This route never dispatches Automations for this same inbound
          // (unlike the native Meta webhook) — an active CRM automation
          // here must not silence the AI.
          suppressWhenAutomationsActive: false,
        })
      }
    })
  }

  return NextResponse.json({ status: 'created' }, { status: 201 })
}
