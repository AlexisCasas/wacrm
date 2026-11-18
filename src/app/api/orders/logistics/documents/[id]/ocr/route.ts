import { NextResponse } from 'next/server'

import { toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { OCR_RATE_LIMIT } from '@/lib/orders/logistics/constants'
import { authorize, respond } from '@/lib/orders/logistics/http'
import { resolveOcrProvider } from '@/lib/orders/logistics/ocr/providers'
import { runDocumentOcr } from '@/lib/orders/logistics/ocr/run'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'

// POST /api/orders/logistics/documents/[id]/ocr   runs (or retries) ONE OCR attempt on a voucher that is still pending review.
// The OCR result is a suggestion: it is stored apart from what a person reviews and never validates the voucher. With no provider configured the
// attempt is recorded as `ocr_not_configured` and the UI falls back to manual capture. A validated voucher is never re-processed (new version = new file).
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authorize()
    if (!auth.ok) return auth.response
    const limit = checkRateLimit(`logistics-ocr:${auth.ctx.userId}`, OCR_RATE_LIMIT)
    if (!limit.success) return rateLimitResponse(limit) as NextResponse

    const { id } = await params
    return respond(await runDocumentOcr(auth.ctx, supabaseAdmin(), resolveOcrProvider(), id))
  } catch (error) {
    return toErrorResponse(error)
  }
}
