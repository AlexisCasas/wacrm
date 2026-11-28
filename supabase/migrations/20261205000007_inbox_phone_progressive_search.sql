-- Inbox phone search fallback for historical confirmed orders.
-- Purely search/read infrastructure: no order/customer data is modified.
-- The helper normalizes legacy formatting (+51, spaces, dashes, parentheses)
-- and the RPC searches one age window at a time under the caller's RLS.

CREATE OR REPLACE FUNCTION public.order_phone_digits(p_phone TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT regexp_replace(p_phone, '[^0-9]', '', 'g')
$$;

REVOKE ALL ON FUNCTION public.order_phone_digits(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.order_phone_digits(TEXT) TO authenticated, service_role;

CREATE INDEX IF NOT EXISTS order_confirmations_account_phone_digits_confirmed_idx
  ON public.order_confirmations (
    account_id,
    public.order_phone_digits(phone),
    confirmed_at DESC
  )
  WHERE contact_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.search_order_contacts_by_phone_window(
  p_account UUID,
  p_phones TEXT[],
  p_after TIMESTAMPTZ DEFAULT NULL,
  p_before TIMESTAMPTZ DEFAULT NULL,
  p_limit INTEGER DEFAULT 101
)
RETURNS TABLE(contact_id UUID, matched_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT o.contact_id, max(o.confirmed_at) AS matched_at
  FROM public.order_confirmations o
  WHERE o.account_id = p_account
    AND o.contact_id IS NOT NULL
    AND public.order_phone_digits(o.phone) = ANY(p_phones)
    AND (p_after IS NULL OR o.confirmed_at >= p_after)
    AND (p_before IS NULL OR o.confirmed_at < p_before)
  GROUP BY o.contact_id
  ORDER BY max(o.confirmed_at) DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 101)
$$;

REVOKE ALL ON FUNCTION public.search_order_contacts_by_phone_window(UUID, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, INTEGER)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_order_contacts_by_phone_window(UUID, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, INTEGER)
  TO authenticated;


-- contacts.phone_normalized is generated digits-only data and already has
-- idx_contacts_account_phone_normalized. Reuse it directly so the planner can
-- use the existing index under RLS.
CREATE OR REPLACE FUNCTION public.search_contact_ids_by_phone(
  p_account UUID,
  p_phones TEXT[],
  p_limit INTEGER DEFAULT 101
)
RETURNS TABLE(contact_id UUID)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT c.id
  FROM public.contacts c
  WHERE c.account_id = p_account
    AND c.blocked = false
    AND c.phone_normalized = ANY(p_phones)
  ORDER BY c.updated_at DESC, c.id
  LIMIT LEAST(GREATEST(p_limit, 1), 101)
$$;

REVOKE ALL ON FUNCTION public.search_contact_ids_by_phone(UUID, TEXT[], INTEGER)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_contact_ids_by_phone(UUID, TEXT[], INTEGER)
  TO authenticated;
