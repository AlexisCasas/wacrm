import type { SupabaseClient } from '@supabase/supabase-js'

import { isOperationalRole } from '@/lib/auth/operational-role'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { isConversationStage, type RoutingState } from '@/lib/conversations/routing-types'

// Read model of the conversation routing for the Inbox sidebar. READ-ONLY: transitions only happen inside the database functions
// (create_order_confirmation and derive_conversation_to_commercial). The account always comes from the session; the flag is read with the service
// role scoped to that account; the stage and the audit trail are read with the CALLER's client, so row-level security applies (a conversation the
// caller's operational area cannot work is simply not found).

const OFF: RoutingState = { enabled: false, stage: null, can_derive: false, derived: null }

/** `null` when the conversation is not visible to the caller (not found / not their stage / other account). */
export async function readRoutingState(ctx: { supabase: SupabaseClient; userId: string; accountId: string }, conversationId: string): Promise<RoutingState | null> {
  const { data: settings, error: settingsError } = await supabaseAdmin()
    .from('order_integration_settings')
    .select('logistics_mvp_enabled')
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (settingsError) throw new Error('settings_lookup_failed')
  if (settings?.logistics_mvp_enabled !== true) return OFF

  const { data: conversation } = await ctx.supabase.from('conversations').select('id').eq('id', conversationId).eq('account_id', ctx.accountId).maybeSingle()
  if (!conversation) return null

  const { data: profile } = await ctx.supabase.from('profiles').select('operational_role').eq('user_id', ctx.userId).eq('account_id', ctx.accountId).maybeSingle()
  const role = profile?.operational_role

  // No routing row means the commercial stage (rule of the model).
  const { data: routing } = await ctx.supabase.from('conversation_routing').select('stage').eq('conversation_id', conversationId).eq('account_id', ctx.accountId).maybeSingle()
  const stage = isConversationStage(routing?.stage) ? routing.stage : 'commercial'

  let derived: RoutingState['derived'] = null
  if (stage === 'shared') {
    const { data: last } = await ctx.supabase
      .from('conversation_routing_events')
      .select('actor_name, created_at')
      .eq('conversation_id', conversationId)
      .eq('account_id', ctx.accountId)
      .eq('reason', 'derived_to_commercial')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (last && typeof last.actor_name === 'string' && typeof last.created_at === 'string') derived = { by: last.actor_name, at: last.created_at }
  }

  return {
    enabled: true,
    stage,
    can_derive: stage === 'logistics' && isOperationalRole(role) && (role === 'logistics' || role === 'supervisor'),
    derived,
  }
}
