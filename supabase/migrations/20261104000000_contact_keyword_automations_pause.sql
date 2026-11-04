-- ============================================================
-- 20261104000000_contact_keyword_automations_pause
--
-- Per-contact switch that stops NEW keyword-triggered automation for ONE contact (Inbox sidebar "AUTOMATIZACIONES" -> Pausar / Reanudar):
--   * Flows whose entry trigger is `keyword` (including the keyword replacement of a waiting run), and
--   * Automations with trigger `keyword_match`.
-- Nothing else is affected: inbound storage, manual Flow start, replies to an active Flow, waits, other automation triggers, tags, cron, webhooks.
-- It never touches flow_runs, automation_logs or automation_pending_executions.
--
-- Why a separate table and not a column on `contacts`: every UPDATE of `contacts` bumps `updated_at` (trigger set_updated_at), which is the
-- compare-and-set token of the Inbox standard-field editor, so toggling the switch would make an open editor report a false conflict. This
-- is system state, not a user-visible custom field.
--
-- Absent row = NOT paused (every existing contact keeps today's behaviour; nothing is backfilled). Additive and idempotent.
-- Reads: account members (RLS). Writes: only PUT /api/contacts/[id]/automation-pause through the service role (requireRole('agent')).
--
-- Compatibility: the previous app version never reads this table, so applying the migration BEFORE the deploy is harmless; the new app
-- treats a missing table as "not paused". ORDER: migration -> deploy app.
--
-- ROLLBACK (only after rolling the app back, or at any time: the old app ignores the table):
--   DROP TABLE IF EXISTS public.contact_automation_settings;
-- ============================================================

CREATE TABLE IF NOT EXISTS public.contact_automation_settings (
  contact_id UUID PRIMARY KEY REFERENCES public.contacts(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  keyword_automations_paused BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_contact_automation_settings_account
  ON public.contact_automation_settings(account_id) WHERE keyword_automations_paused = true;

ALTER TABLE public.contact_automation_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_automation_settings_select ON public.contact_automation_settings;
CREATE POLICY contact_automation_settings_select ON public.contact_automation_settings
  FOR SELECT USING (is_account_member(account_id));
-- No INSERT/UPDATE/DELETE policy for authenticated users: writes go through the API route (service role), like contact_block_events.
