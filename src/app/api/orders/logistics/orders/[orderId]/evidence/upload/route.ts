import { NextResponse } from 'next/server'

import { toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { MAX_DOCUMENT_BYTES, UPLOAD_RATE_LIMIT } from '@/lib/orders/logistics/constants'
import { uploadEvidence } from '@/lib/orders/logistics/evidence'
import { authorize, respond } from '@/lib/orders/logistics/http'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'

// POST /api/orders/logistics/orders/[orderId]/evidence/upload   multipart/form-data: file, request_key
// Logística / Supervisor upload the PACKAGING EVIDENCE of an order from their own device (photo or PDF). Private bucket order-docs, scoped to
// account + order; only while the order is in packaging; idempotent on request_key; a different file supersedes the previous evidence (kept as
// history) unless a template send is open. Flag OFF / other area / viewer -> 403; another account's order -> 404. The account and the actor come
// from the session, never from the request.
export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    const auth = await authorize()
    if (!auth.ok) return auth.response
    const limit = checkRateLimit(`logistics-upload:${auth.ctx.userId}`, UPLOAD_RATE_LIMIT)
    if (!limit.success) return rateLimitResponse(limit) as NextResponse

    const declared = Number(request.headers.get('content-length') ?? 0)
    if (Number.isFinite(declared) && declared > MAX_DOCUMENT_BYTES + 64 * 1024) {
      return NextResponse.json({ error: 'file_too_large', max_bytes: MAX_DOCUMENT_BYTES }, { status: 413 })
    }
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return NextResponse.json({ error: 'invalid_form' }, { status: 400 })
    }
    const file = form.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'file_required' }, { status: 400 })
    if (file.size > MAX_DOCUMENT_BYTES) return NextResponse.json({ error: 'file_too_large', max_bytes: MAX_DOCUMENT_BYTES }, { status: 413 })
    const requestKey = form.get('request_key')

    const { orderId } = await params
    return respond(
      await uploadEvidence(auth.ctx, supabaseAdmin(), orderId, {
        fileName: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
        requestKey: typeof requestKey === 'string' ? requestKey.trim() : null,
      }),
    )
  } catch (error) {
    return toErrorResponse(error)
  }
}
