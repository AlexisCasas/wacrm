-- Preserve the human attribution when an auth user/profile is later removed.
-- The first authorship migration intentionally permits a NULL sender_id while
-- old application instances are still live.  This follow-up makes supplied
-- identities immutable and fills an authoritative display snapshot for every
-- authenticated, attributed manual send.
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS sender_name_snapshot text,
  ADD COLUMN IF NOT EXISTS sender_avatar_url_snapshot text;

CREATE OR REPLACE FUNCTION public.enforce_message_sender_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  author_name text;
  author_avatar_url text;
BEGIN
  -- An attributed row is append-only.  The sole exception is the FK's
  -- ON DELETE SET NULL action, performed without an end-user JWT when an
  -- auth account is deleted; its display snapshots deliberately remain.
  IF TG_OP = 'UPDATE'
     AND (
       NEW.sender_name_snapshot IS DISTINCT FROM OLD.sender_name_snapshot
       OR NEW.sender_avatar_url_snapshot IS DISTINCT FROM OLD.sender_avatar_url_snapshot
       OR (
         NEW.sender_id IS DISTINCT FROM OLD.sender_id
         AND NOT (
           OLD.sender_id IS NOT NULL
           AND NEW.sender_id IS NULL
           AND auth.uid() IS NULL
         )
       )
     ) THEN
    RAISE EXCEPTION 'message sender attribution is immutable';
  END IF;

  -- Old application instances write NULL and remain compatible during a
  -- rolling deploy.  Whenever a client does supply an agent sender_id, it
  -- must be its own authenticated identity and belong to this conversation's
  -- account.  The snapshot comes from profiles, never from client input.
  IF TG_OP = 'INSERT'
     AND auth.uid() IS NOT NULL
     AND NEW.sender_type = 'agent'
     AND NEW.sender_id IS NOT NULL THEN
    IF NEW.sender_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'agent messages must be attributed to the authenticated user';
    END IF;

    SELECT p.full_name, p.avatar_url
      INTO author_name, author_avatar_url
      FROM public.profiles AS p
      JOIN public.conversations AS c ON c.id = NEW.conversation_id
     WHERE p.user_id = auth.uid()
       AND p.account_id = c.account_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'message author must belong to the conversation account';
    END IF;

    NEW.sender_name_snapshot := COALESCE(NULLIF(author_name, ''), 'Asesor no identificado');
    NEW.sender_avatar_url_snapshot := author_avatar_url;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_message_sender_identity ON public.messages;
CREATE TRIGGER enforce_message_sender_identity
  BEFORE INSERT OR UPDATE OF sender_type, sender_id, sender_name_snapshot, sender_avatar_url_snapshot
  ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.enforce_message_sender_identity();
