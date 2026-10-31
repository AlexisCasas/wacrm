-- Persist the authenticated human author for new manual Inbox sends.
-- Historical and automated messages deliberately remain NULL.
ALTER TABLE public.messages
  ADD CONSTRAINT messages_sender_id_fkey
  FOREIGN KEY (sender_id) REFERENCES auth.users(id) ON DELETE SET NULL NOT VALID;

-- Direct authenticated writes may only attribute an agent message to
-- the current session. Service-role bot/flow writers have no auth.uid().
CREATE OR REPLACE FUNCTION public.enforce_message_sender_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- NULL remains valid during the rollout: the application version that
  -- precedes this migration does not yet write sender_id.  A non-NULL value
  -- is nevertheless always bound to the authenticated session.
  IF TG_OP = 'INSERT'
     AND auth.uid() IS NOT NULL
     AND NEW.sender_type = 'agent'
     AND NEW.sender_id IS NOT NULL
     AND NEW.sender_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'agent messages must be attributed to the authenticated user';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_message_sender_identity ON public.messages;
CREATE TRIGGER enforce_message_sender_identity
  BEFORE INSERT OR UPDATE OF sender_type, sender_id ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.enforce_message_sender_identity();
