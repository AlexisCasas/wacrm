-- E4.2 PR #30 audit fix (P1): Inbox repair that works after the run has ended. Additive.
--
-- Migration 060 lets a confirmed effect exist without its Inbox message when the Inbox write fails, and offers
-- reconcile_versioned_effect_messages for the repair. That RPC is gated on an ACTIVE run and a live lease, so once the
-- interpreter advanced past the confirmed effect and finished the run (completed / failed) the repair became impossible.
--
-- repair_versioned_run_inbox is the repair for runs in ANY state:
--   * no lease and no active-run gate: it never executes the flow and never changes the run, the cursor, the budget or
--     the effect (confirmed effects are read-only here); it only creates the Inbox message and the link that are missing
--   * account, run, effect and conversation are validated inside PostgreSQL (persist_versioned_effect_message refuses a
--     conversation of another account or contact); another account or a legacy run is "versioned run not found"
--   * it locks the run row, so concurrent repairs (and the run's own writers) are serialised; the PRIMARY KEY on
--     flow_run_effect_messages and the UNIQUE (conversation_id, message_id) on messages still forbid duplicates
--   * the message is written as 'sent' (the provider only accepted it); delivered/read come from the status webhook
--   * a failure is reported per effect (outcome 'failed' + SQLSTATE) and recorded as an id-only 'error' event: the
--     message text is never copied into events
--   * service_role only. No scheduler: something has to call it.
CREATE FUNCTION public.repair_versioned_run_inbox(p_account_id UUID, p_run_id UUID)
RETURNS TABLE (effect_id UUID, message_id UUID, outcome TEXT, reason TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_run public.flow_runs%ROWTYPE; r public.flow_run_effects%ROWTYPE; v_link UUID; v_id UUID;
BEGIN
  IF p_account_id IS NULL OR p_run_id IS NULL THEN
    RAISE EXCEPTION 'invalid versioned run request' USING ERRCODE = '22023';
  END IF;
  v_run := public.lock_versioned_run(p_account_id, p_run_id);   -- FOR UPDATE on the run row; any status
  FOR r IN SELECT * FROM public.flow_run_effects x
            WHERE x.flow_run_id = v_run.id AND x.account_id = p_account_id AND x.state = 'confirmed'
            ORDER BY x.occurrence_revision LOOP
    SELECT m.message_id INTO v_link FROM public.flow_run_effect_messages m WHERE m.effect_id = r.id;
    IF FOUND THEN
      RETURN QUERY SELECT r.id, v_link, 'already_persisted', NULL::text;
      CONTINUE;
    END IF;
    BEGIN
      v_id := public.persist_versioned_effect_message(r.id);
      IF v_id IS NULL THEN
        RETURN QUERY SELECT r.id, NULL::uuid, 'skipped', 'not_persistable';   -- no conversation, or it is not this account/contact's
      ELSE
        RETURN QUERY SELECT r.id, v_id, 'created', NULL::text;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.flow_run_events (flow_run_id, event_type, node_key, payload)
      VALUES (v_run.id, 'error', r.node_key, jsonb_build_object('reason', 'inbox_repair_failed', 'effect_id', r.id, 'sqlstate', SQLSTATE));
      RETURN QUERY SELECT r.id, NULL::uuid, 'failed', SQLSTATE;
    END;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.repair_versioned_run_inbox(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.repair_versioned_run_inbox(UUID, UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.repair_versioned_run_inbox(UUID, UUID) TO service_role;
