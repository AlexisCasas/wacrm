-- CALL-03B2.1 SQL verification: inbound contact/conversation resolution,
-- ambiguity and tenant isolation, idempotent updates, and expired offer cleanup.
-- All synthetic rows are rolled back by the sentinel subtransaction; local CI only.
DO $qa$
DECLARE
  v_user_a uuid := 'c3000000-0000-4000-8000-000000000001';
  v_user_b uuid := 'c3000000-0000-4000-8000-000000000002';
  v_user_c uuid := 'c3000000-0000-4000-8000-000000000003';
  v_account_a uuid;
  v_account_b uuid;
  v_contact_phone uuid := gen_random_uuid();
  v_contact_bsuid uuid := gen_random_uuid();
  v_contact_parent uuid := gen_random_uuid();
  v_contact_closed uuid := gen_random_uuid();
  v_contact_other_tenant uuid := gen_random_uuid();
  v_conversation_phone uuid := gen_random_uuid();
  v_conversation_bsuid uuid := gen_random_uuid();
  v_conversation_parent uuid := gen_random_uuid();
  v_conversation_closed uuid := gen_random_uuid();
  v_conversation_other_tenant uuid := gen_random_uuid();
  v_phone_number_id text := '740434745820831';
  v_call_phone text := 'wacid.qa-call0321-phone';
  v_call_bsuid text := 'wacid.qa-call0321-bsuid';
  v_call_parent text := 'wacid.qa-call0321-parent';
  v_call_ambiguous text := 'wacid.qa-call0321-ambiguous';
  v_call_missing text := 'wacid.qa-call0321-missing';
  v_call_cross_tenant text := 'wacid.qa-call0321-cross-tenant';
  v_call_closed text := 'wacid.qa-call0321-closed';
  v_call_expired text := 'wacid.qa-call0321-expired';
  v_call_fresh text := 'wacid.qa-call0321-fresh';
  v_call_accepted text := 'wacid.qa-call0321-accepted';
  v_call_missing_sdp_stale text := 'wacid.qa-call0321-missing-sdp-stale';
  v_call_missing_sdp_fresh text := 'wacid.qa-call0321-missing-sdp-fresh';
  v_duplicate_result boolean;
  v_pruned integer;
BEGIN
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='whatsapp_call_sessions'
        AND column_name='association_error_code'
    ) THEN
      RAISE EXCEPTION 'CALL0321_ASSOCIATION_ERROR_COLUMN_MISSING';
    END IF;

    IF to_regprocedure('public.whatsapp_call_resolve_inbound_association(uuid,text,text,text)') IS NULL
      OR to_regprocedure('public.whatsapp_call_event_apply(uuid,text,text,text,text,bigint,text,text,text,text,text,text,text,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)') IS NULL
    THEN
      RAISE EXCEPTION 'CALL0321_RESOLUTION_RPC_MISSING';
    END IF;

    IF has_function_privilege('anon','public.whatsapp_call_resolve_inbound_association(uuid,text,text,text)','EXECUTE')
      OR has_function_privilege('authenticated','public.whatsapp_call_resolve_inbound_association(uuid,text,text,text)','EXECUTE')
      OR NOT has_function_privilege('service_role','public.whatsapp_call_resolve_inbound_association(uuid,text,text,text)','EXECUTE')
    THEN
      RAISE EXCEPTION 'CALL0321_RESOLUTION_RPC_GRANTS_INVALID';
    END IF;

    INSERT INTO auth.users (
      id,aud,role,email,encrypted_password,email_confirmed_at,
      raw_app_meta_data,raw_user_meta_data,created_at,updated_at
    ) VALUES
      (v_user_a,'authenticated','authenticated','call0321-a@example.invalid','',now(),
       '{}'::jsonb,'{"full_name":"CALL0321 Agent A"}'::jsonb,now(),now()),
      (v_user_b,'authenticated','authenticated','call0321-b@example.invalid','',now(),
       '{}'::jsonb,'{"full_name":"CALL0321 Agent B"}'::jsonb,now(),now()),
      (v_user_c,'authenticated','authenticated','call0321-c@example.invalid','',now(),
       '{}'::jsonb,'{"full_name":"CALL0321 Agent C"}'::jsonb,now(),now());

    SELECT account_id INTO v_account_a FROM public.profiles WHERE user_id=v_user_a;
    SELECT account_id INTO v_account_b FROM public.profiles WHERE user_id=v_user_b;
    IF v_account_a IS NULL OR v_account_b IS NULL OR v_account_a=v_account_b THEN
      RAISE EXCEPTION 'CALL0321_SYNTHETIC_ACCOUNTS_NOT_CREATED';
    END IF;

    -- Agent C is a second agent in account A for accepted-call ownership checks.
    UPDATE public.profiles
    SET account_id=v_account_a, account_role='agent'
    WHERE user_id=v_user_c;
    DELETE FROM public.accounts WHERE owner_user_id=v_user_c;
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles
      WHERE user_id=v_user_c AND account_id=v_account_a AND account_role='agent'
    ) THEN
      RAISE EXCEPTION 'CALL0321_SECOND_AGENT_SETUP_FAILED';
    END IF;

    INSERT INTO public.contacts(id,user_id,account_id,phone,name) VALUES
      (v_contact_phone,v_user_a,v_account_a,'+51 980 942 247','CALL0321 phone match'),
      (v_contact_bsuid,v_user_a,v_account_a,'+51 980 000 001','CALL0321 BSUID match'),
      (v_contact_parent,v_user_a,v_account_a,'+51 980 000 002','CALL0321 parent BSUID match'),
      (v_contact_closed,v_user_a,v_account_a,'+51 980 000 003','CALL0321 closed conversation'),
      (v_contact_other_tenant,v_user_b,v_account_b,'+51 980 000 004','CALL0321 other tenant');

    INSERT INTO public.contact_identities(account_id,contact_id,kind,value) VALUES
      (v_account_a,v_contact_bsuid,'bsuid','PE.CALL0321.BSUID'),
      (v_account_a,v_contact_parent,'parent_bsuid','PE.CALL0321.PARENT');

    INSERT INTO public.conversations(id,user_id,account_id,contact_id,status) VALUES
      (v_conversation_phone,v_user_a,v_account_a,v_contact_phone,'open'),
      (v_conversation_bsuid,v_user_a,v_account_a,v_contact_bsuid,'open'),
      (v_conversation_parent,v_user_a,v_account_a,v_contact_parent,'pending'),
      (v_conversation_closed,v_user_a,v_account_a,v_contact_closed,'closed'),
      (v_conversation_other_tenant,v_user_b,v_account_b,v_contact_other_tenant,'open');

    -- Phone-only inbound call resolves to the one matching contact and its open conversation.
    PERFORM public.whatsapp_call_event_apply(
      v_account_a,v_phone_number_id,v_call_phone,repeat('a',64),
      'connect',1795120100,'USER_INITIATED','51980942247','51980942247',
      NULL,NULL,'CALL0321 phone match','offered','encrypted:qa-offer','offer',
      now()+interval '5 minutes',NULL,NULL,NULL
    );
    IF NOT EXISTS (
      SELECT 1 FROM public.whatsapp_call_sessions
      WHERE phone_number_id=v_phone_number_id AND call_id=v_call_phone
        AND contact_id=v_contact_phone
        AND conversation_id=v_conversation_phone
        AND association_error_code IS NULL
    ) THEN
      RAISE EXCEPTION 'CALL0321_PHONE_ASSOCIATION_FAILED';
    END IF;

    -- A BSUID can resolve the contact even when Meta omits the phone number.
    PERFORM public.whatsapp_call_event_apply(
      v_account_a,v_phone_number_id,v_call_bsuid,repeat('b',64),
      'connect',1795120101,'USER_INITIATED','PE.CALL0321.BSUID',NULL,
      'PE.CALL0321.BSUID',NULL,'CALL0321 BSUID match','offered',
      'encrypted:qa-offer','offer',now()+interval '5 minutes',NULL,NULL,NULL
    );
    IF NOT EXISTS (
      SELECT 1 FROM public.whatsapp_call_sessions
      WHERE phone_number_id=v_phone_number_id AND call_id=v_call_bsuid
        AND contact_id=v_contact_bsuid
        AND conversation_id=v_conversation_bsuid
        AND association_error_code IS NULL
    ) THEN
      RAISE EXCEPTION 'CALL0321_BSUID_ASSOCIATION_FAILED';
    END IF;

    -- Parent BSUID also resolves without a phone number.
    PERFORM public.whatsapp_call_event_apply(
      v_account_a,v_phone_number_id,v_call_parent,repeat('c',64),
      'connect',1795120102,'USER_INITIATED','PE.CALL0321.PARENT',NULL,
      NULL,'PE.CALL0321.PARENT','CALL0321 parent match','offered',
      'encrypted:qa-offer','offer',now()+interval '5 minutes',NULL,NULL,NULL
    );
    IF NOT EXISTS (
      SELECT 1 FROM public.whatsapp_call_sessions
      WHERE phone_number_id=v_phone_number_id AND call_id=v_call_parent
        AND contact_id=v_contact_parent
        AND conversation_id=v_conversation_parent
        AND association_error_code IS NULL
    ) THEN
      RAISE EXCEPTION 'CALL0321_PARENT_BSUID_ASSOCIATION_FAILED';
    END IF;

    -- A phone that points to contact A and a BSUID that points to contact B
    -- is ambiguous. The resolver must not guess or cross-link either record.
    PERFORM public.whatsapp_call_event_apply(
      v_account_a,v_phone_number_id,v_call_ambiguous,repeat('d',64),
      'connect',1795120103,'USER_INITIATED','PE.CALL0321.BSUID','51980942247',
      'PE.CALL0321.BSUID',NULL,'CALL0321 ambiguous','offered',
      'encrypted:qa-offer','offer',now()+interval '5 minutes',NULL,NULL,NULL
    );
    IF NOT EXISTS (
      SELECT 1 FROM public.whatsapp_call_sessions
      WHERE phone_number_id=v_phone_number_id AND call_id=v_call_ambiguous
        AND contact_id IS NULL AND conversation_id IS NULL
        AND association_error_code='contact_ambiguous'
    ) THEN
      RAISE EXCEPTION 'CALL0321_AMBIGUOUS_IDENTITY_WAS_LINKED';
    END IF;

    -- Unknown phone remains unlinked with an explicit diagnostic.
    PERFORM public.whatsapp_call_event_apply(
      v_account_a,v_phone_number_id,v_call_missing,repeat('e',64),
      'connect',1795120104,'USER_INITIATED','51999999999','51999999999',
      NULL,NULL,'CALL0321 missing','offered','encrypted:qa-offer','offer',
      now()+interval '5 minutes',NULL,NULL,NULL
    );
    IF NOT EXISTS (
      SELECT 1 FROM public.whatsapp_call_sessions
      WHERE phone_number_id=v_phone_number_id AND call_id=v_call_missing
        AND contact_id IS NULL AND conversation_id IS NULL
        AND association_error_code='contact_not_found'
    ) THEN
      RAISE EXCEPTION 'CALL0321_MISSING_CONTACT_WAS_LINKED';
    END IF;

    -- A matching phone in another tenant is not visible to account A.
    PERFORM public.whatsapp_call_event_apply(
      v_account_a,v_phone_number_id,v_call_cross_tenant,repeat('f',64),
      'connect',1795120105,'USER_INITIATED','51980000004','51980000004',
      NULL,NULL,'CALL0321 cross tenant','offered','encrypted:qa-offer','offer',
      now()+interval '5 minutes',NULL,NULL,NULL
    );
    IF NOT EXISTS (
      SELECT 1 FROM public.whatsapp_call_sessions
      WHERE phone_number_id=v_phone_number_id AND call_id=v_call_cross_tenant
        AND contact_id IS NULL AND conversation_id IS NULL
        AND association_error_code='contact_not_found'
    ) THEN
      RAISE EXCEPTION 'CALL0321_CROSS_TENANT_CONTACT_WAS_LINKED';
    END IF;

    -- A unique contact with only a closed conversation links to the contact,
    -- but never routes an incoming call into a closed thread.
    PERFORM public.whatsapp_call_event_apply(
      v_account_a,v_phone_number_id,v_call_closed,repeat('0',64),
      'connect',1795120106,'USER_INITIATED','51980000003','51980000003',
      NULL,NULL,'CALL0321 closed','offered','encrypted:qa-offer','offer',
      now()+interval '5 minutes',NULL,NULL,NULL
    );
    IF NOT EXISTS (
      SELECT 1 FROM public.whatsapp_call_sessions
      WHERE phone_number_id=v_phone_number_id AND call_id=v_call_closed
        AND contact_id=v_contact_closed AND conversation_id IS NULL
        AND association_error_code='conversation_not_found'
    ) THEN
      RAISE EXCEPTION 'CALL0321_CLOSED_CONVERSATION_WAS_LINKED';
    END IF;

    -- A duplicate event is idempotent; a later terminate event must preserve
    -- the original contact/conversation association.
    v_duplicate_result := public.whatsapp_call_event_apply(
      v_account_a,v_phone_number_id,v_call_phone,repeat('a',64),
      'connect',1795120100,'USER_INITIATED','51980942247','51980942247',
      NULL,NULL,'CALL0321 phone match','offered','encrypted:qa-offer','offer',
      now()+interval '5 minutes',NULL,NULL,NULL
    );
    IF v_duplicate_result IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'CALL0321_DUPLICATE_EVENT_NOT_IGNORED';
    END IF;

    PERFORM public.whatsapp_call_event_apply(
      v_account_a,v_phone_number_id,v_call_phone,repeat('1',64),
      'terminate',1795120107,'USER_INITIATED','51980942247','51980942247',
      NULL,NULL,'CALL0321 phone match','terminated',NULL,NULL,NULL,
      NULL,now(),NULL
    );
    IF NOT EXISTS (
      SELECT 1 FROM public.whatsapp_call_sessions
      WHERE phone_number_id=v_phone_number_id AND call_id=v_call_phone
        AND contact_id=v_contact_phone
        AND conversation_id=v_conversation_phone
        AND state='terminated'
    ) THEN
      RAISE EXCEPTION 'CALL0321_TERMINATE_DROPPED_ASSOCIATION';
    END IF;

    -- An unanswered inbound offer whose SDP expired becomes terminal and
    -- cannot be claimed. A fresh offer remains actionable.
    PERFORM public.whatsapp_call_event_apply(
      v_account_a,v_phone_number_id,v_call_expired,repeat('2',64),
      'connect',1795120108,'USER_INITIATED','51980942247','51980942247',
      NULL,NULL,'CALL0321 expired','offered','encrypted:expired-offer','offer',
      now()+interval '5 minutes',NULL,NULL,NULL
    );
    IF public.whatsapp_call_claim(v_account_a,v_phone_number_id,v_call_expired,v_user_a) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'CALL0321_EXPIRED_FIXTURE_CLAIM_FAILED';
    END IF;

    UPDATE public.whatsapp_call_sessions
    SET session_sdp_expires_at=now()-interval '1 second',
        claim_expires_at=now()-interval '1 second'
    WHERE phone_number_id=v_phone_number_id AND call_id=v_call_expired;
    IF public.whatsapp_call_claim(v_account_a,v_phone_number_id,v_call_expired,v_user_c) IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'CALL0321_EXPIRED_OFFER_WAS_RECLAIMED_BEFORE_PRUNE';
    END IF;

    PERFORM public.whatsapp_call_event_apply(
      v_account_a,v_phone_number_id,v_call_fresh,repeat('3',64),
      'connect',1795120109,'USER_INITIATED','51980942247','51980942247',
      NULL,NULL,'CALL0321 fresh','offered','encrypted:fresh-offer','offer',
      now()+interval '5 minutes',NULL,NULL,NULL
    );

    -- Historical offer with no SDP and no expiry timestamp is stale after five minutes.
    PERFORM public.whatsapp_call_event_apply(
      v_account_a,v_phone_number_id,v_call_missing_sdp_stale,repeat('5',64),
      'connect',1795120111,'USER_INITIATED','51980942247','51980942247',
      NULL,NULL,'CALL0321 stale no SDP','offered',NULL,NULL,NULL,NULL,NULL,NULL
    );
    UPDATE public.whatsapp_call_sessions
    SET created_at=now()-interval '6 minutes',
        updated_at=now()-interval '6 minutes'
    WHERE phone_number_id=v_phone_number_id AND call_id=v_call_missing_sdp_stale;

    IF public.whatsapp_call_claim(v_account_a,v_phone_number_id,v_call_missing_sdp_stale,v_user_a) IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'CALL0321_STALE_NO_SDP_WAS_CLAIMABLE';
    END IF;

    -- A recent offer with missing SDP is not aged out prematurely.
    PERFORM public.whatsapp_call_event_apply(
      v_account_a,v_phone_number_id,v_call_missing_sdp_fresh,repeat('6',64),
      'connect',1795120112,'USER_INITIATED','51980942247','51980942247',
      NULL,NULL,'CALL0321 fresh no SDP','offered',NULL,NULL,NULL,NULL,NULL,NULL
    );

    -- An agent-accepted call may still await Meta's ACCEPTED status webhook.
    -- Expiry cleanup must not mark it terminal or make it claimable by agent B.
    IF public.whatsapp_call_claim(v_account_a,v_phone_number_id,v_call_missing_sdp_fresh,v_user_a) IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'CALL0321_FRESH_NO_SDP_WAS_CLAIMABLE';
    END IF;

    PERFORM public.whatsapp_call_event_apply(
      v_account_a,v_phone_number_id,v_call_accepted,repeat('4',64),
      'connect',1795120110,'USER_INITIATED','51980942247','51980942247',
      NULL,NULL,'CALL0321 accepted','offered','encrypted:accepted-offer','offer',
      now()+interval '5 minutes',NULL,NULL,NULL
    );
    IF public.whatsapp_call_claim(v_account_a,v_phone_number_id,v_call_accepted,v_user_a) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'CALL0321_ACCEPTED_FIXTURE_CLAIM_FAILED';
    END IF;
    IF public.whatsapp_call_session_agent_action(
      v_account_a,v_phone_number_id,v_call_accepted,v_user_a,'accepted',v_conversation_phone
    ) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'CALL0321_ACCEPTED_FIXTURE_ATTRIBUTION_FAILED';
    END IF;

    UPDATE public.whatsapp_call_sessions
    SET session_sdp_expires_at=now()-interval '1 second'
    WHERE phone_number_id=v_phone_number_id AND call_id=v_call_accepted;

    v_pruned := public.whatsapp_call_sdp_prune(100);
    IF v_pruned < 1 THEN
      RAISE EXCEPTION 'CALL0321_EXPIRED_OFFER_NOT_PRUNED';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.whatsapp_call_sessions
      WHERE phone_number_id=v_phone_number_id AND call_id=v_call_expired
        AND state='terminated' AND ended_at IS NOT NULL
        AND session_sdp_encrypted IS NULL
        AND claimed_by_user_id IS NULL AND claim_expires_at IS NULL
    ) THEN
      RAISE EXCEPTION 'CALL0321_EXPIRED_OFFER_NOT_TERMINAL';
    END IF;
    IF public.whatsapp_call_claim(v_account_a,v_phone_number_id,v_call_expired,v_user_a) IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'CALL0321_EXPIRED_OFFER_RECLAIMED';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.whatsapp_call_sessions
      WHERE phone_number_id=v_phone_number_id AND call_id=v_call_fresh
        AND state='offered' AND session_sdp_encrypted IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'CALL0321_FRESH_OFFER_WAS_EXPIRED';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.whatsapp_call_sessions
      WHERE phone_number_id=v_phone_number_id AND call_id=v_call_missing_sdp_stale
        AND state='terminated' AND ended_at IS NOT NULL
        AND session_sdp_encrypted IS NULL
        AND claimed_by_user_id IS NULL AND claim_expires_at IS NULL
    ) THEN
      RAISE EXCEPTION 'CALL0321_STALE_NO_SDP_OFFER_NOT_TERMINATED';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.whatsapp_call_sessions
      WHERE phone_number_id=v_phone_number_id AND call_id=v_call_missing_sdp_fresh
        AND state='offered' AND ended_at IS NULL
        AND session_sdp_encrypted IS NULL
    ) THEN
      RAISE EXCEPTION 'CALL0321_FRESH_NO_SDP_OFFER_PREMATURELY_TERMINATED';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.whatsapp_call_sessions
      WHERE phone_number_id=v_phone_number_id AND call_id=v_call_accepted
        AND state='offered' AND accepted_by_user_id=v_user_a
        AND session_sdp_encrypted IS NULL
    ) THEN
      RAISE EXCEPTION 'CALL0321_ACCEPTED_CALL_WAS_PREMATURELY_TERMINATED';
    END IF;
    IF public.whatsapp_call_claim(v_account_a,v_phone_number_id,v_call_accepted,v_user_c) IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'CALL0321_ACCEPTED_CALL_RECLAIMED';
    END IF;

    RAISE EXCEPTION '__CALL0321_QA_ROLLBACK__';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='__CALL0321_QA_ROLLBACK__' THEN
      RAISE NOTICE 'CALL03B2_1_SQL_QA=PASS; synthetic fixtures rolled back';
    ELSE
      RAISE;
    END IF;
  END;
END
$qa$;
