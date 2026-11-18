import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { accessDeniedResponse, resolveLogisticsAccess } from '@/lib/orders/logistics/access'
import { MAX_DOCUMENT_BYTES } from '@/lib/orders/logistics/constants'
import { listDocuments, uploadVoucher, type ServiceResult } from '@/lib/orders/logistics/documents'

// PR-04 · vouchers.
//
// POST /api/orders/logistics/documents   multipart/form-data: file, request_key, [order_id], [batch_id], [allow_duplicate=true]
//   * order_id present  -> direct association (the operator is working on that order: no matching, the OCR only validates).
//   * order_id absent   -> bulk upload: the voucher is registered "pending association" (batch_id groups a bulk upload so it can be resumed).
//   Idempotent on request_key. The account and the actor come from the session, never from the request. The file goes to the PRIVATE order-docs
//   bucket (server side) and is registered by an RPC that re-validates flag, area, role and order ownership in the database.
// GET  /api/orders/logistics/documents?order_id=&batch_id=&kind=&status=&association=&limit=   lists documents (RLS applies).
//
// Flag OFF (or no logistics/supervisor area, or viewer) -> 403 and nothing is read or written.

const respond = <T>(result: ServiceResult<T>) =>
  result.ok ? NextResponse.json(result.body, { status: result.status }) : NextResponse.json({ error: result.error, ...(result.extra ?? {}) }, { status: result.status })

const text = (value: FormDataEntryValue | null): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const denied = accessDeniedResponse(await resolveLogisticsAccess(ctx))
    if (denied) return denied

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
    const requestKey = text(form.get('request_key'))
    if (!requestKey) return NextResponse.json({ error: 'invalid_request_key' }, { status: 400 })

    const result = await uploadVoucher(
      ctx,
      supabaseAdmin(),
      {
        fileName: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
        orderId: text(form.get('order_id')),
        batchId: text(form.get('batch_id')),
        requestKey,
        allowDuplicate: text(form.get('allow_duplicate')) === 'true',
      },
    )
    return respond(result)
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const denied = accessDeniedResponse(await resolveLogisticsAccess(ctx))
    if (denied) return denied

    const params = new URL(request.url).searchParams
    const limitRaw = params.get('limit')
    const result = await listDocuments(ctx, {
      orderId: params.get('order_id'),
      batchId: params.get('batch_id'),
      kind: params.get('kind'),
      status: params.get('status'),
      association: params.get('association'),
      limit: limitRaw === null ? undefined : Number(limitRaw),
    })
    return respond(result)
  } catch (error) {
    return toErrorResponse(error)
  }
}
