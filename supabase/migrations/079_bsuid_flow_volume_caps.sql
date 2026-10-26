-- ============================================================
-- 079_bsuid_flow_volume_caps
--
-- BSUID phase 4B: volume ceilings for AUTOMATIC (Flow) sends to contacts known only by a WhatsApp user id. They bound the damage of an anomalous
-- run (a loop, a customer that keeps re-triggering a keyword, a misconfigured flow) and never apply to contacts with a phone number.
--
-- Additive and idempotent: two columns with safe defaults on bsuid_flow_settings and a REPLACEMENT of bsuid_flow_send_check (migration 078) that
-- first applies exactly the same authorization checks and then the ceilings:
--   max_contact_sends_per_hour   bot messages already sent to THIS contact in the last hour   (default 60  ~ 10 runs of a 6-message flow)
--   max_account_sends_per_hour   bot messages already sent to ALL hidden-number contacts of the account in the last hour (default 1200)
-- When a ceiling is reached the send is refused with 'rate_limited_contact' / 'rate_limited_account' (the app audits it as send_blocked and the run
-- ends failed); sends resume by themselves as the hour rolls. Only sender_type = 'bot' counts (manual replies are 'agent').
-- Privileges are unchanged (service_role only).
-- ============================================================

ALTER TABLE public.bsuid_flow_settings
  ADD COLUMN IF NOT EXISTS max_contact_sends_per_hour integer NOT NULL DEFAULT 60   CHECK (max_contact_sends_per_hour > 0),
  ADD COLUMN IF NOT EXISTS max_account_sends_per_hour integer NOT NULL DEFAULT 1200 CHECK (max_account_sends_per_hour > 0);

CREATE OR REPLACE FUNCTION public.bsuid_flow_send_check(p_account_id uuid, p_run_id uuid, p_contact_id uuid, p_modality text) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  v_run public.flow_runs%ROWTYPE;
  v_flows uuid[];
  v_flow uuid;
  v_auth public.bsuid_flow_authorizations%ROWTYPE;
  v_cmax integer;
  v_amax integer;
  v_n bigint;
BEGIN
  IF p_modality IS NULL OR p_modality NOT IN ('text', 'media', 'buttons', 'list', 'audio') THEN RETURN 'bad_modality'; END IF;
  SELECT * INTO v_run FROM public.flow_runs r
   WHERE r.id = p_run_id AND r.account_id = p_account_id AND r.contact_id = p_contact_id AND r.status = 'active';
  IF NOT FOUND THEN RETURN 'run_invalid'; END IF;
  SELECT s.max_contact_sends_per_hour, s.max_account_sends_per_hour INTO v_cmax, v_amax
    FROM public.bsuid_flow_settings s WHERE s.account_id = p_account_id AND s.flows_enabled;
  IF NOT FOUND THEN RETURN 'flows_disabled'; END IF;
  v_flows := ARRAY[v_run.flow_id] || COALESCE(ARRAY[v_run.current_flow_id], '{}'::uuid[])
             || COALESCE((SELECT array_agg(fr.callee_flow_id) FROM public.flow_run_subflow_frames fr WHERE fr.flow_run_id = v_run.id), '{}'::uuid[]);
  FOR v_flow IN SELECT DISTINCT x FROM unnest(v_flows) x WHERE x IS NOT NULL LOOP
    SELECT * INTO v_auth FROM public.bsuid_flow_authorizations a
     WHERE a.account_id = p_account_id AND a.flow_id = v_flow AND a.enabled
       AND (a.expires_at IS NULL OR a.expires_at > now())
       AND (a.contact_id IS NULL OR a.contact_id = p_contact_id)
     ORDER BY (a.contact_id IS NOT NULL) DESC LIMIT 1;
    IF NOT FOUND THEN RETURN 'flow_not_authorized'; END IF;
    IF NOT (CASE p_modality WHEN 'text' THEN v_auth.allow_text WHEN 'media' THEN v_auth.allow_media WHEN 'buttons' THEN v_auth.allow_buttons
                            WHEN 'list' THEN v_auth.allow_list WHEN 'audio' THEN v_auth.allow_audio END) THEN
      RETURN 'modality_not_allowed';
    END IF;
  END LOOP;
  -- volume ceilings (bot messages only, last hour)
  SELECT count(*) INTO v_n FROM public.messages m JOIN public.conversations cv ON cv.id = m.conversation_id
   WHERE cv.contact_id = p_contact_id AND m.sender_type = 'bot' AND m.created_at > now() - interval '1 hour';
  IF v_n >= v_cmax THEN RETURN 'rate_limited_contact'; END IF;
  SELECT count(*) INTO v_n FROM public.contacts c JOIN public.conversations cv ON cv.contact_id = c.id JOIN public.messages m ON m.conversation_id = cv.id
   WHERE c.account_id = p_account_id AND c.phone_optional AND m.sender_type = 'bot' AND m.created_at > now() - interval '1 hour';
  IF v_n >= v_amax THEN RETURN 'rate_limited_account'; END IF;
  RETURN 'ok';
END $$;

REVOKE ALL ON FUNCTION public.bsuid_flow_send_check(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bsuid_flow_send_check(uuid, uuid, uuid, text) TO service_role;
