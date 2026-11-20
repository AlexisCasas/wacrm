-- Prevent an already accepted incoming call from being claimed by a second agent
-- after the original 90-second lease expires. The accepting agent remains the
-- recorded owner; terminal actions are authorized by accepted_by_user_id.
CREATE OR REPLACE FUNCTION public.whatsapp_call_claim(
  p_account_id uuid,
  p_phone_number_id text,
  p_call_id text,
  p_actor_user_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=public
AS $claim$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE account_id=p_account_id
      AND user_id=p_actor_user_id
      AND account_role IN ('owner','admin','agent')
  ) THEN
    RAISE EXCEPTION 'call_claim_actor_forbidden' USING ERRCODE='42501';
  END IF;

  UPDATE public.whatsapp_call_sessions
  SET claimed_by_user_id=p_actor_user_id,
      last_claimed_by_user_id=p_actor_user_id,
      claimed_at=now(),
      claim_expires_at=now()+interval '90 seconds',
      updated_at=now()
  WHERE account_id=p_account_id
    AND phone_number_id=p_phone_number_id
    AND call_id=p_call_id
    AND direction='USER_INITIATED'
    AND state IN ('offered','ringing','connected')
    AND accepted_by_user_id IS NULL
    AND rejected_by_user_id IS NULL
    AND ended_by_user_id IS NULL
    AND (
      claimed_by_user_id IS NULL
      OR claim_expires_at <= now()
      OR claimed_by_user_id=p_actor_user_id
    );

  RETURN FOUND;
END;
$claim$;
