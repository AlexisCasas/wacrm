-- Sender type determines whether Inbox presents a message as a human, bot or
-- automation.  It is part of the immutable authorship record and must not be
-- changed after insert, otherwise a human author can be visually concealed.
CREATE OR REPLACE FUNCTION public.enforce_message_sender_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  author_name text;
  author_avatar_url text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (
       NEW.sender_type IS DISTINCT FROM OLD.sender_type
       OR NEW.sender_name_snapshot IS DISTINCT FROM OLD.sender_name_snapshot
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
