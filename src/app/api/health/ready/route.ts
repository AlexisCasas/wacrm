import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'

/**
 * GET /api/health/ready: readiness for the zero-downtime deploy gate (ops/deploy).
 *
 * "Ready" means this process can serve a real request: it is up AND can reach its database. It is unauthenticated on purpose (the deploy
 * gate and monitors call it) and therefore returns nothing but a status word: no versions, hostnames, counts, errors or configuration.
 * It performs one tiny read (a single row id) and never writes. Liveness (is the process alive) is the Docker healthcheck's job.
 */
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }
const DB_TIMEOUT_MS = 3000

function withTimeout<T>(work: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    Promise.resolve(work).then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) },
    )
  })
}

export async function GET() {
  try {
    const { error } = await withTimeout(supabaseAdmin().from('accounts').select('id').limit(1), DB_TIMEOUT_MS)
    if (error) return NextResponse.json({ status: 'not_ready' }, { status: 503, headers: NO_STORE })
    return NextResponse.json({ status: 'ready' }, { status: 200, headers: NO_STORE })
  } catch {
    return NextResponse.json({ status: 'not_ready' }, { status: 503, headers: NO_STORE })
  }
}
