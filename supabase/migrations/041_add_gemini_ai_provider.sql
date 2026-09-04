-- ============================================================
-- 041_add_gemini_ai_provider
--
-- Widens the `provider` CHECK constraint to allow 'gemini' alongside
-- the existing 'openai' / 'anthropic' (see src/lib/ai/types.ts
-- AiProvider). Two tables carry their own independent CHECK on this
-- column, both declared inline in their CREATE TABLE:
--   - ai_configs   (029_ai_reply.sql)       — the account's chosen provider
--   - ai_usage_log (033_ai_reply_polish.sql) — which provider a given
--     LLM call spent tokens on
-- Both need the same widening, or a Gemini call's usage row would
-- fail its INSERT. That failure would be SILENT: logAiUsage (see
-- src/lib/ai/usage.ts) deliberately swallows its own errors so a
-- broken usage log can never fail the customer-facing reply — which
-- is exactly why it's worth closing here rather than discovering it
-- later as "Gemini usage never shows up in the account's spend."
--
-- Both constraints were declared as inline column CHECKs with no
-- explicit name, so Postgres auto-named them — for a table's first
-- (and only) CHECK on a given column this is `<table>_<column>_check`
-- by convention, i.e. ai_configs_provider_check /
-- ai_usage_log_provider_check. Rather than hardcode that assumption,
-- this migration looks up each constraint DYNAMICALLY by its actual
-- definition (a CHECK on `provider` naming exactly 'openai' and
-- 'anthropic', not yet 'gemini') and drops whatever it is actually
-- called — so a renamed constraint in a real install is still found
-- and replaced safely. No other CHECK constraint on either table
-- (e.g. ai_usage_log's `mode` CHECK) is touched.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

DO $$
DECLARE
  r RECORD;
BEGIN
  -- 1) Drop the existing 2-provider CHECK on each table, whatever it's
  --    actually named. Matched by definition, not by a guessed name:
  --    a CHECK constraint on `provider` that mentions 'openai' and
  --    'anthropic' but not yet 'gemini'.
  FOR r IN
    SELECT con.oid, con.conname, con.conrelid::regclass AS tbl
    FROM pg_constraint con
    WHERE con.contype = 'c'
      AND con.conrelid IN ('public.ai_configs'::regclass, 'public.ai_usage_log'::regclass)
      AND pg_get_constraintdef(con.oid) ILIKE '%provider%'
      AND pg_get_constraintdef(con.oid) ILIKE '%openai%'
      AND pg_get_constraintdef(con.oid) ILIKE '%anthropic%'
      AND pg_get_constraintdef(con.oid) NOT ILIKE '%gemini%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;

  -- 2) Re-add under the canonical (Postgres-default) name, guarded so
  --    a re-run — or an install where the constraint was already
  --    correctly named and thus untouched by step 1 — doesn't error
  --    on "constraint already exists". PostgreSQL has no
  --    "ADD CONSTRAINT IF NOT EXISTS", so guard via pg_constraint
  --    (same idiom as migration 013).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_configs_provider_check'
      AND conrelid = 'public.ai_configs'::regclass
  ) THEN
    ALTER TABLE public.ai_configs
      ADD CONSTRAINT ai_configs_provider_check
      CHECK (provider IN ('openai', 'anthropic', 'gemini'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_usage_log_provider_check'
      AND conrelid = 'public.ai_usage_log'::regclass
  ) THEN
    ALTER TABLE public.ai_usage_log
      ADD CONSTRAINT ai_usage_log_provider_check
      CHECK (provider IN ('openai', 'anthropic', 'gemini'));
  END IF;
END $$;
