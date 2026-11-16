-- SEARCH-01: EXPERIMENTAL QA-ONLY INDEXES. NOT A PRODUCTION MIGRATION.
-- NOT meant to be executed automatically during deployment.
-- Requirements:
--   - Confirm connected database is search01-rpcqa synthetic PostgreSQL.
--   - Backup its baseline report/EXPLAIN before adding indexes.
--   - Execute as a separate A/B experimental arm after testing V2 as-is.
--   - Do not apply on QA115 or the Supabase WACRM production database.
-- Note: OR predicates spanning joined contacts/conversations may prevent
-- the planner from taking advantage of these GIN indexes. Measure
-- EXPLAIN (ANALYZE, BUFFERS) under authenticated-equivalent RLS.
--
-- pg_trgm is shipped with PostgreSQL 17 contrib packages.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
SET search_path = public, extensions;

CREATE INDEX IF NOT EXISTS search01_qa_contacts_name_trgm
  ON public.contacts USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS search01_qa_contacts_phone_trgm
  ON public.contacts USING gin (phone gin_trgm_ops);
CREATE INDEX IF NOT EXISTS search01_qa_contacts_username_trgm
  ON public.contacts USING gin (wa_username gin_trgm_ops);
CREATE INDEX IF NOT EXISTS search01_qa_conversations_last_message_trgm
  ON public.conversations USING gin (last_message_text gin_trgm_ops);

-- A matching tenant/order index can make keyset pages cheaper only if
-- the planner is able to combine account restriction with ordering.
CREATE INDEX IF NOT EXISTS search01_qa_conversations_account_keyset
  ON public.conversations
  (account_id, last_message_at DESC NULLS LAST, id ASC);

ANALYZE public.contacts;
ANALYZE public.conversations;

-- This is NOT proof of a performance win. Compare p50/p95 and plans
-- BEFORE vs AFTER under the exact same dataset/roles; report individual
-- index sizes and total bytes. Stop if QA resource pressure increases.
