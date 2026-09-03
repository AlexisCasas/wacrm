import { createHash, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findOrCreateContact } from '@/lib/contacts/find-or-create'
import { findOrCreateConversation } from '@/lib/conversations/find-or-create'
import { reopenClosedConversation } from '@/lib/conversations/reopen'

/**
 * TEMPORARY bridge: mirrors inbound WhatsApp messages from ManyChat
 * (still the live-sending platform during this migration window) into
 * the WA CRM Inbox — contact, conversation, message only.
 *
 * Deliberately does NOT: send to WhatsApp, run AI auto-reply, run
 * Flows, or run Automations. This route is a read-only mirror of
 * ManyChat's own inbound handling, so those engines must never see a
 * message that originated here — remove this route once ManyChat is
 * decommissioned.
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

  return NextResponse.json({ status: 'created' }, { status: 201 })
}
