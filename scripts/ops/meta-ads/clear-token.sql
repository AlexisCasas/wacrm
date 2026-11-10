-- Revocation / offboarding: after revoking the token in Meta Business Settings, wipe the stored ciphertext and stop the sync.
-- Usage: docker exec -i supabase-db psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -v acct="'<WACRM account uuid>'" < clear-token.sql
BEGIN;
UPDATE public.meta_ads_settings
   SET access_token_enc = NULL, enabled = FALSE, token_status = 'unverified', disabled_reason = 'token_cleared_by_operator', disabled_at = now(), updated_at = now()
 WHERE account_id = :acct;
UPDATE public.meta_ads_sync_state SET status = 'paused', lease_until = NULL, updated_at = now() WHERE account_id = :acct AND job = 'catalog';
COMMIT;
