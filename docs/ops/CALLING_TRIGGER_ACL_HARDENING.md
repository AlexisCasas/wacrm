# SEC-CALL-ACL-01 — Correction of public EXECUTE on Calling SDP cleanup trigger

**Status:** code only — no change to the VPS, Meta, active calls or DB yet.

## Evidence

Production operator's read-only audit (23-Nov-2026, Lima):
- profiles: 1 owner/supervisor, 3 agents/logistics, 3 agents/commercial.
- `whatsapp_call_*` routines: 19 total, 18 not executable by `anon`/`authenticated`; only `public.whatsapp_call_agent_sdp_terminal_clear()` had `anon_execute=t`, `authenticated_execute=t`.
- automatic `RPC_ACL_GATE` stopped with `EXPOSED_RPC_COUNT=1`. **CALL-RBAC-01 app image has NOT been deployed.** Live stays `wacrm-app:global-incoming-alert-9076c1c8`.
- GitHub source: `supabase/migrations/20261130000001_whatsapp_calling_signaling.sql` lines ~679-700 defines a zero-argument **RETURNS trigger**, `SECURITY INVOKER` (default) `BEFORE UPDATE OF state` handler on `public.whatsapp_call_sessions`; removes transient agent SDP when state is terminal. No explicit REVOKE on this trigger function in the original migration.
- PostgreSQL default function EXECUTE grants to PUBLIC, which `anon`/`authenticated` inherit. This is an ACL hygiene gap. Since it is a trigger function, public EXECUTE alone is **not** evidence that a user can invoke this routine as a normal RPC or extract call data.

## Operator-safe remediation

The correction consists of two reviewed repository files:
- `ops/security/calling-trigger-execute-acl-audit.sql`: **READ ONLY** function identity, trigger binding, effective EXECUTE grants and full `whatsapp_call_*` counts.
- `ops/security/calling-trigger-execute-acl.sql`: **single transaction**, validates that the function really is an INVOKER `RETURNS trigger` with zero args and the expected live trigger on `whatsapp_call_sessions`; `REVOKE ... FROM PUBLIC, anon, authenticated`; explicitly `GRANT EXECUTE TO service_role`; then verifies 0/19 exposed functions, throws and rolls back if any invariant differs. No rewrite/drop of function or trigger, no DML, no migrations, no Meta change.

**Do not execute if the live read-only audit differs from the findings.** Never assume the migration file alone accurately describes current VPS catalog.

### Phase A — read-only audit

Using the exact PR HEAD (fetch SHA from GitHub), with a clean checkout and the current healthy image:

```bash
cd /root/wacrm-inkaclick
git status --porcelain
git fetch origin fix/calling-trigger-execute-acl-20261123
# git switch --detach <EXACT_SHA_FROM_GITHUB>
docker inspect -f '{{.Config.Image}} {{.State.Health.Status}} {{.RestartCount}}' wacrm-app-1
docker exec -i supabase-db psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 \
  < ops/security/calling-trigger-execute-acl-audit.sql
```

Expected function signature `public.whatsapp_call_agent_sdp_terminal_clear()`, `return_type=trigger`, `security_mode=INVOKER`, exactly one enabled trigger on `public.whatsapp_call_sessions`, and 19 routines, one publicly executable.

### Phase B — corrective transaction (separately, after Phase A PASS)

Precondition: no active calls, backups verified, GitHub CI passed, live baseline healthy. Run only:

```bash
docker exec -i supabase-db psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 \
  < ops/security/calling-trigger-execute-acl.sql
```

Expected `CALLING_TRIGGER_ACL_PRECHECK=PASS`, `RPC_ACL_GATE=PASS`, `COMMIT`. If output contains `ROLLBACK` or `ERROR`, STOP, do not repeat automatically.

Afterwards rerun Phase A audit. Expected **19/19 RPC routines not executable by anon or authenticated**, and service_role still executable. Recheck Caddy `PUBLIC_ALIAS=wacrm-app-1`, app readiness, webhook errors and Calling/Flows runtime flags; no deploy/restart needed for this permission change.

### Phase C — return to CALL-RBAC-01

Only after ACL + health verification: build app image from exact **PR #170 HEAD** (unless new commits), run focused tests, take/verify fresh DB backup and zero active call gate, then normal blue/green `ops/deploy/deploy.sh` dry-run and `--execute`; ensure Commercial 403 on Calling GET/POST while regular messages remain functional, Logistics/Supervisor calling E2E, and no regressions in Meta permissions, webhooks or Flows. Keep both PRs Draft until operator signs off on E2E.

## Schema history note

This is an **operator-controlled SQL correction**, not a new Supabase migration history entry. It is committed and auditable but must also be included in a later **forward-only migration** before claiming that new installations are secured automatically. Do not modify an already-applied migration file, and do not create a migration file by guessing version numbers: this repository contains future-dated historical migrations beyond 2026-11-23. Generate a new migration using the project's Supabase CLI and verify its ordering before release. Until then, any rebuild of the DB must rerun the hardened ACL gate.

## Rollback

There is no automatic rollback to `PUBLIC EXECUTE`: regranting that broad privilege would recreate the finding. If the correction unexpectedly breaks Calling, diagnose the trigger and the exact role first, then decide on a separately authorized targeted remedy. The app image rollback does not revert this database ACL.
