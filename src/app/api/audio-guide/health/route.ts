import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { authenticateCron } from '@/lib/audio-guide/cron-auth'
import { readAudioGuideHealth } from '@/lib/audio-guide/health'
import { sanitizeError } from '@/lib/audio-guide/sequencer'

/**
 * GET /api/audio-guide/health — read-only state of the audio sequencer for a monitor (same header secret as the resumer). Counts only.
 * 200 {status:"ok"} when nothing needs action; 503 {status:"degraded"} when requests are stuck or due audios have no resumer (page someone).
 */
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(request: Request) {
  const auth = authenticateCron(request)
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status, headers: NO_STORE })
  try {
    const health = await readAudioGuideHealth(supabaseAdmin())
    return NextResponse.json(health, { status: health.status === 'ok' ? 200 : 503, headers: NO_STORE })
  } catch (err) {
    console.error('[audio-guide health]', sanitizeError(err))
    return NextResponse.json({ status: 'unknown', error: 'health_failed' }, { status: 500, headers: NO_STORE })
  }
}
