import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { readRoutingState } from '@/lib/conversations/routing'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// GET /api/conversations/[id]/routing   Operational stage of ONE conversation for the Inbox sidebar (commercial | logistics | shared), whether the
// caller may "Derivar a Comercial", and who/when it was last derived. READ-ONLY. The account comes from the session (never from the request); with
// logistics_mvp_enabled OFF the answer is `{ enabled: false }` and the UI shows nothing. A conversation the caller cannot work is a 404.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getCurrentAccount()
    const { id } = await params
    if (!UUID.test(id)) return NextResponse.json({ error: 'Invalid conversation id' }, { status: 400 })

    const state = await readRoutingState(ctx, id)
    if (!state) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    return NextResponse.json(state)
  } catch (error) {
    return toErrorResponse(error)
  }
}
