import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { drainWebhookInbox } from '@/lib/whatsapp/webhook-inbox'
import { processWebhook, type MetaWebhookPayload } from '@/lib/whatsapp/webhook-processor'

/**
 * POST /api/whatsapp/webhook/cron — replay authenticated, HMAC-verified
 * events from the durable inbox. Requires an operator-installed caller
 * (e.g. every minute from the VPS), and is POST-only to prevent crawlers
 * from triggering customer-facing actions.
 */
export const maxDuration = 60
const HEADERS = { 'Cache-Control': 'no-store' }

export async function POST(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected || expected.length < 24) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503, headers: HEADERS })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: HEADERS })
  }

  const parsed = await request.json().catch(() => null) as { limit?: unknown } | null
  const limit = typeof parsed?.limit === 'number' && Number.isInteger(parsed.limit)
    ? Math.min(20, Math.max(1, parsed.limit))
    : 10

  try {
    const db = supabaseAdmin()
    const result = await drainWebhookInbox(
      db,
      (payload) => processWebhook(payload as MetaWebhookPayload),
      { limit, deadlineMs: 45_000 },
    )
    const cleanup = await db.rpc('whatsapp_webhook_inbox_prune', { p_limit: 200 })
    if (cleanup.error) console.error('[webhook-inbox] cleanup failed', { code: cleanup.error.code ?? 'unknown' })
    // Logs only aggregate counts — payloads, contacts and identifiers are private.
    console.info('[webhook-inbox] cron', { ...result, pruned: cleanup.error ? null : cleanup.data })
    return NextResponse.json({ ...result, pruned: cleanup.error ? null : cleanup.data }, { headers: HEADERS })
  } catch {
    console.error('[webhook-inbox] cron unable to claim events')
    return NextResponse.json({ error: 'inbox_unavailable' }, { status: 503, headers: HEADERS })
  }
}

export function GET() {
  return NextResponse.json(
    { error: 'method_not_allowed' },
    { status: 405, headers: { ...HEADERS, Allow: 'POST' } },
  )
}
