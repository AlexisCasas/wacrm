import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { callingSupabaseAdmin } from '@/lib/whatsapp/calling-admin'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { assertWhatsAppCallingEnabled } from '@/lib/whatsapp/calling-config'

export async function GET() {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    await assertWhatsAppCallingEnabled(supabase, accountId)
    const limit = checkRateLimit('calls:list:' + userId, RATE_LIMITS.react)
    if (!limit.success) return rateLimitResponse(limit)

    const admin = callingSupabaseAdmin()
    // Opportunistic expiry cleanup: stale encrypted SDP is no longer usable.
    await admin
      .from('whatsapp_call_sessions')
      .update({
        session_sdp_type: null,
        session_sdp_ciphertext: null,
        session_sdp_expires_at: null,
      })
      .eq('account_id', accountId)
      .lt('session_sdp_expires_at', new Date().toISOString())

    const { data, error } = await admin
      .from('whatsapp_call_sessions')
      .select([
        'id',
        'call_id',
        'phone_number_id',
        'contact_id',
        'conversation_id',
        'contact_phone',
        'contact_user_id',
        'direction',
        'state',
        'last_event',
        'last_event_status',
        'last_event_at',
        'started_at',
        'ended_at',
        'duration_seconds',
        'claimed_by_user_id',
        'claim_token',
        'claim_expires_at',
        'session_sdp_expires_at',
        'created_at',
      ].join(','))
      .eq('account_id', accountId)
      .in('state', ['ringing', 'connecting', 'accepted'])
      .order('last_event_at', { ascending: false })
      .limit(50)

    if (error) {
      console.error('[calling-api] active session list failed', { code: error.code ?? 'unknown' })
      return NextResponse.json({ error: 'Could not load active calls' }, { status: 500 })
    }

    const sessions = (data ?? []).map((row) => {
      const { claim_token, claimed_by_user_id, claim_expires_at, ...publicRow } = row
      return {
        ...publicRow,
        claimed_by_me: claimed_by_user_id === userId && Boolean(claim_expires_at && new Date(claim_expires_at).getTime() > Date.now()),
        claim_available: row.state === 'ringing' && row.direction === 'USER_INITIATED' && (!claim_token || !claim_expires_at || new Date(claim_expires_at).getTime() <= Date.now()),
      }
    })

    return NextResponse.json({ sessions }, { headers: { 'Cache-Control': 'private, no-store, max-age=0' } })
  } catch (error) {
    return toErrorResponse(error)
  }
}
