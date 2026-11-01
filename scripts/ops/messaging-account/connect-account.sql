-- CONNECT an account to a number through its OWN Meta messaging account, WITHOUT calling Meta (no /register, no subscribed_apps) and without
-- touching any other row. Run only after the deploy of the messaging_account_id release is authorised AND the cut-over is authorised.
--
--   psql -v ON_ERROR_STOP=1 -v account_id=... -v actor_user_id=... -v phone_number_id=... -v waba_id=... -v messaging_account_id=... \
--        -v cipher_token=... [-v cipher_verify=...] [-v cipher_app_secret=...] -f connect-account.sql
--
-- The three cipher_* values are CIPHERTEXT produced by the application (encrypt-secret.js), never plaintext. Exactly ONE row is inserted;
-- the script aborts (nothing written) unless every guard holds.
\set ON_ERROR_STOP on
\if :{?cipher_verify} \else \set cipher_verify '' \endif
\if :{?cipher_app_secret} \else \set cipher_app_secret '' \endif
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('wa.account', :'account_id', true), set_config('wa.actor', :'actor_user_id', true), set_config('wa.pn', :'phone_number_id', true),
       set_config('wa.waba', :'waba_id', true), set_config('wa.ma', :'messaging_account_id', true), set_config('wa.tok', :'cipher_token', true),
       set_config('wa.ver', :'cipher_verify', true), set_config('wa.sec', :'cipher_app_secret', true) \gset
LOCK TABLE public.whatsapp_config IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE _wa_before ON COMMIT DROP AS SELECT id, md5(to_jsonb(w)::text) h FROM public.whatsapp_config w;
DO $$
DECLARE n int; v_account uuid := current_setting('wa.account')::uuid; v_actor uuid := current_setting('wa.actor')::uuid;
        v_pn text := current_setting('wa.pn'); v_waba text := current_setting('wa.waba'); v_ma text := current_setting('wa.ma');
BEGIN
  IF v_pn !~ '^[0-9]{5,25}$' OR v_waba !~ '^[0-9]{5,25}$' OR v_ma !~ '^[0-9]{5,25}$' THEN RAISE EXCEPTION 'guard: ids must be 5-25 digits'; END IF;
  IF length(current_setting('wa.tok')) < 40 OR current_setting('wa.tok') !~ '^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$' THEN RAISE EXCEPTION 'guard: cipher_token is not GCM ciphertext (iv:ct:tag)'; END IF;
  IF current_setting('wa.ver') <> '' AND current_setting('wa.ver') !~ '^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$' THEN RAISE EXCEPTION 'guard: cipher_verify is not GCM ciphertext'; END IF;
  IF current_setting('wa.sec') <> '' AND current_setting('wa.sec') !~ '^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$' THEN RAISE EXCEPTION 'guard: cipher_app_secret is not GCM ciphertext'; END IF;
  PERFORM 1 FROM public.accounts WHERE id = v_account;
  IF NOT FOUND THEN RAISE EXCEPTION 'guard: destination account does not exist'; END IF;
  PERFORM 1 FROM public.profiles WHERE user_id = v_actor AND account_id = v_account AND account_role IN ('owner','admin');
  IF NOT FOUND THEN RAISE EXCEPTION 'guard: actor is not an owner/admin of the destination account'; END IF;
  SELECT count(*) INTO n FROM public.whatsapp_config WHERE account_id = v_account;
  IF n <> 0 THEN RAISE EXCEPTION 'guard: destination account already has a whatsapp_config'; END IF;
  SELECT count(*) INTO n FROM public.whatsapp_config WHERE phone_number_id = v_pn;
  IF n <> 0 THEN RAISE EXCEPTION 'guard: this phone_number_id already belongs to a configuration'; END IF;
  INSERT INTO public.whatsapp_config (account_id, user_id, phone_number_id, waba_id, messaging_account_id, access_token, verify_token, app_secret, status, connected_at)
  VALUES (v_account, v_actor, v_pn, v_waba, v_ma, current_setting('wa.tok'), NULLIF(current_setting('wa.ver'), ''), NULLIF(current_setting('wa.sec'), ''), 'disconnected', NULL);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'expected exactly 1 row inserted, got %', n; END IF;
  -- status 'disconnected' + NULL timestamps on purpose: nothing was registered or subscribed on Meta, so the account must not read as operational.
  -- activate-account.sql flips it AFTER the (separately authorised) subscription.
  SELECT count(*) INTO n FROM public.whatsapp_config w JOIN _wa_before b USING (id) WHERE md5(to_jsonb(w)::text) <> b.h;
  IF n <> 0 THEN RAISE EXCEPTION 'guard: another configuration changed'; END IF;
  SELECT count(*) INTO n FROM public.whatsapp_config WHERE id NOT IN (SELECT id FROM _wa_before);
  IF n <> 1 THEN RAISE EXCEPTION 'guard: expected exactly one new configuration, got %', n; END IF;
  RAISE NOTICE 'INSERTED_1_ROW';
END $$;
COMMIT;
