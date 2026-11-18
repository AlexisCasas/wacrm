import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

import type { AccountRole } from '@/lib/auth/roles'
import { hasMinRole } from '@/lib/auth/roles'
import { resolveConfirmedOrdersAccess } from '@/lib/orders/confirmed-orders'

// Authority of every PR-04 endpoint (all server side; nothing the browser sends can widen it):
//   1. a valid session (the route calls getCurrentAccount first: 401 otherwise);
//   2. the account is the session's account (an account_id in a query/body is never read);
//   3. order_integration_settings.logistics_mvp_enabled = TRUE for that account (403 feature_disabled otherwise, nothing is written);
//   4. operational_role = logistics | supervisor (commercial and "no area" -> 403; a `shared` chat grants nothing), and account_role >= agent
//      (viewers are read-only everywhere in WACRM and RLS gives them nothing here).
// The database re-validates all of it inside every RPC and through RLS: this layer only answers early with a precise HTTP status.
// It REUSES PR-02's resolver unchanged.

export type LogisticsAccess = { kind: 'ok' } | { kind: 'disabled' } | { kind: 'forbidden' }

export interface LogisticsCaller {
  supabase: SupabaseClient
  userId: string
  accountId: string
  role: AccountRole
}

export async function resolveLogisticsAccess(ctx: LogisticsCaller): Promise<LogisticsAccess> {
  const access = await resolveConfirmedOrdersAccess(ctx)
  if (access.kind === 'disabled') return { kind: 'disabled' }
  if (access.kind === 'forbidden') return { kind: 'forbidden' }
  if (!hasMinRole(ctx.role, 'agent')) return { kind: 'forbidden' }
  return { kind: 'ok' }
}

/** The HTTP answer for a refused access, or null when access is ok. */
export function accessDeniedResponse(access: LogisticsAccess): NextResponse | null {
  if (access.kind === 'disabled') return NextResponse.json({ error: 'feature_disabled' }, { status: 403 })
  if (access.kind === 'forbidden') return NextResponse.json({ error: 'operational_role_required' }, { status: 403 })
  return null
}
