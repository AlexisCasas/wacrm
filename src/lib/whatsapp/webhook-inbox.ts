import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Only callers that have already authenticated the raw Meta payload may enqueue.
 * The durable row contains customer PII: it lives behind service-role-only RLS,
 * never in logs and is pruned after 7 days of successful processing.
 */
export async function enqueueVerifiedWebhook(db: SupabaseClient, rawBody: string, payload: unknown): Promise<string> {
  const digest = createHash('sha256').update(rawBody).digest('hex')
  const { data, error } = await db.rpc('whatsapp_webhook_inbox_enqueue', {
    p_digest: digest,
    p_payload: payload,
  })
  if (error || typeof data !== 'string') {
    console.error('[webhook-inbox] durable enqueue failed', { code: error?.code ?? 'invalid_result' })
    throw new Error('webhook_enqueue_failed')
  }
  return data
}

export interface InboxDrainResult {
  claimed: number
  processed: number
  failed: number
}

type InboxItem = { id: string; payload: unknown; token: string }
type InboxHandler = (body: unknown) => Promise<void>

/**
 * Both POST/after and the authenticated cron use the same atomic claim.
 * Leases fence concurrent executions; a failed process is retried with backoff.
 *
 * The existing messages (conversation_id, message_id) unique index prevents
 * a second business dispatch when the same inbound Meta message is replayed.
 * We do NOT claim exactly-once delivery of external actions after a crash.
 */
export async function drainWebhookInbox(
  db: SupabaseClient,
  handler: InboxHandler,
  opts: { eventId?: string; limit?: number; deadlineMs?: number } = {},
): Promise<InboxDrainResult> {
  const limit = Math.min(20, Math.max(1, opts.limit ?? 1))
  const deadline = Date.now() + (opts.deadlineMs ?? 45_000)
  const result: InboxDrainResult = { claimed: 0, processed: 0, failed: 0 }

  for (let index = 0; index < limit && Date.now() < deadline; index++) {
    const { data, error } = await db.rpc('whatsapp_webhook_inbox_claim', {
      p_limit: 1,
      p_event_id: opts.eventId ?? null,
    })
    if (error) {
      console.error('[webhook-inbox] claim failed', { code: error.code ?? 'unknown' })
      throw new Error('webhook_claim_failed')
    }

    const row = (Array.isArray(data) ? data[0] : null) as InboxItem | undefined
    if (!row) break
    result.claimed++

    try {
      await handler(row.payload)
      const completed = await db.rpc('whatsapp_webhook_inbox_complete', {
        p_id: row.id,
        p_token: row.token,
      })
      if (completed.error || completed.data !== true) {
        throw new Error('completion_not_confirmed')
      }
      result.processed++
    } catch (cause) {
      result.failed++
      const failure = await db.rpc('whatsapp_webhook_inbox_fail', {
        p_id: row.id,
        p_token: row.token,
        p_error_code: 'processing_failed',
      })
      // Never log the payload, WAMID, phone number or error details.
      console.error('[webhook-inbox] event deferred', {
        fail_recorded: !failure.error && failure.data === true,
        reason: cause instanceof Error && cause.message === 'completion_not_confirmed'
          ? 'completion_not_confirmed' : 'processing_failed',
      })
    }
    // A targeted after() call must never claim anything else.
    if (opts.eventId) break
  }
  return result
}
