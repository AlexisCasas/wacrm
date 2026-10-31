-- ============================================================
-- 20261102000000_order_sellers_from_members
--
-- The commercial seller of an order is now a real MEMBER of the account, resolved straight from `profiles` (no second catalogue to keep in sync):
--   * eligible = every profile whose account_id is the account (the owner, admins, agents and viewers). A pending invitation has no profile, an
--     accepted one creates it (redeem_invitation), a removed member's profile moves to a personal account (remove_account_member): the roster is
--     always exactly the current members, with the stable identity auth.users.id. A rename shows up in the selector immediately.
--   * orders keep the seller's identity in `seller_user_id` (FK auth.users, ON DELETE SET NULL) and the name AS IT WAS in `seller_name`
--     (frozen snapshot). A later rename, removal or deletion never changes a past order.
--   * order_sellers / order_confirmations.seller_id (migration 20261101000000) stay in place, unused by new orders, so no historical data is
--     dropped. They can be removed in a later cleanup migration once confirmed empty.
--   * `order_seller_candidates` is the ONE place that defines who can be a seller: functional profiles (Comercial, ...) will change only it.
--   * The "Confirmar pedido" feature gets its own per-account switch, `order_integration_settings.confirm_enabled` (OFF by default), separate from
--     `enabled` (delivery to InkaClick). Without it the endpoint refuses and the button is hidden, whatever the roster looks like.
--   * Confirming still needs the agent role: a viewer can be CHOSEN as seller but cannot confirm (checked in the function as well as the API).
--
-- Compatible with a fresh database and with one that already holds orders from 20261101000000. Production has not applied either yet.
-- ============================================================

ALTER TABLE public.order_integration_settings ADD COLUMN IF NOT EXISTS confirm_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.order_confirmations ADD COLUMN IF NOT EXISTS seller_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS order_confirmations_seller_user_idx ON public.order_confirmations (account_id, seller_user_id) WHERE seller_user_id IS NOT NULL;
COMMENT ON TABLE public.order_sellers IS 'LEGACY (20261101000000): superseded by order_seller_candidates (members). Not used by new orders; kept for history.';
COMMENT ON COLUMN public.order_confirmations.seller_id IS 'LEGACY: use seller_user_id. Kept for history.';

-- Display name of a member: the profile's full name, or the local part of the e-mail when the name is blank. NULL if neither exists.
CREATE OR REPLACE FUNCTION public.order_seller_display_name(p_full_name TEXT, p_email TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(NULLIF(btrim(p_full_name), ''), NULLIF(split_part(btrim(COALESCE(p_email, '')), '@', 1), ''))
$$;

-- Who can be the commercial seller of an order of this account (today: every current member).
CREATE OR REPLACE FUNCTION public.order_seller_candidates(p_account UUID)
RETURNS TABLE (user_id UUID, name TEXT, account_role public.account_role_enum)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT p.user_id, public.order_seller_display_name(p.full_name, p.email), p.account_role
    FROM profiles p
   WHERE p.account_id = p_account AND public.order_seller_display_name(p.full_name, p.email) IS NOT NULL
   ORDER BY 2, 1
$$;

-- Frozen fields (replaces the function of 20261101000000; the trigger is unchanged): adds the seller member reference.
CREATE OR REPLACE FUNCTION public.order_confirmations_freeze()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = NEW.contact_id AND c.account_id = NEW.account_id) THEN
      RAISE EXCEPTION 'reference from another account (contact)';
    END IF;
    IF NEW.conversation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM conversations v WHERE v.id = NEW.conversation_id AND v.account_id = NEW.account_id) THEN
      RAISE EXCEPTION 'reference from another account (conversation)';
    END IF;
    IF NEW.deal_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.id = NEW.deal_id AND d.account_id = NEW.account_id) THEN
      RAISE EXCEPTION 'reference from another account (deal)';
    END IF;
    IF NEW.seller_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM order_sellers s WHERE s.id = NEW.seller_id AND s.account_id = NEW.account_id) THEN
        RAISE EXCEPTION 'reference from another account (seller)';
      END IF;
      IF NEW.seller_name IS DISTINCT FROM (SELECT s.name FROM order_sellers s WHERE s.id = NEW.seller_id) THEN
        RAISE EXCEPTION 'seller name differs from the referenced seller';
      END IF;
    END IF;
    IF NEW.seller_user_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM order_seller_candidates(NEW.account_id) c WHERE c.user_id = NEW.seller_user_id) THEN
        RAISE EXCEPTION 'reference from another account (seller member)';
      END IF;
      IF NEW.seller_name IS DISTINCT FROM (SELECT c.name FROM order_seller_candidates(NEW.account_id) c WHERE c.user_id = NEW.seller_user_id) THEN
        RAISE EXCEPTION 'seller name differs from the member name';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
     OR NEW.customer_name IS DISTINCT FROM OLD.customer_name
     OR NEW.dni IS DISTINCT FROM OLD.dni
     OR NEW.phone IS DISTINCT FROM OLD.phone
     OR NEW.product IS DISTINCT FROM OLD.product
     OR NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.price IS DISTINCT FROM OLD.price
     OR NEW.order_description IS DISTINCT FROM OLD.order_description
     OR NEW.agency IS DISTINCT FROM OLD.agency
     OR NEW.destination IS DISTINCT FROM OLD.destination
     OR NEW.seller_name IS DISTINCT FROM OLD.seller_name
     OR NEW.order_status IS DISTINCT FROM OLD.order_status
     OR NEW.department IS DISTINCT FROM OLD.department
     OR NEW.confirmed_by_name IS DISTINCT FROM OLD.confirmed_by_name
     OR NEW.request_key IS DISTINCT FROM OLD.request_key
     -- References: only value -> NULL.
     OR (NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by AND NEW.confirmed_by IS NOT NULL)
     OR (NEW.contact_id IS DISTINCT FROM OLD.contact_id AND NEW.contact_id IS NOT NULL)
     OR (NEW.conversation_id IS DISTINCT FROM OLD.conversation_id AND NEW.conversation_id IS NOT NULL)
     OR (NEW.seller_id IS DISTINCT FROM OLD.seller_id AND NEW.seller_id IS NOT NULL)
     OR (NEW.seller_user_id IS DISTINCT FROM OLD.seller_user_id AND NEW.seller_user_id IS NOT NULL)
     OR (NEW.deal_id IS DISTINCT FROM OLD.deal_id AND NEW.deal_id IS NOT NULL)
  THEN
    RAISE EXCEPTION 'a confirmed order is immutable';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

-- Idempotent create. Same signature as 20261101000000, but `p_seller` is now the seller's USER ID (a current member of p_account) and the function
-- also enforces the feature switch and the confirmer's role. SQLSTATE 42501 = not allowed (feature off / role); bad references raise a plain exception (the API maps them by message).
CREATE OR REPLACE FUNCTION public.create_order_confirmation(
  p_account UUID, p_contact UUID, p_conversation UUID, p_actor UUID, p_actor_name TEXT, p_request_key TEXT, p_seller UUID, p_fields JSONB
) RETURNS TABLE (order_id UUID, created BOOLEAN)
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_id UUID;
  v_enabled BOOLEAN;
  v_feature BOOLEAN;
  v_seller_name TEXT;
BEGIN
  SELECT COALESCE(s.confirm_enabled, FALSE), COALESCE(s.enabled, FALSE) INTO v_feature, v_enabled
    FROM (SELECT 1) one LEFT JOIN order_integration_settings s ON s.account_id = p_account;
  IF NOT v_feature THEN
    RAISE EXCEPTION 'feature_disabled' USING ERRCODE = '42501';
  END IF;
  IF p_request_key IS NULL OR btrim(p_request_key) = '' OR char_length(p_request_key) > 100 THEN
    RAISE EXCEPTION 'invalid request key';
  END IF;
  -- Viewers are read-only: they may be chosen as seller, never confirm.
  IF NOT EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = p_actor AND p.account_id = p_account AND p.account_role IN ('owner', 'admin', 'agent')) THEN
    RAISE EXCEPTION 'actor_not_allowed' USING ERRCODE = '42501';
  END IF;
  IF p_contact IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = p_contact AND c.account_id = p_account) THEN
    RAISE EXCEPTION 'contact does not belong to the account';
  END IF;
  IF p_conversation IS NOT NULL AND NOT EXISTS (SELECT 1 FROM conversations v WHERE v.id = p_conversation AND v.account_id = p_account) THEN
    RAISE EXCEPTION 'conversation does not belong to the account';
  END IF;
  SELECT c.name INTO v_seller_name FROM order_seller_candidates(p_account) c WHERE c.user_id = p_seller;
  IF v_seller_name IS NULL THEN
    RAISE EXCEPTION 'seller is not a member of the account';
  END IF;

  INSERT INTO order_confirmations AS o (
    account_id, contact_id, conversation_id, confirmed_by, confirmed_by_name, request_key, seller_user_id, seller_name,
    customer_name, dni, phone, product, quantity, price, order_description, agency, destination, department, delivery_status
  ) VALUES (
    p_account, p_contact, p_conversation, p_actor, p_actor_name, p_request_key, p_seller, v_seller_name,
    p_fields->>'customer_name', NULLIF(btrim(p_fields->>'dni'), ''), p_fields->>'phone', p_fields->>'product',
    (p_fields->>'quantity')::INTEGER, (p_fields->>'price')::NUMERIC(12,2), NULLIF(btrim(p_fields->>'order_description'), ''),
    COALESCE(NULLIF(btrim(p_fields->>'agency'), ''), 'Shalom'), p_fields->>'destination', NULLIF(btrim(p_fields->>'department'), ''),
    CASE WHEN v_enabled THEN 'pending' ELSE 'held' END
  )
  ON CONFLICT (account_id, request_key) DO NOTHING
  RETURNING o.id INTO v_id;

  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, TRUE;
  ELSE
    RETURN QUERY SELECT o.id, FALSE FROM order_confirmations o WHERE o.account_id = p_account AND o.request_key = p_request_key;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.order_seller_candidates(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_seller_candidates(UUID) TO service_role;
REVOKE ALL ON FUNCTION public.create_order_confirmation(UUID, UUID, UUID, UUID, TEXT, TEXT, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_order_confirmation(UUID, UUID, UUID, UUID, TEXT, TEXT, UUID, JSONB) TO service_role;
