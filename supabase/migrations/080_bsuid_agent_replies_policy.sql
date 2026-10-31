-- ============================================================
-- 080_bsuid_agent_replies_policy
--
-- P0 incident (2026-10-26): human agents of a business that serves hidden-number customers could not answer them from the Inbox, because every manual reply to a BSUID
-- needed an individual operator credit (consume_bsuid_send). That rule fits a pilot with one test contact (Keyler); it does not fit an account where real customers write.
--
-- An EXPLICIT, PER-NUMBER, CLOSED-BY-DEFAULT policy: bsuid_pilot_scopes.agents_reply_without_credit (default false). When it is on for the account's own WhatsApp number
-- (account + phone_number_id + WABA, enabled scope), consume_bsuid_send lets a MANUAL reply through WITHOUT spending a credit, but only when ALL of these hold:
--   * p_origin = 'manual_reply' (the server only says so for an authenticated agent whose role, account and contact it has already verified; Flows, automations, the AI and the
--     public API never reach this branch because the application refuses them before calling the function);
--   * the contact has an ACTIVE BSUID identity in that account;
--   * the customer wrote within the last 24 hours (WhatsApp's customer-service window);
--   * fewer than max_agent_replies_per_contact_hour agent messages were sent to that contact in the last hour (default 60).
-- Otherwise it falls through to the previous credit path (so a granted credit still works). Every use writes an audit row ('send_policy_allowed').
--
-- Additive and idempotent: two columns with safe defaults and a REPLACEMENT of consume_bsuid_send (same signature, same privileges: service_role only).
-- Accounts that do not switch the flag on (Keyler) behave exactly as before.
-- ============================================================

ALTER TABLE public.bsuid_pilot_scopes
  ADD COLUMN IF NOT EXISTS agents_reply_without_credit boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS max_agent_replies_per_contact_hour integer NOT NULL DEFAULT 60 CHECK (max_agent_replies_per_contact_hour > 0);

CREATE OR REPLACE FUNCTION public.consume_bsuid_send(p_account_id uuid, p_contact_id uuid, p_origin text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE v_left int; v_cap int; v_policy boolean := false;
BEGIN
  IF p_origin = 'manual_reply' THEN
    SELECT true, s.max_agent_replies_per_contact_hour INTO v_policy, v_cap
      FROM public.whatsapp_config w
      JOIN public.bsuid_pilot_scopes s ON s.account_id = w.account_id AND s.phone_number_id = w.phone_number_id AND s.waba_id = w.waba_id
                                      AND s.enabled AND s.agents_reply_without_credit
     WHERE w.account_id = p_account_id;
    IF COALESCE(v_policy, false)
       AND EXISTS (SELECT 1 FROM public.contact_identities i
                    WHERE i.account_id = p_account_id AND i.contact_id = p_contact_id AND i.kind = 'bsuid' AND i.superseded_at IS NULL)
       AND EXISTS (SELECT 1 FROM public.messages m JOIN public.conversations cv ON cv.id = m.conversation_id
                    WHERE cv.account_id = p_account_id AND cv.contact_id = p_contact_id AND m.sender_type = 'customer' AND m.created_at > now() - interval '24 hours')
       AND (SELECT count(*) FROM public.messages m JOIN public.conversations cv ON cv.id = m.conversation_id
             WHERE cv.account_id = p_account_id AND cv.contact_id = p_contact_id AND m.sender_type = 'agent' AND m.created_at > now() - interval '1 hour') < v_cap
    THEN
      INSERT INTO public.contact_identity_audit (account_id, contact_id, event, origin, detail)
      VALUES (p_account_id, p_contact_id, 'send_policy_allowed', left(p_origin, 40), jsonb_build_object('policy', 'agents_reply_without_credit'));
      RETURN true;
    END IF;
  END IF;
  -- previous behavior: one operator credit, spent atomically
  UPDATE public.contact_identities
     SET send_authorized_remaining = send_authorized_remaining - 1
   WHERE account_id = p_account_id AND contact_id = p_contact_id AND kind = 'bsuid'
     AND superseded_at IS NULL AND send_authorized_remaining > 0
   RETURNING send_authorized_remaining INTO v_left;
  IF v_left IS NULL THEN RETURN false; END IF;
  INSERT INTO public.contact_identity_audit (account_id, contact_id, event, origin, detail)
  VALUES (p_account_id, p_contact_id, 'send_consumed', left(p_origin, 40), jsonb_build_object('remaining', v_left));
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.consume_bsuid_send(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_bsuid_send(uuid, uuid, text) TO service_role;
