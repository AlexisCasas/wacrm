import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { runCapiWorker } from '@/lib/meta-capi/worker'

// Meta CAPI tick. Same secret convention as the other crons. With META_CAPI_ENABLED != 'true' (the default) it does nothing at all.
// Errors are contained here: they never reach WhatsApp processing or the InkaClick outbox.
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const wanted = Buffer.from(expected)
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    return NextResponse.json(await runCapiWorker(supabaseAdmin()))
  } catch (error) {
    console.error('[meta-capi-cron] failed:', error instanceof Error ? error.message : 'unknown')
    return NextResponse.json({ error: 'capi worker failed' }, { status: 500 })
  }
}
