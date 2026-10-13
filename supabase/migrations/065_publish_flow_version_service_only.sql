-- F06 Security Gate (P1): publish_flow_version must be callable by service_role ONLY.
--
-- Migration 052 declared it service-only (REVOKE FROM PUBLIC and anon, GRANT TO service_role) but never revoked it from
-- `authenticated`, which receives EXECUTE from the platform's default privileges. The function is SECURITY DEFINER and authorises
-- with the CALLER-SUPPLIED p_published_by instead of the JWT, so any logged-in user could publish ANY account's flow through
-- PostgREST by naming one of that account's owners/admins/agents as the publisher (reproduced over HTTP in G01).
-- The only caller, the activate route, uses the service-role client after its own requireRole() check, so nothing legitimate loses access.
-- Additive: no function body changes, so published migration 052 stays untouched.
REVOKE ALL ON FUNCTION public.publish_flow_version(UUID, TIMESTAMPTZ, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_flow_version(UUID, TIMESTAMPTZ, UUID, JSONB) TO service_role;
