import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client for contact-blocking writes that
// have no RLS policy for authenticated users (contact_block_events,
// and the flow_runs / automation_pending_executions side effects of
// blocking). Mirrors src/lib/flows/admin-client.ts and
// src/lib/automations/admin-client.ts — same shape, same convention.
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}
