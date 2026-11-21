import { NextResponse } from 'next/server'

import { toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { MAX_DOCUMENT_BYTES, UPLOAD_RATE_LIMIT } from '@/lib/orders/logistics/constants'
import { uploadPaymentProof } from '@/lib/orders/payments/evidence'
import { authorizePayments, respondPayment } from '@/lib/orders/payments/http'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'

// POST /api/orders/payments/orders/[orderId]/evidence   multipart/form-data: file, request_key
// Logistica / Supervisor upload the PROOF of a payment (photo or PDF) of an order of their account. Private bucket order-docs, account + order scoped, idempotent on
// request_key (the same file is one proof). The file alone never creates a payment: its id is then sent as `evidence_document_id` when registering one.
export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    const auth = await authorizePayments()
    if (!auth.ok) return auth.response
    const limit = checkRateLimit(`payments-upload:${auth.ctx.userId}`, UPLOAD_RATE_LIMIT)
    if (!limit.success) return rateLimitResponse(limit) as NextResponse
    const declared = Number(request.headers.get('content-length') ?? 0)
    if (Number.isFinite(declared) && declared > MAX_DOCUMENT_BYTES + 64 * 1024) return NextResponse.json({ error: 'file_too_large', max_bytes: MAX_DOCUMENT_BYTES }, { status: 413 })
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
    return respondPayment(
      await uploadPaymentProof({ userId: auth.ctx.userId, accountId: auth.ctx.accountId }, supabaseAdmin(), orderId, {
        fileName: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
        requestKey: typeof requestKey === 'string' ? requestKey.trim() : null,
      }),
    )
  } catch (error) {
    return toErrorResponse(error)
  }
}
