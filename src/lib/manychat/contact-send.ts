import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { sendManyChatText } from './api'

/** Thrown when `MANYCHAT_API_KEY` is missing from the environment. */
export class ManyChatNotConfiguredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManyChatNotConfiguredError'
  }
}

/** Thrown when the (account, contact) pair has no `manychat_contact_links` row. */
export class ManyChatContactNotLinkedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManyChatContactNotLinkedError'
  }
}

/**
 * Thrown when the `manychat_contact_links` lookup itself errors — a
 * real DB problem, distinct from "no row found" (`ManyChatContactNotLinkedError`).
 */
export class ManyChatMappingLookupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManyChatMappingLookupError'
  }
}

export interface SendManyChatTextToContactArgs {
  db: SupabaseClient
  accountId: string
  contactId: string
  text: string
}

export interface SendManyChatTextToContactResult {
  /** `manychat-out:<id>` — never a Meta-shaped `wamid`. */
  whatsappMessageId: string
}

/**
 * TRANSPORT-ONLY primitive for the ManyChat outbound bridge.
 *
 * Resolves the account-scoped `manychat_contact_links` mapping, calls
 * ManyChat's Public API, and returns a message id. Deliberately does
 * NOT: insert into `messages`, update `conversations`, pause
 * `flow_runs`, or decide `sender_type`. Every caller owns its own
 * persistence semantics —
 *   - the manual-agent send path (`src/lib/whatsapp/send-message.ts`)
 *     persists `sender_type='agent'` and pauses active flow runs;
 *   - the AI send path (`src/lib/ai/send.ts`) persists
 *     `sender_type='bot'` + `ai_generated=true` and never pauses flows.
 * Sharing this primitive is only about not duplicating the mapping
 * lookup + wire call in two places — it carries no opinion about who
 * the sender is.
 *
 * Scoped to BOTH `account_id` and `contact_id` together — never
 * `contact_id` alone — so account A can never reach account B's
 * ManyChat mapping.
 *
 * Throws `ManyChatNotConfiguredError`, `ManyChatContactNotLinkedError`,
 * `ManyChatMappingLookupError`, or `ManyChatApiError` (from
 * `sendManyChatText`) — never returns a "failed" result, and never
 * falls back to Meta. Transport selection is entirely the caller's
 * responsibility, decided BEFORE calling this (via
 * `resolveOutboundTransport`).
 */
export async function sendManyChatTextToContact(
  args: SendManyChatTextToContactArgs,
): Promise<SendManyChatTextToContactResult> {
  const { db, accountId, contactId, text } = args

  const apiKey = process.env.MANYCHAT_API_KEY
  if (!apiKey) {
    throw new ManyChatNotConfiguredError(
      'ManyChat outbound is not configured (MANYCHAT_API_KEY missing)',
    )
  }

  const { data: link, error: linkError } = await db
    .from('manychat_contact_links')
    .select('manychat_contact_id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle()

  if (linkError) {
    console.error('[manychat] manychat_contact_links lookup failed:', linkError.message)
    throw new ManyChatMappingLookupError('Failed to resolve the ManyChat mapping')
  }
  if (!link) {
    throw new ManyChatContactNotLinkedError(
      'This contact has not been synced from ManyChat yet — an inbound message must arrive first.',
    )
  }

  const sendResult = await sendManyChatText({
    apiKey,
    manyChatContactId: link.manychat_contact_id as string,
    text,
  })

  // ManyChat's documented sendContent response is `{ "status": "success" }`
  // with no confirmed message-id field. Use one opportunistically if a
  // future/undocumented shape carries it; otherwise generate our own —
  // never invent a wamid-shaped id.
  const raw = sendResult.raw as Record<string, unknown> | null
  const nestedData =
    raw && typeof raw.data === 'object' ? (raw.data as Record<string, unknown>) : null
  const returnedId = raw?.message_id ?? nestedData?.message_id
  const whatsappMessageId =
    typeof returnedId === 'string' && returnedId.trim()
      ? `manychat-out:${returnedId.trim()}`
      : `manychat-out:${randomUUID()}`

  return { whatsappMessageId }
}
