import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { accessDeniedResponse, resolveLogisticsAccess } from '@/lib/orders/logistics/access'
import { documentSignedUrl } from '@/lib/orders/logistics/documents'

// GET /api/orders/logistics/documents/[id]/url   a SHORT-LIVED signed URL to view one voucher / evidence file of the caller's account.
// The document is read with the caller's own client (RLS: flag + area + role + account), so a document of another account or one the caller may
// not see is a 404 indistinguishable from a non-existent id. The storage path is never returned. The bucket is private: there is no public URL.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getCurrentAccount()
    const denied = accessDeniedResponse(await resolveLogisticsAccess(ctx))
    if (denied) return denied

    const { id } = await params
    const result = await documentSignedUrl(ctx, supabaseAdmin(), id)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json(result.body, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return toErrorResponse(error)
  }
}
