-- ============================================================
-- 045_profile_locale.sql
--
-- P1 — ESPAÑOL POR DEFECTO + SELECTOR POR USUARIO ESPAÑOL / ENGLISH.
--
-- Adds a PER-USER interface-language preference. Deliberately on
-- `profiles`, NOT `accounts` — language is a personal preference like
-- theme/appearance, not an account-wide setting. Two users on the
-- same account (even a viewer and an owner) can each read WACRM in a
-- different language without affecting one another or any shared
-- account data.
--
-- Business rule this column exists to serve (enforced in application
-- code, src/i18n/request.ts + src/i18n/config.ts — this migration
-- only stores the value):
--   locale='en'                          -> English
--   locale='es'                          -> Spanish
--   no locale / invalid locale / error   -> Spanish
--   not authenticated                    -> Spanish
-- Spanish is the default and the universal fallback — never English,
-- and never the browser's Accept-Language.
--
-- Idempotent — safe to run multiple times, matching every prior
-- migration's style (IF NOT EXISTS, backfill only rows that need it).
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'es';

-- Existing rows created before this column existed already got 'es'
-- from the column default when Postgres added it (DEFAULT applies to
-- both new AND pre-existing rows on ADD COLUMN) — this UPDATE is a
-- no-op in that case, but stays as an explicit, idempotent statement
-- of intent (and a safety net if some prior deploy path set locale to
-- something else before the CHECK below existed).
UPDATE profiles SET locale = 'es' WHERE locale IS NULL;

-- Added as a separate statement (rather than inline on the column)
-- so re-running this migration against a database that already has
-- rows never fails re-validating existing data before the constraint
-- exists — ADD COLUMN ... DEFAULT already guarantees every row is
-- 'es' or a value written after this migration first ran, and the
-- CHECK is enforced from here on for every future write.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_locale_check'
  ) THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_locale_check CHECK (locale IN ('es', 'en'));
  END IF;
END $$;

-- ============================================================
-- SECURITY — profiles.locale is self-service, same as full_name /
-- avatar_url. It must NOT go through the account_role/account_id
-- lockdown from migration 034 (enforce_profile_privilege_columns) —
-- that trigger only inspects those two columns, so a plain
-- self-service UPDATE that only touches `locale` already passes
-- through it untouched. No trigger change needed here; this comment
-- exists so a future reader auditing that trigger can confirm locale
-- was deliberately left alone rather than overlooked.
--
-- The existing `profiles_update` RLS policy (migration 017:
-- USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id))
-- already lets ANY authenticated user — owner, admin, agent, or
-- viewer alike — update their OWN locale. Changing your own display
-- language is not an account-wide configuration and was never gated
-- by account_role; no new RLS policy or RPC is needed for this
-- feature to be secure and self-service for every role.
-- ============================================================
