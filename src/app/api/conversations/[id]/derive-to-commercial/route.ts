import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// POST /api/conversations/[id]/derive-to-commercial   "Derivar a Comercial": logistics -> shared (Logistica keeps the chat, Comercial joins it to
// handle a NEW sale). Deliberately thin: it authenticates, validates the id and calls the SECURITY DEFINER function
// derive_conversation_to_commercial, which is the real authority (actor from auth.uid(), account from the profile, logistics_mvp_enabled, role
// logistics/supervisor, row lock, idempotent, audit event). No body is read: nothing the browser sends can name an account, an actor or a stage.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getCurrentAccount()

    const limit = checkRateLimit(`routing:derive:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    if (!UUID.test(id)) return NextResponse.json({ error: 'Invalid conversation id' }, { status: 400 })

    const { data, error } = await ctx.supabase.rpc('derive_conversation_to_commercial', { p_conversation_id: id })
    if (error) {
      if (error.code === '42501') return NextResponse.json({ error: error.message }, { status: 403 })
      if (error.code === '22023') return NextResponse.json({ error: error.message }, { status: 409 })
      console.error('[derive-to-commercial] unexpected RPC error:', error.code)
      return NextResponse.json({ error: 'Failed to derive the conversation' }, { status: 500 })
    }

    const row = Array.isArray(data) ? data[0] : data
    return NextResponse.json({ ok: true, stage: row?.stage ?? 'shared', changed: row?.changed === true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
