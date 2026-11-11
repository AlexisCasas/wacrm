-- Contact deletion (single and bulk) timed out for batches because deleting a contact / conversation fires one referential-integrity
-- lookup PER DELETED ROW on every referencing table, and these five foreign-key columns had no index: each lookup was a full scan of the
-- table (measured on production: ~55-380 ms each; 100 contacts => several full scans each => far beyond the API role's 8 s statement_timeout).
-- Index-only change: no data, no function, no policy, no timeout setting is touched and delete semantics are unchanged (nothing is
-- blocked or tombstoned; the same phone/BSUID can still create a new contact and chat).
-- Partial indexes (column IS NOT NULL) are used by the equality lookups the FK triggers issue and stay small.

CREATE INDEX IF NOT EXISTS idx_whatsapp_message_pricing_conversation ON public.whatsapp_message_pricing (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_flow_runs_conversation ON public.flow_runs (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_flow_runs_contact ON public.flow_runs (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automation_logs_contact ON public.automation_logs (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automation_pending_contact ON public.automation_pending_executions (contact_id) WHERE contact_id IS NOT NULL;
