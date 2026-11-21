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

/**
 * Second wall for READ services that use the caller's own client: the database answers, with the caller's identity, whether this person works the
 * logistics stage of this account (flag ON + logistics/supervisor + agent+). Needed where PR-02's own policies would otherwise let another area read
 * the underlying rows (commercial reads orders). `null` = allowed; otherwise the failure to return.
 */
export async function denyUnlessLogisticsInDatabase(ctx: Pick<LogisticsCaller, 'supabase' | 'accountId'>): Promise<{ status: number; error: string } | null> {
  const { data, error } = await ctx.supabase.rpc('order_logistics_access', { p_account_id: ctx.accountId })
  if (error) {
    console.error('[logistics] access check failed:', error.code)
    return { status: 500, error: 'internal_error' }
  }
  return data === true ? null : { status: 404, error: 'not_found' }
}
