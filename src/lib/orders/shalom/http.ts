import { NextResponse } from 'next/server'

import { getCurrentAccount, type AccountContext } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { resolveConfirmedOrdersAccess } from '@/lib/orders/confirmed-orders'
import type { ServiceResult } from '@/lib/orders/logistics/documents'

// Shared plumbing of the PR-05 route handlers. `authorizeShipments` is the single entry point: session (401 through getCurrentAccount's own error) →
// logistics_mvp_enabled + operational area (PR-02's resolver, unchanged) + agent+ → shalom_tracking_enabled and the area re-checked by the database
// (order_shipments_access, with the caller's own identity). Nothing the browser sends can widen it: no account, role or actor is read from a request.
// Commercial, viewers, people without an area and the PR-03 `shared` routing grant nothing.

export type ShipmentAuth =
  | { ok: true; ctx: AccountContext; isSupervisor: boolean }
  | { ok: false; response: NextResponse }

export async function authorizeShipments(): Promise<ShipmentAuth> {
  const ctx = await getCurrentAccount()
  const access = await resolveConfirmedOrdersAccess(ctx)
  if (access.kind === 'disabled') return { ok: false, response: NextResponse.json({ error: 'feature_disabled' }, { status: 403 }) }
  if (access.kind === 'forbidden' || !hasMinRole(ctx.role, 'agent')) return { ok: false, response: NextResponse.json({ error: 'operational_role_required' }, { status: 403 }) }
  const { data, error } = await ctx.supabase.rpc('order_shipments_access', { p_account_id: ctx.accountId })
  if (error) return { ok: false, response: NextResponse.json({ error: 'internal_error' }, { status: 500 }) }
  if (data !== true) return { ok: false, response: NextResponse.json({ error: 'feature_disabled' }, { status: 403 }) }
  return { ok: true, ctx, isSupervisor: access.operationalRole === 'supervisor' }
}

export const respondShipment = <T>(result: ServiceResult<T>): NextResponse =>
  result.ok
    ? NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } })
    : NextResponse.json({ error: result.error, ...(result.extra ?? {}) }, { status: result.status })

export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json()
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}
