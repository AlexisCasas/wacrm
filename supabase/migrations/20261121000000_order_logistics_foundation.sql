-- ============================================================
-- 20261121000000_order_logistics_foundation
--
-- PR-01 of Comercial + Logistica: FOUNDATION ONLY. Purely additive and inert until an account's `logistics_mvp_enabled` is set to TRUE by hand
-- (this migration never activates any account: there is no UPDATE/INSERT of that flag anywhere in it).
--
--   1. order_integration_settings.logistics_mvp_enabled BOOLEAN NOT NULL DEFAULT FALSE   (the per-account feature flag)
--   2. operational_role_enum + profiles.operational_role (NULL by default), INDEPENDENT of account_role (RBAC is untouched).
--      * enforce_profile_privilege_columns also protects operational_role from direct browser writes (034 pattern).
--      * set_member_operational_role(p_user_id, p_operational_role): the only supervised writer (owner/admin, same account, flag ON).
--      * a BEFORE UPDATE trigger resets operational_role to NULL whenever profiles.account_id changes, so remove_account_member and
--        redeem_invitation (and any future membership flow) never carry an area into another company. Those RPCs are NOT rewritten.
-- order_confirmations, create_order_confirmation and the InkaClick payload are NOT touched.
-- Deploy order: apply this migration BEFORE the application code.
-- ============================================================

-- 1. Feature flag (OFF for every account).
ALTER TABLE public.order_integration_settings ADD COLUMN IF NOT EXISTS logistics_mvp_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Operational role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'operational_role_enum' AND n.nspname = 'public') THEN
    CREATE TYPE public.operational_role_enum AS ENUM ('commercial', 'logistics', 'supervisor');
  END IF;
END
$$;

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS operational_role public.operational_role_enum NULL;

CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.account_role IS DISTINCT FROM OLD.account_role
      OR NEW.account_id IS DISTINCT FROM OLD.account_id
      OR NEW.operational_role IS DISTINCT FROM OLD.operational_role)
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'account_role, account_id and operational_role cannot be changed directly; use the account member/invitation RPCs'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_profile_privilege_columns() OWNER TO postgres;

-- A profile that moves to another account never keeps its operational area.
CREATE OR REPLACE FUNCTION public.clear_operational_role_on_account_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    NEW.operational_role := NULL;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.clear_operational_role_on_account_change() OWNER TO postgres;

DROP TRIGGER IF EXISTS clear_operational_role_on_account_change ON public.profiles;
CREATE TRIGGER clear_operational_role_on_account_change
  BEFORE UPDATE OF account_id ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.clear_operational_role_on_account_change();

CREATE OR REPLACE FUNCTION public.set_member_operational_role(
  p_user_id UUID,
  p_operational_role public.operational_role_enum
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_enabled BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role INTO v_caller_account_id, v_caller_role FROM profiles WHERE user_id = auth.uid();
  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher' USING ERRCODE = '42501';
  END IF;

  SELECT account_id INTO v_target_account_id FROM profiles WHERE user_id = p_user_id;
  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;
  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(s.logistics_mvp_enabled, FALSE) INTO v_enabled FROM order_integration_settings s WHERE s.account_id = v_caller_account_id;
  IF NOT COALESCE(v_enabled, FALSE) THEN
    RAISE EXCEPTION 'operational_roles_disabled' USING ERRCODE = '42501';
  END IF;

  -- Only operational_role: account_role is never touched here (owner/admin targets are allowed).
  UPDATE profiles SET operational_role = p_operational_role WHERE user_id = p_user_id AND account_id = v_caller_account_id;
END;
$$;

ALTER FUNCTION public.set_member_operational_role(UUID, public.operational_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_operational_role(UUID, public.operational_role_enum) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_operational_role(UUID, public.operational_role_enum) TO authenticated;
