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
    const limit = checkRateLimit('calls:claim:' + userId, RATE_LIMITS.react)
    if (!limit.success) return rateLimitResponse(limit)

    let body: { session_id?: unknown }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const sessionId = typeof body.session_id === 'string' ? body.session_id : ''
    if (!UUID.test(sessionId)) {
      return NextResponse.json({ error: 'session_id must be a UUID' }, { status: 400 })
    }

    const { data: session, error: sessionError } = await supabaseAdmin()
      .from('whatsapp_call_sessions')
      .select('id, state, direction, contact_id')
      .eq('id', sessionId)
      .eq('account_id', accountId)
      .maybeSingle()

    if (sessionError) {
      console.error('[calling-api] claim preflight failed', { code: sessionError.code ?? 'unknown' })
      return NextResponse.json({ error: 'Could not claim call' }, { status: 500 })
    }
    if (!session) return NextResponse.json({ error: 'Call not found' }, { status: 404 })
    if (session.state !== 'ringing' || session.direction !== 'USER_INITIATED') {
      return NextResponse.json({ error: 'Call is not available to answer' }, { status: 409 })
    }
    if (session.contact_id) {
      const { data: contact, error: contactError } = await supabaseAdmin()
        .from('contacts')
        .select('blocked')
        .eq('id', session.contact_id)
        .eq('account_id', accountId)
        .maybeSingle()
      if (contactError) {
        console.error('[calling-api] blocked-contact check failed', { code: contactError.code ?? 'unknown' })
        return NextResponse.json({ error: 'Could not verify call contact' }, { status: 500 })
      }
      if (contact?.blocked) {
        return NextResponse.json({ error: 'Calls from blocked contacts cannot be answered' }, { status: 403 })
      }
    }

    const { data, error } = await supabaseAdmin().rpc('claim_whatsapp_call_session', {
      p_account_id: accountId,
      p_session_id: sessionId,
      p_user_id: userId,
      p_lease_seconds: 45,
    })
    if (error) {
      console.error('[calling-api] atomic claim failed', { code: error.code ?? 'unknown' })
      return NextResponse.json({ error: 'Could not claim call' }, { status: 500 })
    }

    const result = Array.isArray(data) ? data[0] : data
    if (result?.outcome === 'busy') {
      return NextResponse.json({ error: 'Another agent is handling this call' }, { status: 409 })
    }
    if (result?.outcome === 'missing') {
      return NextResponse.json({ error: 'Call not found' }, { status: 404 })
    }
    if (result?.outcome !== 'claimed' || typeof result.claim_token !== 'string') {
      return NextResponse.json({ error: 'Call is no longer available' }, { status: 409 })
    }

    return NextResponse.json({
      success: true,
      claim_token: result.claim_token,
      claim_expires_at: result.claim_expires_at,
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
