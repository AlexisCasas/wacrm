-- ============================================================
-- 043_whatsapp_config_app_secret
--
-- Multi-tenant Meta App Secret (feat/per-account-meta-app-secret).
--
-- The inbound webhook (src/app/api/whatsapp/webhook/route.ts) has
-- always validated x-hub-signature-256 against a single, global
-- `process.env.META_APP_SECRET`. That only works when every account
-- on this install shares one Meta App. Now that different accounts
-- connect through different Meta Apps (and therefore different App
-- Secrets), the global env var can no longer be the sole source of
-- truth: it has no way to know which secret a given account's Meta
-- App actually signs with.
--
-- This column lets each `whatsapp_config` row carry its OWN App
-- Secret, so the webhook can look up the right one via the
-- phone_number_id / waba_id the payload identifies itself with,
-- BEFORE trusting anything else in the body. See
-- src/lib/whatsapp/webhook-tenant-secret.ts for the resolution logic
-- and src/lib/whatsapp/webhook-signature.ts for the verification
-- itself.
--
-- Storage: ciphertext only, produced by the app's existing
-- src/lib/whatsapp/encryption.ts (the SAME AES-256-GCM scheme already
-- used for access_token / verify_token). Nothing here or in the
-- application code ever writes plaintext to this column.
--
-- Nullable + no backfill: existing rows keep app_secret = NULL, and
-- the webhook falls back to the legacy process.env.META_APP_SECRET
-- for exactly those rows (never for a row that has its own secret —
-- see webhook-tenant-secret.ts). This is what keeps every
-- already-configured account working without anyone re-entering
-- anything.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS app_secret TEXT NULL;

COMMENT ON COLUMN whatsapp_config.app_secret IS
  'Per-account Meta App Secret (Meta Developers -> App Settings -> Basic '
  '-> App Secret), encrypted with src/lib/whatsapp/encryption.ts (AES-256-GCM) '
  'before storage. NULL means this account has not set one yet, in which '
  'case the webhook falls back to the legacy global META_APP_SECRET env var '
  'for signature verification. Never store plaintext here.';
