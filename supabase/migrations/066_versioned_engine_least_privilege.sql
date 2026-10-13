-- F06 Security Gate (P2, defence in depth): least privilege for the engine's internal helpers and tables.
--
-- 1. lock_versioned_run / versioned_run_gate are internal helpers called only from the SECURITY DEFINER RPCs (which run as their
--    owner). They kept the platform default EXECUTE for anon and authenticated, so they were reachable through PostgREST.
--    They are SECURITY INVOKER and RLS limits them to the caller's own rows, so this is exposure, not a leak: closed anyway.
-- 2. The engine tables carried the platform's default table privileges for anon / authenticated (INSERT, UPDATE, DELETE, TRUNCATE,
--    REFERENCES, TRIGGER). RLS stops row writes, but TRUNCATE is not subject to RLS: any session that can SET ROLE authenticated
--    could empty flow_versions, flow_run_call_frames or flow_runs. PostgREST exposes no TRUNCATE, so this is not reachable over HTTP;
--    it is still removed. Users keep exactly the SELECT they have always used (RLS scopes it by account). The engine writes through
--    SECURITY DEFINER RPCs and service_role, which are untouched.
REVOKE ALL ON FUNCTION public.lock_versioned_run(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.versioned_run_gate(public.flow_runs, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lock_versioned_run(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.versioned_run_gate(public.flow_runs, TEXT, INTEGER) TO service_role;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.flow_runs FROM anon, authenticated;
REVOKE ALL ON TABLE public.flow_versions FROM anon, authenticated;
REVOKE ALL ON TABLE public.flow_run_call_frames FROM anon, authenticated;
REVOKE ALL ON TABLE public.flow_run_effects FROM anon, authenticated;
REVOKE ALL ON TABLE public.flow_run_effect_messages FROM anon, authenticated;
GRANT SELECT ON TABLE public.flow_versions TO authenticated;
GRANT SELECT ON TABLE public.flow_run_call_frames TO authenticated;
