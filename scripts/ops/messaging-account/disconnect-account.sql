-- ROLLBACK of connect-account.sql: removes ONLY the configuration that script created, and only if it is still exactly what it created.
-- Meta side first: if the app was subscribed to the messaging account, unsubscribe it there BEFORE running this (this script does not call Meta)
-- and pass confirm_unsubscribed=yes.
--
--   psql -v ON_ERROR_STOP=1 -v account_id=... -v phone_number_id=... -v messaging_account_id=... -v confirm_unsubscribed=yes -f disconnect-account.sql
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('wa.account', :'account_id', true), set_config('wa.pn', :'phone_number_id', true), set_config('wa.ma', :'messaging_account_id', true),
       set_config('wa.ack', :'confirm_unsubscribed', true) \gset
LOCK TABLE public.whatsapp_config IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE _wa_before ON COMMIT DROP AS SELECT id, md5(to_jsonb(w)::text) h FROM public.whatsapp_config w;
DO $$
DECLARE n int; r public.whatsapp_config%ROWTYPE;
BEGIN
  IF current_setting('wa.ack') <> 'yes' THEN RAISE EXCEPTION 'guard: confirm_unsubscribed=yes is required (unsubscribe the app on Meta first)'; END IF;
  SELECT * INTO r FROM public.whatsapp_config WHERE account_id = current_setting('wa.account')::uuid FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'guard: the account has no configuration'; END IF;
  IF r.phone_number_id <> current_setting('wa.pn') OR r.messaging_account_id IS DISTINCT FROM current_setting('wa.ma') THEN RAISE EXCEPTION 'guard: the configuration is not the one this procedure created'; END IF;
  DELETE FROM public.whatsapp_config WHERE id = r.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'expected exactly 1 row deleted, got %', n; END IF;
  SELECT count(*) INTO n FROM public.whatsapp_config w JOIN _wa_before b USING (id) WHERE md5(to_jsonb(w)::text) <> b.h;
  IF n <> 0 THEN RAISE EXCEPTION 'guard: another configuration changed'; END IF;
  RAISE NOTICE 'DELETED_1_ROW';
END $$;
COMMIT;
