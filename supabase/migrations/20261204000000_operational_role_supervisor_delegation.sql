-- ============================================================
-- 20261126000000_operational_role_supervisor_delegation
--
-- Follow-up of 20261121000000_order_logistics_foundation (that file is NOT edited). Replaces ONLY the body of
-- public.set_member_operational_role(UUID, operational_role_enum) so that an operational SUPERVISOR can also administer areas, in a limited way.
-- No table, column, enum, trigger, policy or data is created, altered or touched. Signature, return type, owner, SECURITY DEFINER,
-- search_path and grants are identical to the original (CREATE OR REPLACE keeps the existing ACL; the REVOKE/GRANT below re-assert it).
-- Inert unless an account has order_integration_settings.logistics_mvp_enabled = TRUE (this migration never activates any account).
--
-- Authority matrix (the RPC is the only authority; the API and the UI merely mirror it):
--   owner / admin (account_role)  : may set commercial | logistics | supervisor | NULL on any member of the same account.
--                                   Being also an operational supervisor changes nothing: full owner/admin power is kept.
--   operational supervisor, who is NOT owner/admin (e.g. account_role agent):
--                                   may set commercial | logistics | NULL on a member whose account_role is NOT owner/admin AND whose CURRENT area is not supervisor.
--                                   may NOT assign supervisor, may NOT change a supervisor (another one, or itself), may NOT self-elevate,
--                                   may NOT touch an owner/admin (even one that has no operational area).
--   everyone else (agent / viewer without supervisor area, or no area): rejected.
--   always: same account, flag ON, auth.uid() required; only profiles.operational_role is written (account_role / account_id never).
--
-- Concurrency: caller and target profile rows are locked FOR UPDATE in a deterministic order (user_id ASC => no deadlock between two
-- concurrent calls) and the authorization facts are READ AFTER the lock, so a concurrent demotion / account change / area change of
-- either party cannot be raced (no TOCTOU between the check and the UPDATE).
--
-- Deploy order: apply this migration BEFORE the application code that lets supervisors see the selector (the old app only calls the RPC
-- from an admin+ route, which keeps working against the new function: strictly backward compatible).
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
  v_enabled BOOLEAN;
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

  SELECT COALESCE(s.logistics_mvp_enabled, FALSE) INTO v_enabled
    FROM order_integration_settings s WHERE s.account_id = v_caller_account_id;
  IF NOT COALESCE(v_enabled, FALSE) THEN
    RAISE EXCEPTION 'operational_roles_disabled' USING ERRCODE = '42501';
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
