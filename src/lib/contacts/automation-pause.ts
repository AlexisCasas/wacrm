import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Per-contact "pause keyword automations" switch (table contact_automation_settings, migration 20261104000000).
 *
 * Read by the two keyword gates only: Flow entry by keyword (src/lib/flows/engine.ts) and the `keyword_match` automation trigger
 * (src/lib/automations/engine.ts). Absent row = not paused. Scoped by contact AND account (service role bypasses RLS).
 *
 * Any read error other than "table not there yet" is thrown so the caller fails CLOSED (no automatic start) rather than messaging a
 * customer an agent asked not to automate. A missing table (migration not applied yet) means nobody is paused.
 */
export async function isKeywordAutomationsPaused(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from('contact_automation_settings')
    .select('keyword_automations_paused')
    .eq('contact_id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205') return false
    throw new Error(`keyword_pause_read_failed:${error.code ?? error.message}`)
  }
  return data?.keyword_automations_paused === true
}

/**
 * The read policy used by every consumer (Flow keyword entry, `keyword_match` automations, AI auto-reply stand-down), so they never disagree:
 * a real read error counts as PAUSED (fail closed: nothing keyword-driven starts), a missing table counts as NOT paused (rollout compatibility).
 * Never throws.
 */
export async function keywordAutomationsPausedFailClosed(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<boolean> {
  try {
    return await isKeywordAutomationsPaused(db, accountId, contactId)
  } catch (err) {
    console.error('[automations] keyword pause check failed, treating as paused:', err instanceof Error ? err.message : err)
    return true
  }
}
