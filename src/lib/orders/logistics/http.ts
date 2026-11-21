import { NextResponse } from 'next/server'

import { getCurrentAccount, type AccountContext } from '@/lib/auth/account'
import { accessDeniedResponse, resolveLogisticsAccess } from '@/lib/orders/logistics/access'
import type { ServiceResult } from '@/lib/orders/logistics/documents'

// Shared plumbing of the PR-04 route handlers. `authorize` is the single entry point: session (401 via getCurrentAccount's own error) ->
// logistics_mvp_enabled + operational area + role (403) -> the account context derived from the SESSION. No route reads an account id, role or
// actor from the request.

export async function authorize(): Promise<{ ok: true; ctx: AccountContext } | { ok: false; response: NextResponse }> {
  const ctx = await getCurrentAccount()
  const denied = accessDeniedResponse(await resolveLogisticsAccess(ctx))
  return denied ? { ok: false, response: denied } : { ok: true, ctx }
}

export const respond = <T>(result: ServiceResult<T>): NextResponse =>
  result.ok
    ? NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } })
    : NextResponse.json({ error: result.error, ...(result.extra ?? {}) }, { status: result.status })

/** A JSON object body, or null when the body is missing / not an object. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json()
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}
