import { NextResponse } from 'next/server'
import { guarded, json } from '@/lib/audio-guide/api'
import { listRecentRequests } from '@/lib/audio-guide/requests'

/** GET /api/audio-guide/requests?limit=N — the latest audio sequences of the account, with each audio's state and the originating run. Members only. */
export async function GET(request: Request): Promise<NextResponse> {
  return guarded('read', async ({ account, db }) => {
    const raw = Number(new URL(request.url).searchParams.get('limit') ?? 20)
    const result = await listRecentRequests(db, account.accountId, Number.isFinite(raw) ? raw : 20)
    if (!result) return json({ error: 'internal_error' }, 500)
    return json({
      requests: result.map((r) => ({
        id: r.id, created_at: r.createdAt, status: r.status, reason: r.reason, product_key: r.productKey,
        sends: r.sends.map((s) => ({ position: s.position, status: s.status, error_code: s.errorCode, finished_at: s.finishedAt })),
        run: r.run ? { id: r.run.id, flow_id: r.run.flowId, status: r.run.status, end_reason: r.run.endReason } : null,
      })),
    })
  })
}
