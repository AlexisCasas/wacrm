/**
 * Server-only access to the DB-managed BSUID authorizations (migration 078). Everything fails CLOSED: an error, a missing row or an
 * unknown answer means "not authorized". All calls use the service-role client; nothing here is reachable from a browser or the public API.
 *
 *  - `getDbPilotScopes`     business numbers switched on in `bsuid_pilot_scopes` (the union with the environment variable applies);
 *  - `bsuidFlowScope`       the flows that may START or CONTINUE for a phone-less contact (empty = hold, as before phase 3);
 *  - `bsuidFlowSendCheck`   per-send check for a Flow run: every flow of the run's call stack must be authorized for the contact and
 *                           for the message modality, and the run itself must be a real ACTIVE run of that contact.
 */
import { supabaseAdmin } from '@/lib/flows/admin-client'
import type { BsuidPilotScope } from '@/lib/whatsapp/bsuid-pilot'

export type FlowSendModality = 'text' | 'media' | 'buttons' | 'list' | 'audio'

const SCOPE_TTL_MS = 10_000
let scopeCache: { at: number; scopes: BsuidPilotScope[] } | null = null

/** Test hook: forget the cached pilot scopes. */
export function resetBsuidScopeCache(): void { scopeCache = null }

/** Enabled DB pilot scopes, cached for a few seconds (one query per TTL for the whole process). Any error → none (fail closed). */
export async function getDbPilotScopes(now: number = Date.now()): Promise<BsuidPilotScope[]> {
  if (scopeCache && now - scopeCache.at < SCOPE_TTL_MS) return scopeCache.scopes
  try {
    const { data, error } = await supabaseAdmin().from('bsuid_pilot_scopes').select('account_id, phone_number_id, waba_id').eq('enabled', true)
    if (error || !Array.isArray(data)) { scopeCache = { at: now, scopes: [] }; return [] }
    const scopes = (data as Array<{ account_id: string; phone_number_id: string; waba_id: string }>).map((r) => ({
      accountId: String(r.account_id).toLowerCase(), phoneNumberId: String(r.phone_number_id), wabaId: String(r.waba_id),
    }))
    scopeCache = { at: now, scopes }
    return scopes
  } catch {
    scopeCache = { at: now, scopes: [] }
    return []
  }
}

export async function bsuidFlowScope(accountId: string, contactId: string): Promise<string[]> {
  try {
    const { data, error } = await supabaseAdmin().rpc('bsuid_flow_scope', { p_account_id: accountId, p_contact_id: contactId })
    if (error || !Array.isArray(data)) return []
    return (data as unknown[]).filter((x): x is string => typeof x === 'string')
  } catch {
    return []
  }
}

/** 'ok', or the reason the send is refused ('check_failed' when the database could not answer). */
export async function bsuidFlowSendCheck(accountId: string, runId: string, contactId: string, modality: FlowSendModality): Promise<string> {
  try {
    const { data, error } = await supabaseAdmin().rpc('bsuid_flow_send_check', { p_account_id: accountId, p_run_id: runId, p_contact_id: contactId, p_modality: modality })
    if (error || typeof data !== 'string') return 'check_failed'
    return data
  } catch {
    return 'check_failed'
  }
}
