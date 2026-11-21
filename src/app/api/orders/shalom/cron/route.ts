import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { isShalomGloballyEnabled, readShalomConfig } from '@/lib/orders/shalom/config'
import { collectShalomHealth, runShalomTick } from '@/lib/orders/shalom/poller'
import { resolveShalomProvider } from '@/lib/orders/shalom/providers'

// PR-05 · tracking tick. SAME convention as the other crons of WACRM (the system cron calls it with the shared secret; no pg_cron; the script takes an
// flock so two ticks never overlap on a host, and the database claim / lease protects against two hosts).
//
//   GLOBAL KILL SWITCH: unless SHALOM_TRACKING_ENABLED=true NO query is made and nothing is claimed (the response says enabled:false). The DB-only work
//   (the 15-day alert clock, the retention of the technical log) keeps running: it never talks to Shalom. Per account, shalom_tracking_enabled AND
//   logistics_mvp_enabled decide which shipments are claimed. Inbox / Pedidos Confirmados / PR-04 are never touched.
//   PROVIDER: not_configured unless SHALOM_PROVIDER=fake outside production. There is NO real provider (REAL INTEGRATION: BLOCKED UNTIL
//   CONTRACT/AUTHORIZATION VERIFIED) and NO Shalom credential is read anywhere.
//   NEVER polls for real while InkaClick polls the same guides (PRE-DEPLOY BLOCKER: decide which system owns the polling).
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const wanted = Buffer.from(expected)
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const admin = supabaseAdmin()
    const enabled = isShalomGloballyEnabled()
    const provider = resolveShalomProvider()
    const tick = await runShalomTick(admin, { provider, cfg: readShalomConfig(), skipQueries: !enabled })
    const health = await collectShalomHealth(admin)
    return NextResponse.json({ provider: provider.name, ...tick, health })
  } catch (error) {
    console.error('[shalom-cron] failed:', error instanceof Error ? error.message : 'unknown')
    return NextResponse.json({ error: 'tick failed' }, { status: 500 })
  }
}
