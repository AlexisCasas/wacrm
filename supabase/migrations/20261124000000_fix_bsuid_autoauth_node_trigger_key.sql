-- Fix for 20261122000000_bsuid_flow_auto_authorization.sql (already applied; this file never edits it).
--
-- BUG: bsuid_flow_autoauth_on_node() de-duplicates its work per flow and per transaction with a transaction-local custom setting named
--   'wacrm.bsuid_autoauth.' || replace(<flow uuid>, '-', '_').
-- PostgreSQL requires every dot-separated part of a custom setting name to be a valid identifier, i.e. to START WITH A LETTER OR "_".
-- A flow id that starts with a digit (0-9: 10 of every 16 random UUIDs) therefore makes set_config() raise SQLSTATE 42602
-- ("invalid configuration parameter name"). The trigger is a deferred constraint trigger on flow_nodes, so the error surfaces at COMMIT and
-- aborts the whole transaction: replace_flow_draft_atomic() (the Flow editor's save), deleting a flow (cascade) and creating/duplicating a
-- flow with nodes all failed for those flows. The API reported it as "Could not save flow" (HTTP 500). Atomicity means the previously saved
-- version was never touched.
--
-- FIX: prefix the key part with a letter. Same semantics (one sync per flow per transaction); only the setting name changes. Nothing else in
-- the migration used a flow-derived setting name. CREATE OR REPLACE keeps the function's ACL and the trigger that points at it.
CREATE OR REPLACE FUNCTION public.bsuid_flow_autoauth_on_node() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_flow uuid := COALESCE(NEW.flow_id, OLD.flow_id); v_key text := 'wacrm.bsuid_autoauth.f_' || replace(v_flow::text, '-', '_');
BEGIN
  IF current_setting(v_key, true) = '1' THEN RETURN NULL; END IF;
  PERFORM set_config(v_key, '1', true);
  PERFORM public.bsuid_flow_autoauth_sync(v_flow, 0);
  RETURN NULL;
END $$;

-- ROLLBACK (only to restore the previous, defective behaviour; do not):
--   re-run the CREATE OR REPLACE FUNCTION from 20261122000000_bsuid_flow_auto_authorization.sql (the version without the "f_" prefix).
