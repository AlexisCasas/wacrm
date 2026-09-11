-- ============================================================
-- 050_meta_rate_limit_retry
--
-- Meta 131056 (Business/Consumer Account pair rate limit) — PHASE 3 of
-- docs/META_131056_AUTOMATION_RETRY_AUDIT.md: durable retry for
-- Automations outbound sends. Reuses the SAME queue
-- (automation_pending_executions) the `wait` step has always written
-- to — a retry IS a wait, conceptually: "come back later and resume
-- from a specific step" — with 3 extra columns identifying it as one.
--
-- Depends on migration 044 (schedule_automation_wait_if_contact_active,
-- block_contact_internal, the contacts row-lock pattern this migration
-- reuses verbatim for its own new RPC) and migration 049's REVOKE
-- lesson (Supabase's own default-privileges setup grants EXECUTE
-- directly to anon/authenticated/service_role at CREATE time — a plain
-- `REVOKE ... FROM PUBLIC` alone is NOT sufficient; all three roles must
-- be named explicitly).
--
-- Does NOT touch schedule_automation_wait_if_contact_active() at all —
-- a brand new, separate RPC (schedule_automation_retry_if_contact_active)
-- carries the retry-specific columns and validation instead of
-- overloading the existing wait scheduler with optional retry
-- parameters. See section 3 of the Phase 3 spec for why.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Retry metadata columns.
--
--    retry_count   — 0 for a normal wait; 1..5 for a retry (this IS the
--                    retry attempt number, matching MAX_META_RATE_LIMIT_
--                    RETRIES in src/lib/automations/meta-retry-backoff.ts).
--    retry_reason  — NULL for a normal wait; the classifier's reason
--                    string ('meta_pair_rate_limit' in this first
--                    version) for a retry.
--    retry_step_id — the id of the automation_steps row whose send
--                    actually failed and is being retried. Deliberately
--                    NOT a foreign key: if the user edits/removes that
--                    step while this retry is still pending, we need
--                    the ORIGINAL UUID to survive so the resume path
--                    (engine.ts's exact-step validation, section 8 of
--                    the spec) can detect "the target changed" and fail
--                    closed — an ON DELETE SET NULL (or a hard delete
--                    error) would destroy exactly the evidence needed
--                    to tell "this step still means what it meant when
--                    we scheduled the retry" from "it doesn't, don't
--                    trust it blindly".
-- ------------------------------------------------------------
ALTER TABLE public.automation_pending_executions
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS retry_reason TEXT,
  ADD COLUMN IF NOT EXISTS retry_step_id UUID;

-- ------------------------------------------------------------
-- 2) Consistency CHECK — a row is either a normal wait (all three
--    columns at their "nothing to see here" default) or a genuine
--    retry (all three populated, retry_count bounded 1..5). Never a
--    mix of the two (e.g. a retry_reason with retry_count=0). The
--    specific reason string is deliberately NOT hardcoded here — new
--    reasons may be added later without a migration — the CHECK only
--    enforces internal consistency; schedule_automation_retry_if_
--    contact_active() below is what actually restricts p_retry_reason
--    to 'meta_pair_rate_limit' in this first version.
--
--    DROP + ADD (not a pg_constraint existence guard) because this is
--    the constraint's first-ever introduction — Postgres has no
--    "ADD CONSTRAINT IF NOT EXISTS", and DROP IF EXISTS + ADD is the
--    same idiom already used elsewhere in this repo (e.g. migrations
--    010, 016, 021, 042) for a constraint being introduced fresh.
-- ------------------------------------------------------------
ALTER TABLE public.automation_pending_executions
  DROP CONSTRAINT IF EXISTS automation_pending_executions_retry_metadata_check;
ALTER TABLE public.automation_pending_executions
  ADD CONSTRAINT automation_pending_executions_retry_metadata_check
  CHECK (
    (retry_count = 0 AND retry_reason IS NULL AND retry_step_id IS NULL)
    OR
    (retry_count BETWEEN 1 AND 5 AND retry_reason IS NOT NULL AND retry_step_id IS NOT NULL)
  );

-- ------------------------------------------------------------
-- 3) CLAIM / LEASE — crash & redeploy recovery (Phase 3.1).
--
-- GAP this closes: the cron's claim was `UPDATE ... SET status='running'
-- WHERE id=? AND status='pending'`. If the process died AFTER that
-- claim but BEFORE resumePendingExecution finished (crash, redeploy,
-- OOM-kill), the row is stuck at status='running' forever — the cron
-- only ever SELECTs status='pending', so a `wait` (and, more urgently,
-- a Meta 131056 retry, which the spec explicitly requires to "survive
-- redeploy/restart") could silently stop being processed with no
-- error anywhere. Confirmed empirically against the UNPATCHED cron in
-- src/app/api/automations/cron/route.test.ts's own "Fase 3.1"
-- describe block before this fix existed.
--
--   claim_token      — a fresh UUID minted by whoever successfully
--                       claims the row. The one piece of state that
--                       makes "am I still the owner of this execution"
--                       answerable without ambiguity — see engine.ts's
--                       isPendingExecutionStillRunning /
--                       markPending, both now ownership-aware.
--   lease_expires_at — how long an owner has before another worker is
--                       ALLOWED to reclaim the row, assuming the
--                       original owner died. See
--                       AUTOMATION_PENDING_LEASE_MS in engine.ts for
--                       the exact duration and its justification (no
--                       Meta fetch call in this codebase has a
--                       timeout today — see meta-api.ts — so the lease
--                       is chosen conservatively long rather than
--                       inferred from a bound that doesn't exist yet).
--
-- NOT a foreign key, NOT related to retry_step_id's identity role —
-- these two columns exist purely for OWNERSHIP of the execution
-- attempt itself, orthogonal to WHAT is being executed (a wait vs a
-- retry, tracked by the retry_* columns above).
-- ------------------------------------------------------------
ALTER TABLE public.automation_pending_executions
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

-- LEGACY BACKFILL — MUST run before the CHECK constraint below, and
-- MUST be idempotent (this migration can be re-applied).
--
-- Final-review finding (BLOCKER, confirmed against a real Postgres
-- instance): production has been running the PRE-050 cron
-- (`UPDATE ... SET status='running' WHERE status='pending'`, no
-- concept of claim_token/lease_expires_at at all) for as long as this
-- feature has existed. Any row that pre-050 cron claimed and is STILL
-- `status='running'` at the moment this migration runs — a completely
-- ordinary state, not a corruption — gets `claim_token`/
-- `lease_expires_at` = NULL from the plain `ADD COLUMN` above. Without
-- this backfill, the very next statement (`ADD CONSTRAINT
-- automation_pending_executions_claim_lease_check`) validates ALL
-- existing rows and a `running` row with NULL claim/lease satisfies
-- NONE of its three branches — reproduced for real: replaying
-- migrations 001-049, inserting one such legacy `running` row, then
-- applying 050 unpatched, fails with exactly
-- "check constraint ... is violated by some row", and the migration
-- stops HALFWAY (columns and the retry_metadata_check already
-- committed; this CHECK, the index below, and the RPC never created).
--
-- Even setting the CHECK aside, that same row would ALSO be invisible
-- to the cron's own reclaim query forever after: `lease_expires_at <
-- now()` evaluates to NULL (not TRUE) when lease_expires_at IS NULL,
-- so a `running` row with a NULL lease is never selected by
-- `status.eq.pending,and(status.eq.running,lease_expires_at.lt.<now>)`
-- — confirmed with a direct SQL check. It would sit `running` forever,
-- never retried, with no error anywhere.
--
-- The fix: give every such legacy row a SYNTHETIC lease that is
-- ALREADY EXPIRED (`now() - interval '1 minute'`, deliberately in the
-- past, never a future one — this is not a real claim by any live
-- worker, it must be immediately reclaimable) plus a fresh
-- claim_token so the row has SOME non-NULL value to satisfy the CHECK.
-- The very next cron tick then reclaims it through the EXACT SAME
-- stale-lease path as any other crashed worker's row (see
-- cron/route.ts's `.or(...)` filter and engine.ts's
-- AUTOMATION_PENDING_LEASE_MS) — no special-casing needed anywhere
-- else in the system for "a legacy row". `COALESCE(...)` on both
-- columns and the `claim_token IS NULL OR lease_expires_at IS NULL`
-- guard make this a no-op on re-apply for any row a REAL claim has
-- already touched (own token, own future lease) — this backfill must
-- never clobber a live worker's actual, still-valid claim.
--
-- uuid_generate_v4() (not gen_random_uuid()) to match the UUID
-- function this schema has used since migration 001, rather than
-- introducing a second UUID generator into one migration.
UPDATE public.automation_pending_executions
SET
  claim_token = COALESCE(claim_token, uuid_generate_v4()),
  lease_expires_at = COALESCE(
    lease_expires_at,
    now() - interval '1 minute'
  )
WHERE status = 'running'
  AND (
    claim_token IS NULL
    OR lease_expires_at IS NULL
  );

-- 'done'/'failed' are deliberately NOT required to null these out —
-- block_contact_internal (migration 044, untouched by this migration)
-- sweeps pending/running -> done in bulk without touching claim_token/
-- lease_expires_at, and requiring it to would mean either widening
-- that function's UPDATE (unnecessary risk to an already-correct,
-- already-audited function) or a second sweep pass. A stale non-NULL
-- claim_token/lease_expires_at on a 'done'/'failed' row is inert: every
-- ownership check in engine.ts is gated on `status = 'running'` FIRST —
-- once status is anything else, nothing ever looks at claim_token
-- again. See the Phase 3.1 section of the audit doc for the full
-- argument.
ALTER TABLE public.automation_pending_executions
  DROP CONSTRAINT IF EXISTS automation_pending_executions_claim_lease_check;
ALTER TABLE public.automation_pending_executions
  ADD CONSTRAINT automation_pending_executions_claim_lease_check
  CHECK (
    (status = 'pending' AND claim_token IS NULL AND lease_expires_at IS NULL)
    OR (status = 'running' AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status IN ('done', 'failed'))
  );

-- Mirrors idx_automation_pending_due (migration 006) for the OTHER half
-- of the cron's due-set query — a stale 'running' row with an expired
-- lease. Both partial indexes together cover the full
-- `status='pending' OR (status='running' AND lease_expires_at < now())`
-- shape without needing a single wider (and mostly-empty-condition)
-- composite index.
CREATE INDEX IF NOT EXISTS idx_automation_pending_stale_running
  ON public.automation_pending_executions (lease_expires_at)
  WHERE status = 'running';

-- ------------------------------------------------------------
-- 4) ATOMIC RETRY SCHEDULING — schedule_automation_retry_if_contact_active
--
-- Mirrors schedule_automation_wait_if_contact_active (migration 044)
-- almost exactly — same SECURITY DEFINER posture, same `SELECT ... FOR
-- UPDATE` row lock on `contacts`, same serialization argument against
-- block_contact_internal (a retry pending is swept by that function's
-- existing `status IN ('pending','running') -> 'done'` UPDATE exactly
-- like a wait pending — no changes needed there). Kept as a SEPARATE
-- function rather than extending the wait scheduler with optional
-- retry parameters: mixing "plain wait" and "retry" into one RPC's
-- conditional logic is harder to audit than two small, single-purpose
-- functions, and the wait scheduler already has a stable signature
-- multiple call sites depend on.
--
-- STRUCTURAL VALIDATION FIRST (before touching `contacts` at all): a
-- caller passing a malformed retry_count/retry_reason/retry_step_id is
-- a programming error in the engine, NOT a routine "contact isn't
-- eligible right now" outcome — conflating the two would let a bug
-- silently degrade into "no pending scheduled, log looks blocked"
-- instead of surfacing loudly. RAISE EXCEPTION (SQLSTATE 22023,
-- invalid_parameter_value) so it fails loud and distinct from the
-- FALSE/TRUE contract used for the routine block/not-found case.
--
-- retry_step_id is validated against the automation_steps row it
-- claims to identify — not just "does this id exist anywhere", but
-- "does it exist at EXACTLY this automation_id/position/parent_step_id/
-- branch, and is its step_type one of the 5 outbound send kinds". This
-- is the same guarantee engine.ts's resume-time exact-step check
-- re-validates (belt and braces — the RPC catches a caller bug at
-- schedule time, the resume-time check catches the automation being
-- edited AFTER the retry was already scheduled).
--
-- Return contract — same shape as schedule_automation_wait_if_contact_active:
--   FALSE — contact not found in this account, or currently blocked.
--           No row inserted either way; the caller doesn't need to
--           distinguish those two for its own "stop, don't retry" logic.
--   TRUE  — the retry pending row was inserted.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.schedule_automation_retry_if_contact_active(
  p_automation_id UUID,
  p_account_id UUID,
  p_user_id UUID,
  p_contact_id UUID,
  p_log_id UUID,
  p_parent_step_id UUID,
  p_branch TEXT,
  p_next_step_position INTEGER,
  p_context JSONB,
  p_run_at TIMESTAMPTZ,
  p_retry_count INTEGER,
  p_retry_reason TEXT,
  p_retry_step_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_blocked BOOLEAN;
  v_step_matches BOOLEAN;
BEGIN
  -- ---- structural validation (no lock needed yet) ----
  IF p_retry_count IS NULL OR p_retry_count < 1 OR p_retry_count > 5 THEN
    RAISE EXCEPTION 'schedule_automation_retry_if_contact_active: p_retry_count must be between 1 and 5, got %', p_retry_count
      USING ERRCODE = '22023';
  END IF;

  IF p_retry_reason IS DISTINCT FROM 'meta_pair_rate_limit' THEN
    RAISE EXCEPTION 'schedule_automation_retry_if_contact_active: unsupported p_retry_reason %', p_retry_reason
      USING ERRCODE = '22023';
  END IF;

  IF p_retry_step_id IS NULL THEN
    RAISE EXCEPTION 'schedule_automation_retry_if_contact_active: p_retry_step_id is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM automation_steps
    WHERE id = p_retry_step_id
      AND automation_id = p_automation_id
      AND position = p_next_step_position
      AND parent_step_id IS NOT DISTINCT FROM p_parent_step_id
      AND branch IS NOT DISTINCT FROM p_branch
      AND step_type IN ('send_message', 'send_media', 'send_buttons', 'send_list', 'send_template')
  ) INTO v_step_matches;

  IF NOT v_step_matches THEN
    RAISE EXCEPTION 'schedule_automation_retry_if_contact_active: p_retry_step_id % does not match an outbound send step at the given automation/position/parent/branch', p_retry_step_id
      USING ERRCODE = '22023';
  END IF;

  -- ---- same row lock + serialization argument as migration 044's
  -- schedule_automation_wait_if_contact_active — see that function's
  -- own comment for the full case-A/case-B proof. ----
  SELECT blocked INTO v_blocked
  FROM contacts
  WHERE id = p_contact_id AND account_id = p_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  IF v_blocked THEN
    RETURN FALSE;
  END IF;

  INSERT INTO automation_pending_executions (
    automation_id, account_id, user_id, contact_id, log_id,
    parent_step_id, branch, next_step_position, context, run_at, status,
    retry_count, retry_reason, retry_step_id
  ) VALUES (
    p_automation_id, p_account_id, p_user_id, p_contact_id, p_log_id,
    p_parent_step_id, p_branch, p_next_step_position, p_context, p_run_at, 'pending',
    p_retry_count, p_retry_reason, p_retry_step_id
  );

  RETURN TRUE;
END;
$$;

-- Same server-only posture as every other SECURITY DEFINER RPC in this
-- schema. Confirmed in the Fase P3 review that a plain
-- `REVOKE ... FROM PUBLIC` is NOT sufficient — Supabase's own
-- default-privileges setup grants EXECUTE directly to `anon`,
-- `authenticated`, and `service_role` at CREATE time (separately from
-- the PUBLIC pseudo-role) — all three must be named explicitly, then
-- service_role granted back.
REVOKE ALL ON FUNCTION public.schedule_automation_retry_if_contact_active(
  UUID, UUID, UUID, UUID, UUID, UUID, TEXT, INTEGER, JSONB, TIMESTAMPTZ, INTEGER, TEXT, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.schedule_automation_retry_if_contact_active(
  UUID, UUID, UUID, UUID, UUID, UUID, TEXT, INTEGER, JSONB, TIMESTAMPTZ, INTEGER, TEXT, UUID
) TO service_role;
