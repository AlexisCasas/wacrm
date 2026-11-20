import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(request: Request) {
  try {
    const { accountId, userId } = await requireRole('agent')
    const limit = checkRateLimit('calls:signal:' + userId, RATE_LIMITS.react)
    if (!limit.success) return rateLimitResponse(limit)

    const { searchParams } = new URL(request.url)
    const sessionId = searchParams.get('session_id') ?? ''
    const claimToken = request.headers.get('x-wacrm-call-claim-token') ?? ''
    if (!UUID.test(sessionId) || !UUID.test(claimToken)) {
      return NextResponse.json({ error: 'Valid session_id and claim token are required' }, { status: 400 })
    }

    const { data, error } = await supabaseAdmin()
      .from('whatsapp_call_sessions')
      .select('state, claimed_by_user_id, claim_token, claim_expires_at, session_sdp_type, session_sdp_ciphertext, session_sdp_expires_at')
      .eq('id', sessionId)
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[calling-api] signal lookup failed', { code: error.code ?? 'unknown' })
      return NextResponse.json({ error: 'Could not load call signal' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Call not found' }, { status: 404 })

    const now = Date.now()
    const claimValid =
      data.claimed_by_user_id === userId &&
      data.claim_token === claimToken &&
      Boolean(data.claim_expires_at && new Date(data.claim_expires_at).getTime() > now)
    const signalValid =
      data.state === 'ringing' &&
      (data.session_sdp_type === 'offer' || data.session_sdp_type === 'answer') &&
      Boolean(data.session_sdp_ciphertext) &&
      Boolean(data.session_sdp_expires_at && new Date(data.session_sdp_expires_at).getTime() > now)

    if (!claimValid) return NextResponse.json({ error: 'Call claim is missing or expired' }, { status: 403 })
    if (!signalValid) return NextResponse.json({ error: 'Call signal is unavailable or expired' }, { status: 410 })

    let sdp: string
    try {
      sdp = decrypt(data.session_sdp_ciphertext!)
    } catch {
      console.error('[calling-api] encrypted signal could not be decrypted')
      return NextResponse.json({ error: 'Call signal is unavailable' }, { status: 500 })
    }

    return NextResponse.json(
      { sdp_type: data.session_sdp_type, sdp },
      { headers: { 'Cache-Control': 'private, no-store, max-age=0' } },
    )
  } catch (error) {
    return toErrorResponse(error)
  }
}
