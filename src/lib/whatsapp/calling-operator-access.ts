import { ForbiddenError } from '@/lib/auth/account'
import { canOperateWhatsAppCalling, isOperationalRole } from '@/lib/auth/operational-role'
import { isAccountRole, type AccountRole } from '@/lib/auth/roles'
import { supabaseAdmin } from '@/lib/flows/admin-client'

type CallingActor = {
  accountId: string
  userId: string
  role: AccountRole
}

type CallingOperation = {
  action?: string
  callId?: string
}

/**
 * Authoritative, fresh per-request authorization. The client never supplies
 * account/actor/role values. Server-only: do not import from React components.
 *
 * The only post-demotion escape hatch is a narrowly owned clean-up operation:
 * a previous claimant may release its lease, or the actual initiator/acceptor
 * may terminate the same call. No new calls, claims, signaling, SDP or Meta
 * permission checks are permitted after loss of operational privileges.
 */
export async function assertCallingOperator(
  actor: CallingActor,
  operation: CallingOperation = {},
): Promise<void> {
  const db = supabaseAdmin()

  const { data: profile, error } = await db
    .from('profiles')
    .select('account_role,operational_role')
    .eq('account_id', actor.accountId)
    .eq('user_id', actor.userId)
    .maybeSingle()

  if (error || !profile || !isAccountRole(profile.account_role)
    || profile.account_role !== actor.role) {
    throw new ForbiddenError('Calling access could not be verified')
  }

  const area = isOperationalRole(profile.operational_role)
    ? profile.operational_role
    : null

  if (canOperateWhatsAppCalling(profile.account_role, area)) return

  if (!['release', 'terminate'].includes(operation.action ?? '')
    || !operation.callId || !/^wacid\.[A-Za-z0-9._~+/=-]{1,512}$/.test(operation.callId)) {
    throw new ForbiddenError('Only Logistics and Supervisor can operate WhatsApp Calling')
  }

  const { data: call, error: callError } = await db
    .from('whatsapp_call_sessions')
    .select('direction,state,claimed_by_user_id,accepted_by_user_id,initiated_by_user_id')
    .eq('account_id', actor.accountId)
    .eq('call_id', operation.callId)
    .maybeSingle()

  if (callError || !call
    || ['terminated', 'failed', 'rejected'].includes(call.state)) {
    throw new ForbiddenError('No active call is available for cleanup')
  }

  const ownsClaim = call.claimed_by_user_id === actor.userId
  const ownsAnsweredCall = call.accepted_by_user_id === actor.userId
  const ownsOutboundCall = call.initiated_by_user_id === actor.userId
    && call.direction === 'BUSINESS_INITIATED'

  if (operation.action === 'release' && ownsClaim) return
  if (operation.action === 'terminate' && (ownsClaim || ownsAnsweredCall || ownsOutboundCall)) return

  throw new ForbiddenError('Only the original call operator may finish this call')
}
