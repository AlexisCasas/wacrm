import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { isMediaAudioEnabledForAccount } from '@/lib/flows/voice-note-capability'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { promoteVoiceNote } from '@/lib/audio-guide/voice-note-store'

/**
 * GET /api/flows/voice-notes -> { enabled }: whether this account may use voice notes (server-side flags
 * FLOW_MEDIA_AUDIO_SCOPE / FLOW_VOICE_NOTE_ACCOUNT_IDS). The editor only offers the option when this says yes; every write path checks it again.
 */
export async function GET() {
  try {
    const account = await getCurrentAccount()
    return NextResponse.json(
      { enabled: isMediaAudioEnabledForAccount(account.accountId) },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/flows/voice-notes  { path }
 *
 * Verifies a staged OGG/Opus file and stores it as an immutable, account-scoped
 * voice note (see `promoteVoiceNote`). The file itself never travels through
 * this route: the browser uploads it to Storage first, so the 16 MB limit is
 * not subject to the proxy's request-body buffering.
 *
 * Same role as editing a Flow ('agent'). The account comes from the session,
 * never from the body.
 */
export async function POST(request: Request) {
  try {
    const account = await requireRole('agent')
    if (!isMediaAudioEnabledForAccount(account.accountId)) {
      return NextResponse.json({ error: 'voice_notes_disabled' }, { status: 403 })
    }
    const body = (await request.json().catch(() => null)) as { path?: unknown } | null
    const result = await promoteVoiceNote({
      admin: supabaseAdmin(),
      accountId: account.accountId,
      stagingPath: body?.path,
    })
    if (result.ok) {
      return NextResponse.json(
        {
          url: result.url,
          sha256: result.sha256,
          bytes: result.bytes,
          duration_ms: result.durationMs,
        },
        { headers: { 'Cache-Control': 'private, no-store' } },
      )
    }
    if (result.code === 'invalid_path') return NextResponse.json({ error: 'invalid_path' }, { status: 400 })
    if (result.code === 'not_found') return NextResponse.json({ error: 'file_not_found' }, { status: 404 })
    if (result.code === 'rejected') {
      return NextResponse.json({ error: 'voice_note_rejected', reason: result.reason }, { status: 422 })
    }
    return NextResponse.json({ error: 'storage_error' }, { status: 502 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
