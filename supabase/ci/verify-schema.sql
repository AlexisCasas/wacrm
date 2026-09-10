-- Post-migration assertions for the CI job in
-- `.github/workflows/migrations.yml`.
--
-- `supabase db reset` already fails on any statement Postgres rejects,
-- so this is not about syntax. It's about the quieter failure: a
-- migration that applies cleanly and does nothing. Every DDL statement
-- in this repo is guarded with IF NOT EXISTS / ON CONFLICT so the files
-- can be re-run safely, and that same guard turns a typo'd object name
-- into a silent no-op with a green checkmark.
--
-- Keep this thin. It is a smoke test for "did the migrations actually
-- build the schema", not a spec of it — asserting every column here
-- would just be the migrations restated in a second place, drifting.
DO $$
BEGIN
  -- The core tables, from 001.
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'public.messages is missing — migrations did not apply';
  END IF;
  IF to_regclass('public.whatsapp_config') IS NULL THEN
    RAISE EXCEPTION 'public.whatsapp_config is missing — migrations did not apply';
  END IF;

  -- Supabase provides the storage schema; migrations 016/020/023 write
  -- to it. If it is absent the bucket migrations silently accomplish
  -- nothing, which is precisely the case a plain "no errors" run hides.
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION
      'storage.buckets is missing — the storage schema was not available when the bucket migrations ran';
  END IF;

  -- Buckets are UPSERTed, so their absence means the INSERT never ran.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'chat-media') THEN
    RAISE EXCEPTION 'the chat-media bucket row was not created (migration 023)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'flow-media') THEN
    RAISE EXCEPTION 'the flow-media bucket row was not created (migration 016)';
  END IF;

  -- Account scoping (017) is load-bearing for every RLS policy.
  IF to_regclass('public.accounts') IS NULL THEN
    RAISE EXCEPTION 'public.accounts is missing — migration 017 did not apply';
  END IF;

  -- P1 Fase 2C (046) — the new-row phone guard must exist as BOTH the
  -- function and the trigger; either one missing means the guard is a
  -- silent no-op despite a green migration run. This is a trigger
  -- (not a CHECK) deliberately — see 046's own comment for why a CHECK
  -- would have broken updates to pre-existing empty-phone contacts.
  IF to_regprocedure('public.contacts_require_phone_on_write()') IS NULL THEN
    RAISE EXCEPTION 'contacts_require_phone_on_write() is missing — migration 046 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_contacts_require_phone_on_write'
      AND tgrelid = 'public.contacts'::regclass
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'trg_contacts_require_phone_on_write is missing on public.contacts — migration 046 did not apply';
  END IF;

  -- P3 (047) — the contact_tags cross-account integrity trigger, same
  -- function+trigger existence pattern as 046 above.
  IF to_regprocedure('public.contact_tags_require_same_account()') IS NULL THEN
    RAISE EXCEPTION 'contact_tags_require_same_account() is missing — migration 047 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_contact_tags_require_same_account'
      AND tgrelid = 'public.contact_tags'::regclass
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'trg_contact_tags_require_same_account is missing on public.contact_tags — migration 047 did not apply';
  END IF;

  -- P3 (048) — case-insensitive per-account tag name uniqueness.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'tags' AND indexname = 'idx_tags_account_name_ci'
  ) THEN
    RAISE EXCEPTION 'idx_tags_account_name_ci is missing on public.tags — migration 048 did not apply';
  END IF;

  -- P3 (049) — default-tags provisioning function must exist so both
  -- the historical backfill and handle_new_user's future-account hook
  -- are real, not silent no-ops.
  IF to_regprocedure('public.create_default_account_tags(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'create_default_account_tags(uuid,uuid) is missing — migration 049 did not apply';
  END IF;

  -- P3 (049) — that helper must NOT be callable by normal clients.
  -- Confirmed against a real Postgres that Supabase's own
  -- default-privileges setup grants EXECUTE directly to anon/
  -- authenticated/service_role (separately from PUBLIC) at CREATE
  -- time, so a plain "REVOKE ... FROM PUBLIC" alone would leave this
  -- silently exploitable — the exact regression this guards.
  IF has_function_privilege('anon', 'public.create_default_account_tags(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.create_default_account_tags(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.create_default_account_tags(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'create_default_account_tags(uuid,uuid) is EXECUTE-able by anon/authenticated/service_role — migration 049''s REVOKE did not apply or was undone';
  END IF;

  -- P3 (049) — accounts.default_tags_provisioned_at: the real
  -- one-time-per-account idempotency marker (nullable — NULL means
  -- "may still be provisioned", NOT NULL means "never touch again").
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'accounts'
      AND column_name = 'default_tags_provisioned_at'
      AND data_type = 'timestamp with time zone'
      AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'public.accounts.default_tags_provisioned_at is missing, non-nullable, or not timestamptz — migration 049 did not apply as expected';
  END IF;

  -- P3 (049) — tags.is_default: the column, and both triggers that
  -- protect it as an invariant (never silently reintroduced as an
  -- unqualified boolean column with no guard).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tags' AND column_name = 'is_default'
      AND is_nullable = 'NO' AND column_default = 'false'
  ) THEN
    RAISE EXCEPTION 'public.tags.is_default is missing, nullable, or not DEFAULT false — migration 049 did not apply as expected';
  END IF;

  -- Forward direction: default=true + rename/recolor -> false.
  IF to_regprocedure('public.tags_clear_default_on_edit()') IS NULL THEN
    RAISE EXCEPTION 'tags_clear_default_on_edit() is missing — migration 049 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_tags_clear_default_on_edit'
      AND tgrelid = 'public.tags'::regclass
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'trg_tags_clear_default_on_edit is missing on public.tags — migration 049 did not apply';
  END IF;

  -- Inverse direction: nothing outside create_default_account_tags()
  -- may ever set is_default=true (direct INSERT or an UPDATE
  -- false->true) — confirmed exploitable against a real Postgres
  -- before this trigger existed.
  IF to_regprocedure('public.tags_protect_is_default()') IS NULL THEN
    RAISE EXCEPTION 'tags_protect_is_default() is missing — migration 049 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_tags_protect_is_default'
      AND tgrelid = 'public.tags'::regclass
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'trg_tags_protect_is_default is missing on public.tags — migration 049 did not apply';
  END IF;

  RAISE NOTICE 'schema verification passed';
END
$$;

-- Two things this file has already been burned by, both verified in CI
-- rather than assumed:
--
-- 1. It must contain EXACTLY ONE statement. `supabase db query --file`
--    sends the whole file as a prepared statement, and a second
--    top-level statement fails with the distinctly unhelpful "cannot
--    insert multiple commands into a prepared statement" (commit
--    f91a6c8). Add assertions INSIDE the DO block above; do not append
--    a second one.
--
-- 2. A RAISE in here really does fail the job. A deliberately false
--    assertion (commit 42c7db0, run 31579334056) surfaced as
--    `failed to execute query: error: ...` and exited 1. This is not a
--    decorative green tick.
