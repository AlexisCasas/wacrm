import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { paymentDocumentSignedUrl } from '@/lib/orders/payments/evidence'

// GET /api/orders/payments/documents/[id]/url   a SHORT-LIVED signed URL for ONE payment proof (or a PR-04 voucher linked to a payment) of the caller's account.
// The database decides (both flags + area + role + account); anything else is a 404 indistinguishable from a non-existent id. The bucket is private; the path is never returned.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getCurrentAccount()
    const { id } = await params
    const result = await paymentDocumentSignedUrl({ supabase: ctx.supabase, accountId: ctx.accountId }, supabaseAdmin(), id)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json(result.body, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return toErrorResponse(error)
  }
}
