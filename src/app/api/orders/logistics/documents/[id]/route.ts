import { toErrorResponse } from '@/lib/auth/account'
import { authorize, respond } from '@/lib/orders/logistics/http'
import { getDocumentDetail } from '@/lib/orders/logistics/review'

// GET /api/orders/logistics/documents/[id]   the review screen of ONE voucher: file facts, the last normalized OCR result (suggestion), what a person
// corrected, and the comparison against the order. Read with the caller's own client (RLS), so another account / a hidden document is a plain 404.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authorize()
    if (!auth.ok) return auth.response
    const { id } = await params
    return respond(await getDocumentDetail(auth.ctx, id))
  } catch (error) {
    return toErrorResponse(error)
  }
}
