-- 20261122000000_bsuid_flow_auto_authorization
--
-- Permanent, per-account, automatic BSUID authorization of Flows (builds on 078: bsuid_flow_authorizations / bsuid_flow_send_check).
--
-- WHAT IT DOES
--   For an account that has a row in `bsuid_flow_autoauth` with enabled = true, every ACTIVE Flow whose nodes are all supported for
--   hidden-number (BSUID) contacts gets ONE whole-account authorization (contact_id NULL, expires_at NULL) whose modalities are EXACTLY
--   what the Flow (and every sub-flow it can call, transitively) needs. The row is created/updated when the Flow is published
--   (status -> active), renamed, or its nodes are saved, and it is DISABLED when the Flow stops being active or stops being eligible.
--
-- WHAT IT DOES NOT DO
--   * It is NOT a universal permission: `bsuid_flow_send_check` (078/079) still evaluates, on EVERY send, the active run, the whole call
--     stack, the modality, the account master switch (bsuid_flow_settings.flows_enabled), the contact and account volume ceilings.
--   * It never touches another account: nothing happens for an account without an enabled `bsuid_flow_autoauth` row.
--   * It never authorizes drafts, Flows with unsupported node types (collect_input, handoff, anything new), Flows whose sub-flows are not
--     eligible, Flows that would form a call cycle, or Flows named like a test ("prueba", "prueva", "test ...").
--   * Audio (send_product_audios) is only authorized when `audio_enabled` is true on the account's row.
--   * Contact-scoped authorizations (contact_id NOT NULL) are never created, changed or disabled here.
--
-- Additive and idempotent. Rollback: see the end of this file (drop the triggers; authorizations already written stay and can be disabled).

CREATE TABLE IF NOT EXISTS public.bsuid_flow_autoauth (
  account_id    uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  enabled       boolean NOT NULL DEFAULT false,
  audio_enabled boolean NOT NULL DEFAULT false,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.bsuid_flow_autoauth ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bsuid_flow_autoauth FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bsuid_flow_autoauth TO service_role;

-- Pure evaluation of ONE flow: is it eligible, and which modalities does it need (itself + every sub-flow it can call)?
CREATE OR REPLACE FUNCTION public.bsuid_flow_autoauth_eval(p_flow uuid, p_stack uuid[] DEFAULT '{}')
RETURNS TABLE (ok boolean, need_media boolean, need_buttons boolean, need_list boolean, need_audio boolean, reason text)
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  v_flow public.flows%ROWTYPE;
  v_audio_ok boolean;
  v_bad text;
  v_media boolean; v_buttons boolean; v_list boolean; v_audio boolean;
  v_t uuid;
  r record;
BEGIN
  IF COALESCE(array_length(p_stack, 1), 0) >= 6 THEN RETURN QUERY SELECT false, false, false, false, false, 'subflow_depth'; RETURN; END IF;
  IF p_flow = ANY (p_stack) THEN RETURN QUERY SELECT false, false, false, false, false, 'subflow_cycle'; RETURN; END IF;
  SELECT * INTO v_flow FROM public.flows f WHERE f.id = p_flow;
  IF NOT FOUND THEN RETURN QUERY SELECT false, false, false, false, false, 'flow_not_found'; RETURN; END IF;
  IF v_flow.status <> 'active' THEN RETURN QUERY SELECT false, false, false, false, false, 'not_active'; RETURN; END IF;
  IF v_flow.name ~* '^\s*(prueba|prueva|test)\M' THEN RETURN QUERY SELECT false, false, false, false, false, 'test_flow'; RETURN; END IF;
  SELECT a.audio_enabled INTO v_audio_ok FROM public.bsuid_flow_autoauth a WHERE a.account_id = v_flow.account_id;
  v_audio_ok := COALESCE(v_audio_ok, false);  -- no row for the account => audio is NOT enabled

  SELECT string_agg(DISTINCT n.node_type, ',') INTO v_bad FROM public.flow_nodes n
   WHERE n.flow_id = p_flow AND n.node_type NOT IN
     ('start','end','send_message','delay','send_media','set_contact_field','set_tag','condition','execute_flow','send_buttons','send_list','send_product_audios');
  IF v_bad IS NOT NULL THEN RETURN QUERY SELECT false, false, false, false, false, 'unsupported_node:' || v_bad; RETURN; END IF;

  SELECT COALESCE(bool_or(n.node_type = 'send_media'), false), COALESCE(bool_or(n.node_type = 'send_buttons'), false),
         COALESCE(bool_or(n.node_type = 'send_list'), false), COALESCE(bool_or(n.node_type = 'send_product_audios'), false)
    INTO v_media, v_buttons, v_list, v_audio FROM public.flow_nodes n WHERE n.flow_id = p_flow;
  IF v_audio AND NOT v_audio_ok THEN RETURN QUERY SELECT false, false, false, false, false, 'audio_not_enabled'; RETURN; END IF;

  FOR v_t IN
    SELECT DISTINCT CASE WHEN n.config->>'target_flow_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                         THEN (n.config->>'target_flow_id')::uuid END
      FROM public.flow_nodes n WHERE n.flow_id = p_flow AND n.node_type = 'execute_flow'
  LOOP
    IF v_t IS NULL THEN RETURN QUERY SELECT false, false, false, false, false, 'subflow_target_invalid'; RETURN; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.flows c WHERE c.id = v_t AND c.account_id = v_flow.account_id) THEN
      RETURN QUERY SELECT false, false, false, false, false, 'subflow_other_account_or_missing'; RETURN;
    END IF;
    SELECT * INTO r FROM public.bsuid_flow_autoauth_eval(v_t, p_stack || p_flow);
    IF NOT r.ok THEN RETURN QUERY SELECT false, false, false, false, false, 'subflow:' || COALESCE(r.reason, '?'); RETURN; END IF;
    v_media := v_media OR r.need_media; v_buttons := v_buttons OR r.need_buttons; v_list := v_list OR r.need_list; v_audio := v_audio OR r.need_audio;
  END LOOP;
  RETURN QUERY SELECT true, v_media, v_buttons, v_list, v_audio, 'ok'::text;
END $$;

-- Brings ONE flow's whole-account authorization in line with its current state (idempotent), then its callers.
CREATE OR REPLACE FUNCTION public.bsuid_flow_autoauth_sync(p_flow uuid, p_depth int DEFAULT 0)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_flow public.flows%ROWTYPE;
  e record;
  v_changed boolean := false;
  v_caller uuid;
  v_n int;
BEGIN
  IF p_depth > 6 THEN RETURN; END IF;
  SELECT * INTO v_flow FROM public.flows f WHERE f.id = p_flow;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bsuid_flow_autoauth a WHERE a.account_id = v_flow.account_id AND a.enabled) THEN RETURN; END IF;

  SELECT * INTO e FROM public.bsuid_flow_autoauth_eval(p_flow);
  IF e.ok THEN
    INSERT INTO public.bsuid_flow_authorizations AS t
      (account_id, flow_id, contact_id, enabled, allow_text, allow_media, allow_buttons, allow_list, allow_audio, expires_at, note)
    VALUES (v_flow.account_id, p_flow, NULL, true, true, e.need_media, e.need_buttons, e.need_list, e.need_audio, NULL, 'bsuid-auto')
    ON CONFLICT (account_id, flow_id, COALESCE(contact_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE
      SET enabled = true, allow_text = true, allow_media = EXCLUDED.allow_media, allow_buttons = EXCLUDED.allow_buttons,
          allow_list = EXCLUDED.allow_list, allow_audio = EXCLUDED.allow_audio, expires_at = NULL
      WHERE (t.enabled, t.allow_text, t.allow_media, t.allow_buttons, t.allow_list, t.allow_audio, t.expires_at IS NULL)
            IS DISTINCT FROM (true, true, EXCLUDED.allow_media, EXCLUDED.allow_buttons, EXCLUDED.allow_list, EXCLUDED.allow_audio, true);
  ELSE
    UPDATE public.bsuid_flow_authorizations a SET enabled = false
     WHERE a.account_id = v_flow.account_id AND a.flow_id = p_flow AND a.contact_id IS NULL AND a.enabled;
  END IF;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_changed := v_n > 0;
  -- a changed callee can change its callers' eligibility / required modalities
  FOR v_caller IN
    SELECT DISTINCT n.flow_id FROM public.flow_nodes n
     WHERE n.node_type = 'execute_flow' AND n.config->>'target_flow_id' = p_flow::text AND n.flow_id <> p_flow
  LOOP
    PERFORM public.bsuid_flow_autoauth_sync(v_caller, p_depth + 1);
  END LOOP;
END $$;

-- Whole account (used when the account's row is created or its switches change; callable by the operator).
CREATE OR REPLACE FUNCTION public.bsuid_flow_autoauth_reconcile(p_account uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_flow uuid; v_n integer := 0;
BEGIN
  FOR v_flow IN SELECT f.id FROM public.flows f WHERE f.account_id = p_account LOOP
    PERFORM public.bsuid_flow_autoauth_sync(v_flow, 0); v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

CREATE OR REPLACE FUNCTION public.bsuid_flow_autoauth_on_flow() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.bsuid_flow_autoauth_sync(NEW.id, 0);
  RETURN NULL;
END $$;

-- Node saves arrive as several row changes in ONE transaction: evaluate once per flow, at commit, when all of them are in place.
CREATE OR REPLACE FUNCTION public.bsuid_flow_autoauth_on_node() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_flow uuid := COALESCE(NEW.flow_id, OLD.flow_id); v_key text := 'wacrm.bsuid_autoauth.' || replace(v_flow::text, '-', '_');
BEGIN
  IF current_setting(v_key, true) = '1' THEN RETURN NULL; END IF;
  PERFORM set_config(v_key, '1', true);
  PERFORM public.bsuid_flow_autoauth_sync(v_flow, 0);
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.bsuid_flow_autoauth_on_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.bsuid_flow_autoauth_after_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.enabled THEN PERFORM public.bsuid_flow_autoauth_reconcile(NEW.account_id); END IF;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.bsuid_flow_autoauth_eval(uuid, uuid[]), public.bsuid_flow_autoauth_sync(uuid, int), public.bsuid_flow_autoauth_reconcile(uuid),
  public.bsuid_flow_autoauth_on_flow(), public.bsuid_flow_autoauth_on_node(), public.bsuid_flow_autoauth_on_account(), public.bsuid_flow_autoauth_after_account()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bsuid_flow_autoauth_eval(uuid, uuid[]), public.bsuid_flow_autoauth_sync(uuid, int), public.bsuid_flow_autoauth_reconcile(uuid) TO service_role;

DROP TRIGGER IF EXISTS bsuid_flow_autoauth_flow_ins ON public.flows;
CREATE TRIGGER bsuid_flow_autoauth_flow_ins AFTER INSERT ON public.flows
  FOR EACH ROW EXECUTE FUNCTION public.bsuid_flow_autoauth_on_flow();
DROP TRIGGER IF EXISTS bsuid_flow_autoauth_flow_upd ON public.flows;
CREATE TRIGGER bsuid_flow_autoauth_flow_upd AFTER UPDATE OF status, name ON public.flows
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION public.bsuid_flow_autoauth_on_flow();

DROP TRIGGER IF EXISTS bsuid_flow_autoauth_node ON public.flow_nodes;
CREATE CONSTRAINT TRIGGER bsuid_flow_autoauth_node AFTER INSERT OR UPDATE OR DELETE ON public.flow_nodes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.bsuid_flow_autoauth_on_node();

DROP TRIGGER IF EXISTS bsuid_flow_autoauth_touch ON public.bsuid_flow_autoauth;
CREATE TRIGGER bsuid_flow_autoauth_touch BEFORE UPDATE ON public.bsuid_flow_autoauth
  FOR EACH ROW EXECUTE FUNCTION public.bsuid_flow_autoauth_on_account();
DROP TRIGGER IF EXISTS bsuid_flow_autoauth_reconcile_trg ON public.bsuid_flow_autoauth;
CREATE TRIGGER bsuid_flow_autoauth_reconcile_trg AFTER INSERT OR UPDATE OF enabled, audio_enabled ON public.bsuid_flow_autoauth
  FOR EACH ROW EXECUTE FUNCTION public.bsuid_flow_autoauth_after_account();

-- ROLLBACK (the authorizations already written are plain rows of 078 and keep working; disable them with flow_pilot.sh if needed):
--   DROP TRIGGER bsuid_flow_autoauth_reconcile_trg ON public.bsuid_flow_autoauth; DROP TRIGGER bsuid_flow_autoauth_touch ON public.bsuid_flow_autoauth;
--   DROP TRIGGER bsuid_flow_autoauth_node ON public.flow_nodes; DROP TRIGGER bsuid_flow_autoauth_flow_upd ON public.flows; DROP TRIGGER bsuid_flow_autoauth_flow_ins ON public.flows;
--   (then optionally the functions bsuid_flow_autoauth_* and the table bsuid_flow_autoauth)
