-- ============================================================
-- 20261127000000_conversation_handoff_rls
--
-- PR-02 follow-up (Comercial -> Logistica handoff). The Inbox reads `conversations` / `messages` / `message_reactions` straight from the browser
-- (PostgREST + Realtime `postgres_changes`), so row-level security is the only place where "who may work this conversation" can be enforced for
-- listing, opening, reading history, receiving realtime events and sending. This migration ADDS an operational-stage condition to those policies.
--
-- The stage is DERIVED, never stored: a conversation is in the LOGISTICS stage iff a row exists in public.order_confirmations with the same
-- conversation_id and account_id (created by create_order_confirmation, so the handoff can only start once the order is persisted); otherwise it
-- is in the COMMERCIAL stage. No column, status or event is added; conversations are not closed, copied or recreated (same conversation_id).
--
-- Rules (only for accounts with order_integration_settings.logistics_mvp_enabled = TRUE; any other account keeps EXACTLY the legacy behaviour):
--   operational_role = supervisor -> both stages        commercial -> commercial stage only (no confirmed order)
--   operational_role = logistics  -> logistics stage only      NULL -> no operational access (owner/admin included)
--   not a member of the conversation's account -> never.
-- The caller comes from auth.uid(); nothing the browser sends is an authority. service_role (webhook, crons, flows) bypasses RLS and is untouched.
--
-- Contents: 1) partial index (account_id, conversation_id) on order_confirmations (the policy asks "does this conversation have an order?" for
-- every visible row: local EXPLAIN, 5000 conversations / 20000 orders, per-row check 13.8 s -> 0.1 s); 2) helper
-- public.conversation_operational_access(account, conversation); 3) ALTER POLICY (expressions only) on conversations SELECT/UPDATE/DELETE,
-- messages SELECT/ALL and message_reactions SELECT/ALL. Policies are altered, never dropped; INSERT on conversations is unchanged.
-- No data is created, changed or deleted. Rollback (authorization only) is documented in docs/operations/CONVERSATION-HANDOFF-RLS.md.
-- Deploy order: after 20261126000000, BEFORE the application image that relies on it (the old app keeps working: with the flag OFF nothing changes).
-- ============================================================

-- 1. Index for the "has this conversation a confirmed order?" lookup.
CREATE INDEX IF NOT EXISTS order_confirmations_account_conversation_idx
  ON public.order_confirmations (account_id, conversation_id)
  WHERE conversation_id IS NOT NULL;

-- 2. Helper. SECURITY DEFINER so it can read the settings / profile / order tables without recursing into their RLS; the owner is postgres and
--    search_path is pinned. It returns only a boolean about the CALLER and never takes an authority from the client.
CREATE OR REPLACE FUNCTION public.conversation_operational_access(
  p_account_id UUID,
  p_conversation_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_enabled BOOLEAN;
  v_member BOOLEAN;
  v_role public.operational_role_enum;
  v_has_order BOOLEAN;
BEGIN
  -- Not signed in: never (the membership check of the policies already denies it; returning FALSE here also hides the account's flag state).
  IF v_uid IS NULL OR p_account_id IS NULL THEN
    RETURN FALSE;
  END IF;

  -- ONE lookup for the account flag and the caller's membership/area in THIS account (the helper runs once per visible row, so it stays cheap).
  SELECT COALESCE(s.logistics_mvp_enabled, FALSE), (p.user_id IS NOT NULL), p.operational_role
    INTO v_enabled, v_member, v_role
    FROM (SELECT 1) one
    LEFT JOIN order_integration_settings s ON s.account_id = p_account_id
    LEFT JOIN profiles p ON p.user_id = v_uid AND p.account_id = p_account_id;

  -- Flag OFF (or no settings row): legacy behaviour. This function adds nothing; membership stays the job of the existing policy terms.
  IF NOT v_enabled THEN
    RETURN TRUE;
  END IF;

  -- Flag ON: the caller must be a member of THIS account (cross-account never) and have an operational area (NULL = no operational access).
  IF NOT v_member OR v_role IS NULL THEN
    RETURN FALSE;
  END IF;

  IF v_role = 'supervisor' THEN
    RETURN TRUE;
  END IF;

  -- Stage, derived from the persisted order (uses order_confirmations_account_conversation_idx).
  v_has_order := p_conversation_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM order_confirmations o WHERE o.account_id = p_account_id AND o.conversation_id = p_conversation_id
  );

  IF v_role = 'commercial' THEN
    RETURN NOT v_has_order;
  END IF;
  IF v_role = 'logistics' THEN
    RETURN v_has_order;
  END IF;
  RETURN FALSE;
END;
$$;

ALTER FUNCTION public.conversation_operational_access(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.conversation_operational_access(UUID, UUID) FROM PUBLIC;
-- anon needs EXECUTE only so that evaluating a policy for a signed-out request yields "no rows" instead of "permission denied"; it always gets FALSE.
GRANT EXECUTE ON FUNCTION public.conversation_operational_access(UUID, UUID) TO anon, authenticated;

-- 3. Policies: the legacy membership term is kept verbatim; the stage term is ANDed.
ALTER POLICY conversations_select ON public.conversations
  USING (is_account_member(account_id) AND public.conversation_operational_access(account_id, id));

ALTER POLICY conversations_update ON public.conversations
  USING (is_account_member(account_id, 'agent'::account_role_enum) AND public.conversation_operational_access(account_id, id));

ALTER POLICY conversations_delete ON public.conversations
  USING (is_account_member(account_id, 'agent'::account_role_enum) AND public.conversation_operational_access(account_id, id));

ALTER POLICY messages_select ON public.messages
  USING (EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND is_account_member(c.account_id)
      AND public.conversation_operational_access(c.account_id, c.id)
  ));

ALTER POLICY messages_modify ON public.messages
  USING (EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND is_account_member(c.account_id, 'agent'::account_role_enum)
      AND public.conversation_operational_access(c.account_id, c.id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND is_account_member(c.account_id, 'agent'::account_role_enum)
      AND public.conversation_operational_access(c.account_id, c.id)
  ));

ALTER POLICY message_reactions_select ON public.message_reactions
  USING (EXISTS (
    SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND is_account_member(c.account_id)
      AND public.conversation_operational_access(c.account_id, c.id)
  ));

ALTER POLICY message_reactions_modify ON public.message_reactions
  USING (EXISTS (
    SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND is_account_member(c.account_id, 'agent'::account_role_enum)
      AND public.conversation_operational_access(c.account_id, c.id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND is_account_member(c.account_id, 'agent'::account_role_enum)
      AND public.conversation_operational_access(c.account_id, c.id)
  ));
