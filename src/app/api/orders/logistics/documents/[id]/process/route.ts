import { NextResponse } from 'next/server'

import { toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { processBulkDocument } from '@/lib/orders/logistics/bulk'
import { OCR_RATE_LIMIT } from '@/lib/orders/logistics/constants'
import { authorize, respond } from '@/lib/orders/logistics/http'
import { resolveOcrProvider } from '@/lib/orders/logistics/ocr/providers'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'

// POST /api/orders/logistics/documents/[id]/process   BULK step for ONE voucher that has no order yet: OCR (only if there is no good result yet) ->
// conservative matching -> `associated` (exactly one safe candidate, method auto) or `pending` (a person chooses; candidates are only suggestions).
// It never validates anything: an automatically associated voucher still waits for a person to validate it. Safe to repeat: an already associated
// document answers `already_associated`, an OCR in flight answers 409, a finished OCR is never paid twice. The client can resume a batch at any time
// by listing it (GET documents?batch_id=...) and calling this for what is still pending.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authorize()
    if (!auth.ok) return auth.response
    const limit = checkRateLimit(`logistics-ocr:${auth.ctx.userId}`, OCR_RATE_LIMIT)
    if (!limit.success) return rateLimitResponse(limit) as NextResponse

    const { id } = await params
    return respond(await processBulkDocument(auth.ctx, supabaseAdmin(), { provider: resolveOcrProvider() }, id))
  } catch (error) {
    return toErrorResponse(error)
  }
}
