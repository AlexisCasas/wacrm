-- ============================================================
-- 20261111000000_whatsapp_message_pricing
--
-- "Ventana gratuita de Meta" (free entry point, Click-to-WhatsApp ads): Meta says in its STATUS webhooks whether a message was free because it was sent
-- inside an open FEP window (`statuses[].pricing.type = "free_entry_point"`) and, when it does, when that conversation expires
-- (`statuses[].conversation.expiration_timestamp`, a unix-seconds string). The application used to discard both. This stores ONLY that evidence; the
-- window length is never assumed anywhere: the end is whatever Meta sent.
--
-- PURELY ADDITIVE: one new table + one new function. No existing table, column, policy, function or row changes, so the previous application image
-- keeps working (image-only rollback; the table is then simply unused). No backfill: the past pricing was never kept and cannot be recovered.
--
--   * whatsapp_message_pricing : one row per OUTBOUND message that carried FEP evidence, PRIMARY KEY (account_id, wamid) -> replays and the
--     sent / delivered / read events of one message are the same row. Composite FK (contact_id, account_id) keeps it inside its account; deleting
--     the contact deletes it.
--   * record_whatsapp_message_pricing(account, wamid, type, category, expiration): finds the message through ITS ACCOUNT's conversations (a wamid is
--     not unique across accounts), then upserts with COALESCE: a later event WITHOUT a value never erases an earlier valid one. Returns false (and
--     writes nothing) when the message is unknown to that account.
--   * Privileges: service_role writes; members of the account (agent+) read, through RLS.
--
-- Rollback (nothing depends on it once the app image is rolled back; do not run it without a separate decision):
--   DROP FUNCTION IF EXISTS public.record_whatsapp_message_pricing(uuid, text, text, text, timestamptz);
--   DROP TABLE IF EXISTS public.whatsapp_message_pricing;
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE public.whatsapp_message_pricing (
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  wamid TEXT NOT NULL,
  contact_id UUID NOT NULL,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  pricing_type TEXT,
  pricing_category TEXT,
  expiration_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, wamid),
  CONSTRAINT whatsapp_message_pricing_contact_fk
    FOREIGN KEY (contact_id, account_id) REFERENCES public.contacts (id, account_id) ON DELETE CASCADE,
  CONSTRAINT whatsapp_message_pricing_evidence CHECK (pricing_type IS NOT NULL OR expiration_at IS NOT NULL)
);

CREATE INDEX idx_whatsapp_message_pricing_contact ON public.whatsapp_message_pricing (contact_id, pricing_type, expiration_at DESC);

ALTER TABLE public.whatsapp_message_pricing ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.whatsapp_message_pricing FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.whatsapp_message_pricing TO authenticated;
GRANT ALL ON TABLE public.whatsapp_message_pricing TO service_role;
CREATE POLICY whatsapp_message_pricing_select ON public.whatsapp_message_pricing
  FOR SELECT USING (public.is_account_member(account_id, 'agent'));

CREATE OR REPLACE FUNCTION public.record_whatsapp_message_pricing(
  p_account_id uuid,
  p_wamid      text,
  p_type       text,
  p_category   text,
  p_expiration timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_conversation uuid;
  v_contact      uuid;
BEGIN
  IF p_account_id IS NULL OR p_wamid IS NULL OR btrim(p_wamid) = '' THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = '22023';
  END IF;
  IF p_type IS NULL AND p_expiration IS NULL THEN
    RETURN false;
  END IF;

  -- The message, through the conversations of THIS account only; outbound rows only (a status is never about a customer's message).
  SELECT m.conversation_id, cv.contact_id
    INTO v_conversation, v_contact
    FROM public.messages m
    JOIN public.conversations cv ON cv.id = m.conversation_id
   WHERE m.message_id = p_wamid
     AND cv.account_id = p_account_id
     AND m.sender_type <> 'customer'
   ORDER BY m.id
   LIMIT 1;
  IF v_conversation IS NULL OR v_contact IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO public.whatsapp_message_pricing AS t
         (account_id, wamid, contact_id, conversation_id, pricing_type, pricing_category, expiration_at)
  VALUES (p_account_id, p_wamid, v_contact, v_conversation, p_type, p_category, p_expiration)
  ON CONFLICT (account_id, wamid) DO UPDATE
     SET pricing_type     = COALESCE(EXCLUDED.pricing_type, t.pricing_type),
         pricing_category = COALESCE(EXCLUDED.pricing_category, t.pricing_category),
         expiration_at    = COALESCE(EXCLUDED.expiration_at, t.expiration_at),
         updated_at       = now()
   WHERE (t.pricing_type, t.pricing_category, t.expiration_at)
         IS DISTINCT FROM (COALESCE(EXCLUDED.pricing_type, t.pricing_type), COALESCE(EXCLUDED.pricing_category, t.pricing_category),
                           COALESCE(EXCLUDED.expiration_at, t.expiration_at));
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.record_whatsapp_message_pricing(uuid, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_whatsapp_message_pricing(uuid, text, text, text, timestamptz) TO service_role;

COMMIT;
