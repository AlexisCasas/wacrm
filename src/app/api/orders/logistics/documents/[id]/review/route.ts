import { NextResponse } from 'next/server'

import { toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { authorize, readJsonObject, respond } from '@/lib/orders/logistics/http'
import { reviewDocument } from '@/lib/orders/logistics/review'

// POST /api/orders/logistics/documents/[id]/review   JSON { action: 'correct' | 'validate' | 'reject', expected_row_version?, reviewed_data? }
//   correct  stores what the person read / fixed (the OCR result is never overwritten)
//   validate freezes OCR + reviewed data, supersedes the previous validated voucher of the order and moves the order to "voucher validated"
//   reject   discards this file (kept as history)
// Actor and account come from the session. The database re-validates flag, area, role, ownership and state (409 on a stale version / frozen document /
// order already in packaging). A voucher pending association cannot be validated.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authorize()
    if (!auth.ok) return auth.response
    const body = await readJsonObject(request)
    if (!body) return NextResponse.json({ error: 'invalid_body' }, { status: 400 })

    const { id } = await params
    return respond(
      await reviewDocument(auth.ctx, supabaseAdmin(), id, { action: body.action, expectedRowVersion: body.expected_row_version, reviewedData: body.reviewed_data }),
    )
  } catch (error) {
    return toErrorResponse(error)
  }
}
