import type { SupabaseClient } from '@supabase/supabase-js'

import { ForbiddenError } from '@/lib/auth/account'

// Defense in depth for the Comercial -> Logistica handoff (migration 20261127000000). Row-level security is the real authority over who can list,
// open, read and write a conversation (the Inbox talks to the database directly); the server routes that DELIVER messages to WhatsApp ask the same
// database function first, so a request that RLS would hide answers a clear 403 instead of a confusing "not found", and nothing is sent to Meta.
//
// The decision is made by public.conversation_operational_access(account, conversation) from auth.uid(): with logistics_mvp_enabled OFF it always
// says yes (legacy behaviour); with it ON, commercial may work conversations WITHOUT a confirmed order, logistics only those WITH one, supervisor
// both, no operational area none. The account is the caller's session account, never a value from the browser.

export const CONVERSATION_STAGE_FORBIDDEN = 'This conversation is not available to your operational area'

/**
 * Throws ForbiddenError when the caller's operational area may not work this conversation. A database that does not have the function yet
 * (migration not applied) behaves as before (allowed): the policies would not be protecting anything either. Any other failure fails closed.
 */
export async function assertConversationOperationalAccess(supabase: SupabaseClient, accountId: string, conversationId: string): Promise<void> {
  const { data, error } = await supabase.rpc('conversation_operational_access', {
    p_account_id: accountId,
    p_conversation_id: conversationId,
  })
  if (error) {
    // 42883 = undefined_function (Postgres), PGRST202 = function not in the PostgREST schema cache.
    if (error.code === '42883' || error.code === 'PGRST202') return
    throw new ForbiddenError('Could not verify access to this conversation')
  }
  if (data !== true) throw new ForbiddenError(CONVERSATION_STAGE_FORBIDDEN)
}
