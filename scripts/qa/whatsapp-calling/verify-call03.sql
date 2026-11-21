-- CALL-03A SQL verification: call/contact/conversation linkage, agent attribution and lease renewal.
-- One DO statement. Synthetic auth/account/contact/conversation/call fixtures are
-- rolled back by the sentinel subtransaction; this script is safe only on local CI.
DO $qa$
DECLARE
  v_user_a uuid := 'a3000000-0000-4000-8000-000000000001';
  v_user_b uuid := 'a3000000-0000-4000-8000-000000000002';
  v_user_c uuid := 'a3000000-0000-4000-8000-000000000003';
  v_account_a uuid;
  v_account_b uuid;
  v_contact_a uuid := gen_random_uuid();
  v_contact_b uuid := gen_random_uuid();
  v_contact_wrong uuid := gen_random_uuid();
  v_conversation_a uuid := gen_random_uuid();
  v_conversation_b uuid := gen_random_uuid();
  v_conversation_wrong uuid := gen_random_uuid();
  v_call_accept text := 'wacid.qa-call03-accept';
  v_call_reject text := 'wacid.qa-call03-reject';
  v_call_outbound text := 'wacid.qa-call03-outbound';
  v_call_cross_tenant text := 'wacid.qa-call03-cross-tenant';
  v_call_wrong_identity text := 'wacid.qa-call03-wrong-identity';
  v_call_unowned text := 'wacid.qa-call03-unowned';
  v_cross_tenant_rejected boolean := false;
  v_wrong_identity_rejected boolean := false;
  v_unowned_accept_rejected boolean := false;
  v_unowned_end_rejected boolean := false;
  v_renew_signature text := 'public.whatsapp_call_claim_renew(uuid,text,text,uuid)';
  v_action_signature text := 'public.whatsapp_call_session_agent_action(uuid,text,text,uuid,text,uuid)';
BEGIN
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='whatsapp_call_sessions'
        AND column_name='conversation_id'
    ) OR NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='whatsapp_call_sessions'
        AND column_name='accepted_by_user_id'
    ) OR NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='whatsapp_call_sessions'
        AND column_name='biz_opaque_callback_data'
    ) THEN
      RAISE EXCEPTION 'CALL03A_METADATA_COLUMNS_MISSING';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname='whatsapp_call_session_metadata_guard'
        AND tgrelid='public.whatsapp_call_sessions'::regclass
        AND NOT tgisinternal
    ) THEN
      RAISE EXCEPTION 'CALL03A_METADATA_GUARD_TRIGGER_MISSING';
    END IF;

    IF NOT has_function_privilege('service_role',v_renew_signature,'EXECUTE')
      OR has_function_privilege('anon',v_renew_signature,'EXECUTE')
      OR has_function_privilege('authenticated',v_renew_signature,'EXECUTE')
      OR NOT has_function_privilege('service_role',v_action_signature,'EXECUTE')
      OR has_function_privilege('anon',v_action_signature,'EXECUTE')
      OR has_function_privilege('authenticated',v_action_signature,'EXECUTE')
    THEN
      RAISE EXCEPTION 'CALL03A_RPC_GRANTS_INVALID';
    END IF;

    INSERT INTO auth.users (
      id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    ) VALUES
      (v_user_a,'authenticated','authenticated','call03a-agent-a@example.invalid','',now(),
       '{}'::jsonb,'{"full_name":"CALL03A Agent A"}'::jsonb,now(),now()),
      (v_user_b,'authenticated','authenticated','call03a-agent-b@example.invalid','',now(),
       '{}'::jsonb,'{"full_name":"CALL03A Agent B"}'::jsonb,now(),now()),
      (v_user_c,'authenticated','authenticated','call03a-agent-c@example.invalid','',now(),
       '{}'::jsonb,'{"full_name":"CALL03A Agent C"}'::jsonb,now(),now());

    SELECT account_id INTO v_account_a FROM public.profiles WHERE user_id=v_user_a;
    SELECT account_id INTO v_account_b FROM public.profiles WHERE user_id=v_user_b;
    IF v_account_a IS NULL OR v_account_b IS NULL OR v_account_a=v_account_b THEN
      RAISE EXCEPTION 'CALL03A_SYNTHETIC_ACCOUNTS_NOT_CREATED';
    END IF;

    -- Agent C is a member of A's account but has not claimed any call.
    UPDATE public.profiles
    SET account_id=v_account_a, account_role='agent'
    WHERE user_id=v_user_c;
    DELETE FROM public.accounts WHERE owner_user_id=v_user_c;
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles
      WHERE user_id=v_user_c AND account_id=v_account_a AND account_role='agent'
    ) THEN
      RAISE EXCEPTION 'CALL03A_UNOWNED_AGENT_SETUP_FAILED';
    END IF;

    INSERT INTO public.contacts(id,user_id,account_id,phone,name)
    VALUES
      (v_contact_a,v_user_a,v_account_a,'51911111111','CALL03A synthetic A'),
      (v_contact_b,v_user_b,v_account_b,'51922222222','CALL03A synthetic B'),
      (v_contact_wrong,v_user_a,v_account_a,'51933333333','CALL03A wrong identity');

    INSERT INTO public.conversations(id,user_id,account_id,contact_id,status)
    VALUES
      (v_conversation_a,v_user_a,v_account_a,v_contact_a,'open'),
      (v_conversation_b,v_user_b,v_account_b,v_contact_b,'open'),
      (v_conversation_wrong,v_user_a,v_account_a,v_contact_wrong,'open');

    -- Inbound offer -> one agent claims, renews and accepts it. Link trigger
    -- must resolve the conversation to the same contact and tenant.
    PERFORM public.whatsapp_call_event_apply(
      v_account_a,'740434745820831',v_call_accept,repeat('a',64),
      'connect',1795120000,'USER_INITIATED','51911111111','51911111111',
      NULL,NULL,'CALL03A synthetic A','offered','encrypted:qa-offer','offer',
      now()+interval '5 minutes',NULL,NULL,NULL
    );
    IF public.whatsapp_call_claim(v_account_a,'740434745820831',v_call_accept,v_user_a) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'CALL03A_INITIAL_CLAIM_FAILED';
    END IF;
    IF public.whatsapp_call_claim_renew(v_account_a,'740434745820831',v_call_accept,v_user_a) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'CALL03A_CLAIM_RENEWAL_FAILED';
    END IF;

    UPDATE public.whatsapp_call_sessions
    SET claim_expires_at=now()-interval '1 second'
    WHERE phone_number_id='740434745820831' AND call_id=v_call_accept;
    IF public.whatsapp_call_claim_renew(v_account_a,'740434745820831',v_call_accept,v_user_a) IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'CALL03A_EXPIRED_CLAIM_WAS_RESURRECTED';
    END IF;
    IF public.whatsapp_call_claim(v_account_a,'740434745820831',v_call_accept,v_user_a) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'CALL03A_EXPIRED_CLAIM_COULD_NOT_BE_RECLAIMED';
    END IF;
    IF public.whatsapp_call_session_agent_action(
      v_account_a,'740434745820831',v_call_accept,v_user_a,'accepted',v_conversation_a
    ) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'CALL03A_ACCEPT_ATTRIBUTION_FAILED';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.whatsapp_call_sessions
      WHERE phone_number_id='740434745820831' AND call_id=v_call_accept
        AND contact_id=v_contact_a AND conversation_id=v_conversation_a
        AND accepted_by_user_id=v_user_a
    ) THEN
      RAISE EXCEPTION 'CALL03A_ACCEPT_METADATA_NOT_PERSISTED';
    END IF;

    -- Once accepted, an expired claim must not allow a second agent to
    -- take over the connected call. Attribution remains with Agent A.
    UPDATE public.whatsapp_call_sessions
    SET claim_expires_at=now()-interval '1 second'
    WHERE phone_number_id='740434745820831' AND call_id=v_call_accept;
    IF public.whatsapp_call_claim(v_account_a,'740434745820831',v_call_accept,v_user_c) IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'CALL03A_ACCEPTED_CALL_RECLAIMED_BY_SECOND_AGENT';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.whatsapp_call_sessions
      WHERE phone_number_id='740434745820831' AND call_id=v_call_accept
        AND accepted_by_user_id=v_user_a
        AND claimed_by_user_id=v_user_a
    ) THEN
      RAISE EXCEPTION 'CALL03A_ACCEPTED_AGENT_ATTRIBUTION_CHANGED';
    END IF;

    IF public.whatsapp_call_session_agent_action(
      v_account_a,'740434745820831',v_call_accept,v_user_a,'ended',v_conversation_a
    ) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'CALL03A_END_ATTRIBUTION_FAILED';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.whatsapp_call_sessions
      WHERE phone_number_id='740434745820831' AND call_id=v_call_accept
        AND ended_by_user_id=v_user_a
        AND claimed_by_user_id IS NULL AND claim_expires_at IS NULL
    ) THEN
      RAISE EXCEPTION 'CALL03A_END_AGENT_NOT_PERSISTED';
    END IF;
    IF public.whatsapp_call_claim(v_account_a,'740434745820831',v_call_accept,v_user_a) IS DISTINCT FROM false
      OR public.whatsapp_call_claim_renew(v_account_a,'740434745820831',v_call_accept,v_user_a) IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'CALL03A_TERMINATED_CALL_RECLAIMED';
    END IF;

    -- A same-account agent without the claim/initiator/acceptor ownership
    -- cannot accept or terminate another agent's call.
    PERFORM public.whatsapp_call_event_apply(
      v_account_a,'740434745820831',v_call_unowned,repeat('f',64),
      'connect',1795120005,'USER_INITIATED','51911111111','51911111111',
      NULL,NULL,'CALL03A synthetic A','offered','encrypted:qa-offer','offer',
      now()+interval '5 minutes',NULL,NULL,NULL
    );
    v_unowned_accept_rejected := NOT public.whatsapp_call_session_agent_action(
      v_account_a,'740434745820831',v_call_unowned,v_user_c,'accepted',NULL
    );
    v_unowned_end_rejected := NOT public.whatsapp_call_session_agent_action(
      v_account_a,'740434745820831',v_call_unowned,v_user_c,'ended',NULL
    );
    IF NOT v_unowned_accept_rejected OR NOT v_unowned_end_rejected THEN
      RAISE EXCEPTION 'CALL03A_UNOWNED_AGENT_ACTION_WAS_ALLOWED';
    END IF;

    -- An unclaimed incoming call can be rejected, but the rejecting agent
    -- and its conversation are still recorded.
    PERFORM public.whatsapp_call_event_apply(
      v_account_a,'740434745820831',v_call_reject,repeat('b',64),
      'connect',1795120001,'USER_INITIATED','51911111111','51911111111',
      NULL,NULL,'CALL03A synthetic A','offered','encrypted:qa-offer','offer',
      now()+interval '5 minutes',NULL,NULL,NULL
    );
    IF public.whatsapp_call_session_agent_action(
      v_account_a,'740434745820831',v_call_reject,v_user_a,'rejected',v_conversation_a
    ) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'CALL03A_REJECT_ATTRIBUTION_FAILED';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.whatsapp_call_sessions
      WHERE phone_number_id='740434745820831' AND call_id=v_call_reject
        AND rejected_by_user_id=v_user_a AND conversation_id=v_conversation_a
        AND claimed_by_user_id IS NULL AND claim_expires_at IS NULL
    ) THEN
      RAISE EXCEPTION 'CALL03A_REJECT_METADATA_NOT_PERSISTED';
    END IF;
    IF public.whatsapp_call_claim(v_account_a,'740434745820831',v_call_reject,v_user_c) IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'CALL03A_REJECTED_CALL_RECLAIMED';
    END IF;

    -- Outbound calls retain the initiating agent independently from the
    -- later Meta state transition.
    PERFORM public.whatsapp_call_event_apply(
      v_account_a,'740434745820831',v_call_outbound,repeat('c',64),
      'connect',1795120002,'BUSINESS_INITIATED','51911111111','51911111111',
      NULL,NULL,'CALL03A synthetic A','connecting',NULL,NULL,NULL,NULL,NULL,NULL
    );
    IF public.whatsapp_call_session_agent_action(
      v_account_a,'740434745820831',v_call_outbound,v_user_a,'initiated',v_conversation_a
    ) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'CALL03A_INITIATOR_ATTRIBUTION_FAILED';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.whatsapp_call_sessions
      WHERE phone_number_id='740434745820831' AND call_id=v_call_outbound
        AND initiated_by_user_id=v_user_a AND conversation_id=v_conversation_a
    ) THEN
      RAISE EXCEPTION 'CALL03A_INITIATOR_METADATA_NOT_PERSISTED';
    END IF;

    -- A session in account A must never be linked to account B's conversation.
    PERFORM public.whatsapp_call_event_apply(
      v_account_a,'740434745820831',v_call_cross_tenant,repeat('d',64),
      'connect',1795120003,'USER_INITIATED','51911111111','51911111111',
      NULL,NULL,'CALL03A synthetic A','offered','encrypted:qa-offer','offer',
      now()+interval '5 minutes',NULL,NULL,NULL
    );
    PERFORM public.whatsapp_call_claim(v_account_a,'740434745820831',v_call_cross_tenant,v_user_a);
    BEGIN
      PERFORM public.whatsapp_call_session_agent_action(
        v_account_a,'740434745820831',v_call_cross_tenant,v_user_a,'accepted',v_conversation_b
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM IN ('call_conversation_tenant_conflict','call_conversation_already_linked') THEN
        v_cross_tenant_rejected := true;
      ELSE
        RAISE;
      END IF;
    END;
    IF NOT v_cross_tenant_rejected THEN
      RAISE EXCEPTION 'CALL03A_CROSS_TENANT_CONVERSATION_WAS_LINKED';
    END IF;

    -- A same-tenant conversation is still invalid when its contact does
    -- not match the WhatsApp phone/BSUID stored on the call.
    PERFORM public.whatsapp_call_event_apply(
      v_account_a,'740434745820831',v_call_wrong_identity,repeat('e',64),
      'connect',1795120004,'USER_INITIATED','51911111111','51911111111',
      NULL,NULL,'CALL03A synthetic A','offered','encrypted:qa-offer','offer',
      now()+interval '5 minutes',NULL,NULL,NULL
    );
    PERFORM public.whatsapp_call_claim(v_account_a,'740434745820831',v_call_wrong_identity,v_user_a);
    BEGIN
      -- Directly exercise the database metadata guard: the webhook has
      -- already resolved the real contact, so a different same-tenant
      -- contact/conversation must be rejected by the trigger itself.
      UPDATE public.whatsapp_call_sessions
      SET contact_id=v_contact_wrong,
          conversation_id=v_conversation_wrong
      WHERE phone_number_id='740434745820831'
        AND call_id=v_call_wrong_identity;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM='call_contact_identity_mismatch' THEN
        v_wrong_identity_rejected := true;
      ELSE
        RAISE;
      END IF;
    END;
    IF NOT v_wrong_identity_rejected THEN
      RAISE EXCEPTION 'CALL03A_WRONG_CONTACT_CONVERSATION_WAS_LINKED';
    END IF;

    RAISE EXCEPTION '__CALL03A_QA_ROLLBACK__';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='__CALL03A_QA_ROLLBACK__' THEN
      RAISE NOTICE 'CALL03A_SQL_QA=PASS; synthetic fixtures rolled back';
    ELSE
      RAISE;
    END IF;
  END;
END
$qa$;
