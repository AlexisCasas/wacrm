-- Optional: undo migration 20261103000000. The column is additive and harmless, so the normal rollback is "redeploy the previous image" and
-- leave it. Use this only to return the schema to its previous shape. It REFUSES while any configuration still names a messaging account
-- (dropping it would silently turn that account's sends back into unnamed sends).
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.whatsapp_config WHERE messaging_account_id IS NOT NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'guard: % configuration(s) still use messaging_account_id', n; END IF;
END $$;
ALTER TABLE public.whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_messaging_account_id_format;
ALTER TABLE public.whatsapp_config DROP COLUMN IF EXISTS messaging_account_id;
COMMIT;
