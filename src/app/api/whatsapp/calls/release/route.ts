import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { assertWhatsAppCallingEnabled } from '@/lib/whatsapp/calling-config'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('agent')
    await assertWhatsAppCallingEnabled((await requireRole('agent')).supabase, accountId)
    const limit = checkRateLimit('calls:release:' + userId, RATE_LIMITS.react)
    if (!limit.success) return rateLimitResponse(limit)

    let body: { session_id?: unknown; claim_token?: unknown }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const sessionId = typeof body.session_id === 'string' ? body.session_id : ''
    const claimToken = typeof body.claim_token === 'string' ? body.claim_token : ''
    if (!UUID.test(sessionId) || !UUID.test(claimToken)) {
      return NextResponse.json({ error: 'session_id and claim_token must be UUIDs' }, { status: 400 })
    }

    const { data, error } = await supabaseAdmin().rpc('release_whatsapp_call_session_claim', {
      p_account_id: accountId,
      p_session_id: sessionId,
      p_user_id: userId,
      p_claim_token: claimToken,
    })
    if (error) {
      console.error('[calling-api] claim release failed', { code: error.code ?? 'unknown' })
      return NextResponse.json({ error: 'Could not release call' }, { status: 500 })
    }

    return NextResponse.json({ success: data === true, released: data === true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
