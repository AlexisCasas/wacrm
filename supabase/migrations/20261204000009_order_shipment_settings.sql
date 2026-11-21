-- ============================================================
-- 20261130000000_order_shipment_settings
--
-- PR-05 (Shalom tracking) · per-account switch + access helpers. PURELY ADDITIVE: one new table and a few new functions. Nothing of PR-01..PR-04 is
-- altered (order_integration_settings, order_logistics_* and their functions are only READ).
--
--   shalom_tracking_enabled   default FALSE. PR-05 needs it AND order_integration_settings.logistics_mvp_enabled (PR-01). An absent row = OFF.
--   credentials_paused_until  GLOBAL credentials circuit breaker, mirrored on every row (a 401/403 / "auth failed" answer is not an order problem): while it is
--                             in the future no Shalom query is claimed. It never touches Inbox / Pedidos Confirmados / PR-04.
--
-- NO Shalom credential is stored anywhere in the database (they live server-side, in the environment, when a real provider is authorized).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.order_shipment_settings (
  account_id UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  shalom_tracking_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  credentials_paused_until TIMESTAMPTZ,
  credentials_paused_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  CONSTRAINT order_shipment_settings_reason_form CHECK (credentials_paused_reason IS NULL OR credentials_paused_reason ~ '^[a-z0-9_]{1,40}$')
);
COMMENT ON TABLE public.order_shipment_settings IS
  'PR-05 per-account configuration. Absent row = Shalom tracking OFF. Holds NO credential.';

-- Same helper RLS uses in PR-04 (flag + logistics/supervisor + agent+), plus the PR-05 flag.
CREATE OR REPLACE FUNCTION public.order_shipments_access(p_account_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.order_logistics_access(p_account_id)
     AND COALESCE((SELECT s.shalom_tracking_enabled FROM public.order_shipment_settings s WHERE s.account_id = p_account_id), FALSE)
$$;
ALTER FUNCTION public.order_shipments_access(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_shipments_access(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.order_shipments_access(UUID) TO authenticated, service_role;

ALTER TABLE public.order_shipment_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_shipment_settings FROM anon, authenticated;
GRANT SELECT ON public.order_shipment_settings TO authenticated;
DROP POLICY IF EXISTS order_shipment_settings_select ON public.order_shipment_settings;
CREATE POLICY order_shipment_settings_select ON public.order_shipment_settings
  FOR SELECT USING (public.order_shipments_access(account_id));

-- Validates (account, actor) for a PR-05 RPC and returns the actor's display name. The backend derives both from the SESSION.
--   p_supervisor_only: the action is reserved to the supervisor area (stop tracking). owner/admin who are also supervisor act as supervisor.
-- Re-validates inside the database: PR-04's actor check (profile of that account, logistics_mvp_enabled, logistics|supervisor area, agent+ role; viewers
-- and the PR-03 `shared` routing grant nothing) AND shalom_tracking_enabled.
CREATE OR REPLACE FUNCTION public.order_shipments_actor(p_account UUID, p_actor UUID, p_supervisor_only BOOLEAN DEFAULT FALSE)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := public.order_logistics_actor(p_account, p_actor);
  v_role public.operational_role_enum;
BEGIN
  IF NOT COALESCE((SELECT s.shalom_tracking_enabled FROM public.order_shipment_settings s WHERE s.account_id = p_account), FALSE) THEN
    RAISE EXCEPTION 'feature_disabled' USING ERRCODE = '42501';
  END IF;
  IF p_supervisor_only THEN
    SELECT p.operational_role INTO v_role FROM public.profiles p WHERE p.user_id = p_actor AND p.account_id = p_account;
    IF v_role IS DISTINCT FROM 'supervisor' THEN
      RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN v_name;
END;
$$;
ALTER FUNCTION public.order_shipments_actor(UUID, UUID, BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_shipments_actor(UUID, UUID, BOOLEAN) FROM PUBLIC, anon, authenticated, service_role;

-- Serializes every PR-05 operation on one order.
CREATE OR REPLACE FUNCTION public.order_shipments_lock(p_order UUID)
RETURNS VOID
LANGUAGE sql
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('order_shipments:' || p_order::text, 0))
$$;
ALTER FUNCTION public.order_shipments_lock(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_shipments_lock(UUID) FROM PUBLIC, anon, authenticated, service_role;
