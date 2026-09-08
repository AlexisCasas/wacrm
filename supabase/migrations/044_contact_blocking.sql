-- ============================================================
-- 044_contact_blocking.sql
--
-- P0 — BLOQUEO Y DESBLOQUEO INTERNO DE CONTACTOS.
--
-- Internal (WACRM-side) contact blocking — NOT WhatsApp/Meta's native
-- block. An agent/admin/owner can block a contact from the Inbox so
-- that, going forward:
--   - it drops out of the normal Inbox list
--   - new inbound messages are not persisted (only a lightweight
--     blocked-inbound counter is kept — never message content)
--   - no outbound (manual, Flow, Automation, AI) can reach them
--
-- History (messages, conversations, flow_runs, automation_logs) is
-- never deleted by block/unblock — see contact_block_events below for
-- why blocked_by_user_id alone isn't enough audit trail.
--
-- Idempotent — safe to run multiple times, matches every prior
-- migration's style (IF NOT EXISTS for tables/columns/indexes, DROP
-- POLICY IF EXISTS before CREATE POLICY).
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS blocked BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS blocked_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Trazabilidad mínima de inbound bloqueado — nunca el contenido del
  -- mensaje, solo cuántos llegaron y cuándo fue el último.
  ADD COLUMN IF NOT EXISTS blocked_inbound_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_blocked_inbound_at TIMESTAMPTZ;

-- The only query shape this drives is "this account's blocked
-- contacts" (the Blocked Contacts screen) — a partial index on
-- blocked=true is smaller and cheaper to maintain than a full
-- (account_id, blocked) composite that would also index every
-- non-blocked row, the overwhelming majority in practice.
CREATE INDEX IF NOT EXISTS idx_contacts_account_blocked
  ON contacts(account_id) WHERE blocked = true;

-- ============================================================
-- AUDIT TRAIL — contact_block_events
--
-- blocked_by_user_id alone loses history the moment a contact is
-- unblocked (it's reset to NULL). This table is append-only and keeps
-- every block/unblock transition forever, independent of the
-- contact's current state — required so "who blocked this contact
-- last March" stays answerable after an unblock.
-- ============================================================
CREATE TABLE IF NOT EXISTS contact_block_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- ON DELETE CASCADE, deliberately — WACRM already allows deleting a
  -- contact outright (see the DELETE policy on `contacts`, migration
  -- 017), and contact_id is NOT NULL here. A block/unblock history
  -- with no contact left to attach it to has no further purpose once
  -- the contact itself is gone, so it disappears with it rather than
  -- becoming an orphaned row (SET NULL would need contact_id to be
  -- nullable, which would weaken every other query/index on this
  -- table for no benefit) — and, critically, CASCADE means deleting a
  -- contact can never start failing because of a stray FK from this
  -- audit table.
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('blocked', 'unblocked')),
  -- Nullable: the acting user's own auth row could later be removed
  -- from auth.users independently of this account membership ending;
  -- the audit row must survive that (ON DELETE SET NULL), same
  -- posture as contacts.blocked_by_user_id above.
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contact_block_events_contact
  ON contact_block_events(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_block_events_account
  ON contact_block_events(account_id, created_at DESC);

ALTER TABLE contact_block_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_block_events_select ON contact_block_events;
CREATE POLICY contact_block_events_select ON contact_block_events
  FOR SELECT USING (is_account_member(account_id));
-- No INSERT/UPDATE/DELETE policy for authenticated users — every write
-- goes through the block/unblock API routes via the service-role
-- client (requireRole('agent') gates who can call them), mirroring
-- automation_pending_executions' posture (migration 006): no
-- browser-facing mutation policy at all.

-- ============================================================
-- ATOMIC BLOCKED-INBOUND COUNTER — record_blocked_inbound
--
-- Two webhook deliveries can race for the same blocked contact (Meta
-- retries a slow ack). A client-side read-modify-write would lose
-- increments under concurrency — same rationale as
-- increment_flow_execution_count (migration 012) and
-- increment_automation_execution_count (migration 007).
--
-- Scoped by BOTH contact_id AND account_id (defense-in-depth: this
-- runs under service_role, which bypasses RLS), and only touches a
-- row that is ACTUALLY blocked right now — if the contact was
-- unblocked between the webhook's read and this call, the UPDATE
-- matches zero rows and silently no-ops rather than recording a
-- "blocked inbound" that, under the current state, didn't happen.
-- Never stores message text, media, or any other message content.
-- ============================================================
CREATE OR REPLACE FUNCTION record_blocked_inbound(
  p_contact_id UUID,
  p_account_id UUID,
  p_timestamp TIMESTAMPTZ DEFAULT NOW()
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE contacts
  SET
    blocked_inbound_count = blocked_inbound_count + 1,
    last_blocked_inbound_at = p_timestamp
  WHERE id = p_contact_id
    AND account_id = p_account_id
    AND blocked = true;
$$;

-- Only the service role needs to call this (webhook + ManyChat bridge
-- both use the service-role client). Explicitly lock anon /
-- authenticated out so a browser session can't juice this counter
-- (or any other account's) directly via RPC.
REVOKE ALL ON FUNCTION record_blocked_inbound(UUID, UUID, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_blocked_inbound(UUID, UUID, TIMESTAMPTZ) FROM anon;
REVOKE ALL ON FUNCTION record_blocked_inbound(UUID, UUID, TIMESTAMPTZ) FROM authenticated;
GRANT EXECUTE ON FUNCTION record_blocked_inbound(UUID, UUID, TIMESTAMPTZ) TO service_role;

-- ============================================================
-- TRANSACTIONAL BLOCK / UNBLOCK — block_contact_internal /
-- unblock_contact_internal
--
-- POST /api/contacts/[id]/block used to run the contact UPDATE, the
-- audit INSERT, the flow_runs pause, and the pending-automation
-- cancellation as four independent Supabase-JS calls. That is NOT
-- atomic: a crash or a thrown error between any two of those calls
-- leaves the contact blocked with, say, no audit row, or with a Flow
-- still active. Wrapping all of it in one PL/pgSQL function makes it
-- genuinely transactional — Postgres runs an entire function body as
-- a single transaction when called via RPC, and any unhandled error
-- inside it rolls back every statement the function ran, including
-- ones that already "succeeded" earlier in the same call.
--
-- `SELECT ... FOR UPDATE` locks the contact row for the duration of
-- the transaction, so two concurrent block calls (or a concurrent
-- block/unblock pair) for the same contact can't interleave: the
-- second call waits, then re-reads the now-current `blocked` value
-- and takes the idempotent no-op path instead of double-writing an
-- audit row or re-running the side effects.
--
-- Return contract (nullable BOOLEAN, not an exception) — deliberately
-- NOT `RAISE EXCEPTION` for "contact not found": that is an expected,
-- routine outcome (wrong id, cross-account id, already-deleted
-- contact), not a technical failure, and turning it into a Postgres
-- exception would force the caller to parse an error message string
-- to distinguish "not found" from a genuine DB error.
--   NULL  = no such contact in this account (route maps to 404)
--   TRUE  = no-op — the contact already had this blocked state
--   FALSE = the transition was performed
-- ============================================================
CREATE OR REPLACE FUNCTION block_contact_internal(
  p_account_id UUID,
  p_contact_id UUID,
  p_user_id UUID,
  p_blocked_at TIMESTAMPTZ DEFAULT NOW()
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_was_blocked BOOLEAN;
BEGIN
  SELECT blocked INTO v_was_blocked
  FROM contacts
  WHERE id = p_contact_id AND account_id = p_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_was_blocked THEN
    -- Idempotent: already blocked, never duplicate the audit row or
    -- re-run the pause/cancel side effects.
    RETURN TRUE;
  END IF;

  UPDATE contacts
  SET
    blocked = TRUE,
    blocked_at = p_blocked_at,
    blocked_by_user_id = p_user_id
  WHERE id = p_contact_id AND account_id = p_account_id;

  INSERT INTO contact_block_events (account_id, contact_id, action, user_id)
  VALUES (p_account_id, p_contact_id, 'blocked', p_user_id);

  -- Stop any currently active Flow run for this contact. Mirrors the
  -- existing "pause on agent send" pattern (send-message.ts) with its
  -- own end_reason so it's distinguishable in flow_runs history.
  UPDATE flow_runs
  SET
    status = 'paused_by_agent',
    ended_at = p_blocked_at,
    end_reason = 'contact_blocked'
  WHERE account_id = p_account_id
    AND contact_id = p_contact_id
    AND status = 'active';

  -- Cancel pending Automation waits so they can never revive on a
  -- future unblock. Includes 'running' as a defensive backstop for a
  -- row the cron flipped but hasn't finished processing yet — the
  -- engine's own per-step blocked recheck (executeStepsFrom) already
  -- stops that execution independently and marks it 'done' itself, so
  -- this is belt-and-braces, not the only defense.
  UPDATE automation_pending_executions
  SET status = 'done'
  WHERE account_id = p_account_id
    AND contact_id = p_contact_id
    AND status IN ('pending', 'running');

  RETURN FALSE;
END;
$$;

-- Same nullable-BOOLEAN contract as block_contact_internal.
-- Deliberately does NOT touch flow_runs or automation_pending_executions
-- — unblocking only makes the contact eligible for FUTURE events;
-- nothing that was paused/cancelled by a block is ever revived.
CREATE OR REPLACE FUNCTION unblock_contact_internal(
  p_account_id UUID,
  p_contact_id UUID,
  p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_was_blocked BOOLEAN;
BEGIN
  SELECT blocked INTO v_was_blocked
  FROM contacts
  WHERE id = p_contact_id AND account_id = p_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF NOT v_was_blocked THEN
    RETURN TRUE;
  END IF;

  UPDATE contacts
  SET
    blocked = FALSE,
    blocked_at = NULL,
    blocked_by_user_id = NULL
    -- blocked_inbound_count / last_blocked_inbound_at are historical
    -- operational counters — deliberately never reset here.
  WHERE id = p_contact_id AND account_id = p_account_id;

  INSERT INTO contact_block_events (account_id, contact_id, action, user_id)
  VALUES (p_account_id, p_contact_id, 'unblocked', p_user_id);

  RETURN FALSE;
END;
$$;

-- ------------------------------------------------------------
-- PRIVILEGES — MUY IMPORTANTE.
--
-- Both functions are SECURITY DEFINER: they run with the privileges
-- of the function's owner (the migration-runner role, same as every
-- other SECURITY DEFINER function in this schema — e.g.
-- is_account_member in migration 017) rather than the caller's,
-- which is what lets them bypass RLS to write flow_runs /
-- automation_pending_executions / contact_block_events in one go. No
-- explicit `OWNER TO` is set here, matching the convention already
-- used by the other counter-style RPCs (increment_flow_execution_count,
-- migration 012; increment_automation_execution_count, migration 007)
-- — only the RLS-helper functions that policies themselves depend on
-- (is_account_member, handle_new_user) pin an explicit owner.
--
-- `p_account_id` / `p_user_id` are NEVER accepted from the browser —
-- the API routes resolve both from requireRole('agent')/the session
-- and pass them in; the SQL itself still filters every write by
-- account_id regardless, so even a compromised/buggy route can't
-- cross a tenant boundary through this function.
--
-- The block/unblock API routes already run these under the
-- service-role client AFTER their own requireRole('agent') gate — the
-- browser has no legitimate reason to ever call either function
-- directly. Lock that down explicitly rather than relying on "nobody
-- happens to call it": REVOKE from PUBLIC and authenticated, GRANT
-- only to service_role. A SECURITY DEFINER function reachable from an
-- authenticated Supabase client would let ANY logged-in user block/
-- unblock ANY contact by UUID, in any account, entirely bypassing
-- requireRole('agent') and RLS alike — these two GRANTs are the only
-- thing standing between "internal server-only RPC" and exactly that.
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION block_contact_internal(UUID, UUID, UUID, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION block_contact_internal(UUID, UUID, UUID, TIMESTAMPTZ) FROM anon;
REVOKE ALL ON FUNCTION block_contact_internal(UUID, UUID, UUID, TIMESTAMPTZ) FROM authenticated;
GRANT EXECUTE ON FUNCTION block_contact_internal(UUID, UUID, UUID, TIMESTAMPTZ) TO service_role;

REVOKE ALL ON FUNCTION unblock_contact_internal(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION unblock_contact_internal(UUID, UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION unblock_contact_internal(UUID, UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION unblock_contact_internal(UUID, UUID, UUID) TO service_role;

-- ============================================================
-- ATOMIC WAIT SCHEDULING — schedule_automation_wait_if_contact_active
--
-- Closes the last TOCTOU window in contact blocking. Without this,
-- the engine's per-step `contacts.blocked` check and the
-- `automation_pending_executions` INSERT for a `wait` step were two
-- independent Supabase-JS calls:
--
--   T0  executeStepsFrom reads contacts.blocked = false
--   T1  block_contact_internal runs concurrently: locks the contact,
--       sets blocked = true, sweeps pending/running -> done, commits
--   T2  executeStepsFrom, unaware of T1, continues past its own
--       (now-stale) check
--   T3  INSERT automation_pending_executions(status='pending') — a
--       row born AFTER the block's sweep already ran, so the sweep
--       never saw it and never cancelled it
--   T4  the contact is unblocked later
--   T5  this pending row's run_at arrives and it executes
--
-- That is exactly the "unblock revives an Automation started before
-- the block" bug the rest of this migration exists to prevent — it
-- just hid in the INSERT for a *new* wait rather than in reviving an
-- *existing* one. Fixing it requires the check-then-insert to be one
-- atomic unit, so this function does both inside a single transaction,
-- taking the identical `SELECT ... FOR UPDATE` row lock on `contacts`
-- that `block_contact_internal` takes.
--
-- SERIALIZATION ARGUMENT — why the shared row lock closes the race:
--
--   Case A — this scheduler call reaches the row lock FIRST:
--     it sees blocked=false, inserts the pending row, and commits.
--     block_contact_internal, waiting on the same row lock, then
--     proceeds — its own sweep (status IN ('pending','running') ->
--     'done') runs AFTER this INSERT committed, so it DOES see and
--     cancel the row that was just created. Nothing survives.
--
--   Case B — block_contact_internal reaches the row lock FIRST:
--     it sets blocked=true and commits (there was nothing to sweep
--     yet — this row didn't exist). This scheduler call, having
--     waited on the lock, now re-reads the contact and sees
--     blocked=true, so it returns FALSE without ever inserting.
--
-- Either ordering ends with zero surviving pending rows for a blocked
-- contact — the lock makes "read blocked, then insert" indivisible
-- with respect to a concurrent block.
--
-- Return: FALSE when the contact doesn't exist in this account OR is
-- currently blocked (no row inserted either way — the caller doesn't
-- need to distinguish those two for its own "stop, don't schedule"
-- behavior). TRUE when the pending row was inserted.
-- ============================================================
CREATE OR REPLACE FUNCTION schedule_automation_wait_if_contact_active(
  p_automation_id UUID,
  p_account_id UUID,
  p_user_id UUID,
  p_contact_id UUID,
  p_log_id UUID,
  p_parent_step_id UUID,
  p_branch TEXT,
  p_next_step_position INTEGER,
  p_context JSONB,
  p_run_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_blocked BOOLEAN;
BEGIN
  -- The SAME row lock block_contact_internal takes on the SAME
  -- contact row — see the serialization argument above.
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
    parent_step_id, branch, next_step_position, context, run_at, status
  ) VALUES (
    p_automation_id, p_account_id, p_user_id, p_contact_id, p_log_id,
    p_parent_step_id, p_branch, p_next_step_position, p_context, p_run_at, 'pending'
  );

  RETURN TRUE;
END;
$$;

-- Same server-only posture as record_blocked_inbound /
-- block_contact_internal / unblock_contact_internal — the browser
-- never has a legitimate reason to schedule an automation wait
-- directly, and a SECURITY DEFINER function reachable from an
-- authenticated client would let any logged-in user forge a pending
-- execution (and its context payload) for an arbitrary automation/
-- contact in any account.
REVOKE ALL ON FUNCTION schedule_automation_wait_if_contact_active(
  UUID, UUID, UUID, UUID, UUID, UUID, TEXT, INTEGER, JSONB, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION schedule_automation_wait_if_contact_active(
  UUID, UUID, UUID, UUID, UUID, UUID, TEXT, INTEGER, JSONB, TIMESTAMPTZ
) FROM anon;
REVOKE ALL ON FUNCTION schedule_automation_wait_if_contact_active(
  UUID, UUID, UUID, UUID, UUID, UUID, TEXT, INTEGER, JSONB, TIMESTAMPTZ
) FROM authenticated;
GRANT EXECUTE ON FUNCTION schedule_automation_wait_if_contact_active(
  UUID, UUID, UUID, UUID, UUID, UUID, TEXT, INTEGER, JSONB, TIMESTAMPTZ
) TO service_role;
