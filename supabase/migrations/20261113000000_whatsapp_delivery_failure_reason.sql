-- P1: additive delivery failure observability. No resend, no changes to
-- existing message delivery status function or Flows. Apply BEFORE the app.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS delivery_error_code integer,
  ADD COLUMN IF NOT EXISTS delivery_error_title text;

COMMENT ON COLUMN public.messages.delivery_error_code IS
  'Meta statuses[].errors[0].code, recorded after a failed status (future events only).';
COMMENT ON COLUMN public.messages.delivery_error_title IS
  'Capped Meta error title only; never error_data.details or free-form error.message.';

CREATE OR REPLACE FUNCTION public.record_whatsapp_delivery_failure(
  p_account_id uuid,
  p_wamid text,
  p_code integer,
  p_title text
) RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_updated integer := 0;
BEGIN
  IF p_account_id IS NULL OR p_wamid IS NULL OR btrim(p_wamid) = ''
     OR p_code IS NULL OR p_code < 1 OR p_code > 999999 THEN
    RETURN 0;
  END IF;

  -- Only already failed outbound messages, scoped by account. Filling a missing
  -- reason is idempotent and cannot change delivery state or other tenants.
  UPDATE public.messages m
     SET delivery_error_code = COALESCE(m.delivery_error_code, p_code),
         delivery_error_title = COALESCE(
           m.delivery_error_title,
           left(nullif(btrim(regexp_replace(regexp_replace(coalesce(p_title, ''), '[[:cntrl:]]', ' ', 'g'), '[0-9]{7,}', '#', 'g')), ''), 160)
         )
    FROM public.conversations c
   WHERE c.id = m.conversation_id
     AND c.account_id = p_account_id
     AND m.message_id = p_wamid
     AND m.sender_type <> 'customer'
     AND m.status = 'failed'
     AND (m.delivery_error_code IS NULL OR m.delivery_error_title IS NULL);

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.record_whatsapp_delivery_failure(uuid, text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_whatsapp_delivery_failure(uuid, text, integer, text) TO service_role;
COMMIT;
