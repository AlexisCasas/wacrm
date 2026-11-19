import { NextResponse } from 'next/server'

import { getCurrentAccount, type AccountContext } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { resolveConfirmedOrdersAccess } from '@/lib/orders/confirmed-orders'
import type { ServiceResult } from '@/lib/orders/logistics/documents'

// Shared plumbing of the PR-06 route handlers. `authorizePayments` is the single entry point for Logistica / Supervisor: session -> logistics_mvp_enabled + operational area
// (PR-02's resolver, unchanged) + agent+ -> order_payments_enabled and the area re-checked by the DATABASE (order_payments_access, with the caller's own identity). Nothing the
// browser sends can widen it: no account, role, actor, amount-as-balance or stage is read from a request. Commercial, viewers and people without an area get nothing here
// (Comercial's read-only summary is a separate endpoint with its own database check).

export type PaymentAuth = { ok: true; ctx: AccountContext; isSupervisor: boolean } | { ok: false; response: NextResponse }

export async function authorizePayments(): Promise<PaymentAuth> {
  const ctx = await getCurrentAccount()
  const access = await resolveConfirmedOrdersAccess(ctx)
  if (access.kind === 'disabled') return { ok: false, response: NextResponse.json({ error: 'feature_disabled' }, { status: 403 }) }
  if (access.kind === 'forbidden' || !hasMinRole(ctx.role, 'agent')) return { ok: false, response: NextResponse.json({ error: 'operational_role_required' }, { status: 403 }) }
  const { data, error } = await ctx.supabase.rpc('order_payments_access', { p_account_id: ctx.accountId })
  if (error) return { ok: false, response: NextResponse.json({ error: 'internal_error' }, { status: 500 }) }
  if (data !== true) return { ok: false, response: NextResponse.json({ error: 'feature_disabled' }, { status: 403 }) }
  return { ok: true, ctx, isSupervisor: access.operationalRole === 'supervisor' }
}

export const respondPayment = <T>(result: ServiceResult<T>): NextResponse =>
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
