-- ============================================================
-- 20261205000000_operational_role_assign_without_flag
--
-- Follow-up of 20261204000000_operational_role_supervisor_delegation (that file is NOT edited). Replaces ONLY the body of
-- public.set_member_operational_role(UUID, operational_role_enum): the account-level gate 'operational_roles_disabled'
-- (order_integration_settings.logistics_mvp_enabled) is REMOVED, so an owner/admin can assign each member's operational area (Settings ->
-- Team members) BEFORE the logistics flag is activated. Everything else is byte-identical: signature, SECURITY DEFINER, search_path, owner, grants,
-- same-account check, authority matrix (owner/admin any area; operational supervisor limited; everyone else rejected), ordered row locks,
-- only profiles.operational_role is written (account_role / account_id never).
--
-- Why this is inert: every consumer of profiles.operational_role is gated by logistics_mvp_enabled itself (conversation_operational_access,
-- order_logistics_access, order_payments_access, shipment alerts, routing RPCs). Storing an area while the flag is OFF changes no visibility,
-- no policy outcome and no routing. This migration never activates any account and touches no table, column, enum, trigger, policy or data.
-- ============================================================

CREATE OR REPLACE FUNCTION public.set_member_operational_role(
  p_user_id UUID,
  p_operational_role public.operational_role_enum
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_caller_op public.operational_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
  v_target_op public.operational_role_enum;
  v_is_admin BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  -- Lock both profile rows (caller and target) in a deterministic order, then read the facts under the lock.
  PERFORM 1 FROM profiles WHERE user_id IN (v_caller_id, p_user_id) ORDER BY user_id FOR UPDATE;

  SELECT account_id, account_role, operational_role
    INTO v_caller_account_id, v_caller_role, v_caller_op
    FROM profiles WHERE user_id = v_caller_id;
  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role, operational_role
    INTO v_target_account_id, v_target_role, v_target_op
    FROM profiles WHERE user_id = p_user_id;
  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;
  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account' USING ERRCODE = '42501';
  END IF;

  v_is_admin := v_caller_role IN ('owner', 'admin');

  IF NOT v_is_admin THEN
    -- Not owner/admin: only an operational supervisor may continue, and with limited powers.
    IF v_caller_op IS DISTINCT FROM 'supervisor' THEN
      RAISE EXCEPTION 'This action requires the admin role or higher, or the operational supervisor area' USING ERRCODE = '42501';
    END IF;
    IF v_target_role IN ('owner', 'admin') THEN
      RAISE EXCEPTION 'Only an owner or admin can change the operational area of an owner or admin' USING ERRCODE = '42501';
    END IF;
    IF p_operational_role IS NOT DISTINCT FROM 'supervisor' THEN
      RAISE EXCEPTION 'Only an owner or admin can assign the supervisor area' USING ERRCODE = '42501';
    END IF;
    IF v_target_op IS NOT DISTINCT FROM 'supervisor' THEN
      RAISE EXCEPTION 'Only an owner or admin can change a supervisor' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Only operational_role is ever written: account_role / account_id are never touched here.
  IF v_target_op IS DISTINCT FROM p_operational_role THEN
    UPDATE profiles SET operational_role = p_operational_role
      WHERE user_id = p_user_id AND account_id = v_caller_account_id;
  END IF;
END;
$$;

ALTER FUNCTION public.set_member_operational_role(UUID, public.operational_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_operational_role(UUID, public.operational_role_enum) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_operational_role(UUID, public.operational_role_enum) TO authenticated;
