import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { isVoiceNoteEnabledForAccount } from '@/lib/flows/voice-note-capability'
import { authenticateCron } from '@/lib/audio-guide/cron-auth'
import { sendVoiceNoteViaEngine } from '@/lib/audio-guide/sender'
import { resumeAudioRequests, sanitizeError } from '@/lib/audio-guide/sequencer'

/**
 * POST /api/audio-guide/cron — resumes audio-guide requests whose next audio is due (or whose in-flight audio is stale and must be recorded
 * as uncertain). It CHANGES STATE, so it is POST only: a GET is refused (405) so that a prefetcher, a crawler, a link checker or a browser
 * can never trigger sends.
 *
 * NOT scheduled by this change: nothing calls it until an operator installs a caller (see qa/audio-guide/OPERACION.md). Safe at any
 * frequency and from several callers at once: every audio is claimed atomically in the database, so it is never attempted twice or out of
 * order, and an uncertain audio is never retried. Only accounts enabled for voice notes are processed.
 *
 * Auth: header `x-cron-secret` (AUTOMATION_CRON_SECRET, at least 24 characters), constant-time comparison. A secret in the URL is refused.
 * Body (optional JSON): { "limit": 1..50 } requests per call. One call is bounded to ~50 s (the route allows 60).
 */
export const maxDuration = 60
const BUDGET_MS = 50_000
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function POST(request: Request) {
  const auth = authenticateCron(request)
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status, headers: NO_STORE })
  const body = (await request.json().catch(() => null)) as { limit?: unknown } | null
  const limit = typeof body?.limit === 'number' && Number.isInteger(body.limit) ? Math.min(50, Math.max(1, body.limit)) : 20
  const started = Date.now()
  try {
    const summary = await resumeAudioRequests({
      db: supabaseAdmin(),
      limit,
      budgetMs: BUDGET_MS,
      isEnabled: isVoiceNoteEnabledForAccount,
      depsFor: () => ({ sendVoiceNote: sendVoiceNoteViaEngine }),
    })
    const result = { ...summary, duration_ms: Date.now() - started }
    // one structured line per call: counts only (no ids, contacts or messages), for log-based monitoring
    console.info(JSON.stringify({ event: 'audio_guide_resume', ...result }))
    return NextResponse.json(result, { headers: NO_STORE })
  } catch (err) {
    console.error('[audio-guide cron]', sanitizeError(err))
    return NextResponse.json({ error: 'resume_failed' }, { status: 500, headers: NO_STORE })
  }
}

export function GET() {
  return NextResponse.json({ error: 'method_not_allowed', allow: 'POST' }, { status: 405, headers: { Allow: 'POST', ...NO_STORE } })
}
