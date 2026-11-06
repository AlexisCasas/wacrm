-- ============================================================
-- 20261108000000_whatsapp_message_status_apply
--
-- PR-A (docs/ops/WHATSAPP-WEBHOOK-RELIABILITY-20261106.md, H2): WhatsApp STATUS webhooks (sent / delivered / read / failed / played) must
--   * touch only rows of the account that owns the business number named in the signed payload (messages.message_id is NOT unique:
--     migration 009; only (conversation_id, message_id) is), and
--   * only ever move a status FORWARD, atomically, so a late or replayed event can neither regress a message nor race another worker.
--
-- ADDITIVE: three new functions, no table, column, index, policy or data is changed. Safe to apply BEFORE the application change (nothing calls
-- the functions yet) and safe to leave in place if the application is rolled back (nothing calls them either).
--
--   public.whatsapp_status_rank(text)                 pending/sending=0 < sent=1 < delivered=2 < read=3 < replied=4 (broadcast recipients only)
--   public.whatsapp_status_can_advance(current, in)   forward-only; `failed` only from pending/sending/sent and TERMINAL afterwards
--   public.apply_whatsapp_message_status(account, wamid, status, event_at)
--        one transaction: (1) the broadcast recipient mirror, (2) the message row(s); returns ONLY the messages that really changed,
--        so the caller notifies external subscribers for effective changes of the right account and nothing else.
--
-- Privileges: EXECUTE for service_role only (REVOKE from PUBLIC / anon / authenticated). The functions are SECURITY INVOKER with a pinned
-- search_path: they grant nothing a caller did not already have, and no table privilege changes.
--
-- Apply by hand, once:  psql -v ON_ERROR_STOP=1 -1 -f 20261108000000_whatsapp_message_status_apply.sql      (idempotent: CREATE OR REPLACE)
-- Rollback (nothing depends on it once the app image is rolled back):
--   DROP FUNCTION IF EXISTS public.apply_whatsapp_message_status(uuid, text, text, timestamptz);
--   DROP FUNCTION IF EXISTS public.whatsapp_status_can_advance(text, text);
--   DROP FUNCTION IF EXISTS public.whatsapp_status_rank(text);
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.whatsapp_status_rank(p_status text)
RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public
AS $$
  SELECT CASE p_status
    WHEN 'pending'   THEN 0
    WHEN 'sending'   THEN 0
    WHEN 'sent'      THEN 1
    WHEN 'delivered' THEN 2
    WHEN 'read'      THEN 3
    WHEN 'replied'   THEN 4
    ELSE NULL
  END
$$;

-- Forward-only on the ladder; `failed` is a terminal side branch that is only valid from the early states (an old `failed` can never override a
-- message Meta already delivered or the customer already read, and nothing can leave `failed`). Unknown current value: accept any ladder move.
CREATE OR REPLACE FUNCTION public.whatsapp_status_can_advance(p_current text, p_incoming text)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public
AS $$
  SELECT COALESCE(
    CASE
      WHEN p_incoming IS NULL THEN false
      WHEN p_incoming = 'failed' THEN p_current IN ('pending', 'sending', 'sent')
      WHEN p_current = 'failed' THEN false
      WHEN public.whatsapp_status_rank(p_incoming) IS NULL THEN false
      WHEN p_current IS NULL OR public.whatsapp_status_rank(p_current) IS NULL THEN true
      ELSE public.whatsapp_status_rank(p_incoming) > public.whatsapp_status_rank(p_current)
    END,
    false)
$$;

CREATE OR REPLACE FUNCTION public.apply_whatsapp_message_status(
  p_account_id uuid,
  p_wamid      text,
  p_status     text,
  p_event_at   timestamptz DEFAULT NULL
) RETURNS TABLE (
  r_message_id      uuid,
  r_conversation_id uuid,
  r_contact_id      uuid,
  r_previous_status text,
  r_new_status      text
)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_new text;
  v_at  timestamptz;
BEGIN
  IF p_account_id IS NULL OR p_wamid IS NULL OR btrim(p_wamid) = '' THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = '22023';
  END IF;
  -- Meta's `played` (a voice note was played) implies delivered + read; messages.status has no `played` value.
  v_new := CASE p_status WHEN 'played' THEN 'read' ELSE p_status END;
  IF v_new IS NULL OR v_new NOT IN ('sent', 'delivered', 'read', 'failed') THEN
    RAISE EXCEPTION 'unsupported_status' USING ERRCODE = '22023';
  END IF;
  v_at := COALESCE(p_event_at, now());

  -- (1) Broadcast recipient mirror. broadcast_recipients.whatsapp_message_id is globally unique, but the row is still reached only through a
  -- broadcast of THIS account. The status predicate is re-evaluated under the row lock, so two workers cannot regress each other.
  UPDATE public.broadcast_recipients br
     SET status       = v_new,
         sent_at      = CASE WHEN v_new = 'sent'      THEN v_at ELSE br.sent_at      END,
         delivered_at = CASE WHEN v_new = 'delivered' THEN v_at ELSE br.delivered_at END,
         read_at      = CASE WHEN v_new = 'read'      THEN v_at ELSE br.read_at      END
    FROM public.broadcasts b
   WHERE br.broadcast_id = b.id
     AND b.account_id = p_account_id
     AND br.whatsapp_message_id = p_wamid
     AND public.whatsapp_status_can_advance(br.status, v_new);

  -- (2) Messages. Scoped to the account through the conversation; OUTBOUND rows only (a status event is never about a customer's message).
  -- Locking in primary-key order keeps concurrent calls deadlock-free; FOR UPDATE re-checks the predicate against the freshest committed
  -- version, so a row another worker already advanced past `v_new` simply drops out and the UPDATE below leaves it alone.
  RETURN QUERY
  WITH target AS (
    SELECT m.id, m.status AS old_status
      FROM public.messages m
      JOIN public.conversations c ON c.id = m.conversation_id
     WHERE m.message_id = p_wamid
       AND c.account_id = p_account_id
       AND m.sender_type <> 'customer'
       AND public.whatsapp_status_can_advance(m.status, v_new)
     ORDER BY m.id
       FOR UPDATE OF m
  ), upd AS (
    UPDATE public.messages m
       SET status = v_new
      FROM target t
     WHERE m.id = t.id
    RETURNING m.id AS mid, m.conversation_id AS cid, t.old_status AS old_s, m.status AS new_s
  )
  SELECT u.mid, u.cid, cv.contact_id, u.old_s, u.new_s
    FROM upd u
    JOIN public.conversations cv ON cv.id = u.cid;
END;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_status_rank(text)                              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.whatsapp_status_can_advance(text, text)                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_whatsapp_message_status(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_status_rank(text)                              TO service_role;
GRANT EXECUTE ON FUNCTION public.whatsapp_status_can_advance(text, text)                  TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_whatsapp_message_status(uuid, text, text, timestamptz) TO service_role;

COMMIT;
