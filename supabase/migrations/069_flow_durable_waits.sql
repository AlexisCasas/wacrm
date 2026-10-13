-- ============================================================
-- 069_flow_durable_waits
--
-- Durable waits for the legacy Flows engine: a flow can park at a "delay" node for seconds, minutes, hours or days
-- and be resumed later, even after the server restarts. Until now `delay` was an in-process sleep of at most 30 s.
--
-- Design (see docs in qa/durable-wait/DESIGN.md):
--   * State lives on the run itself (flow_runs.wait_*), so one run, one place: nothing is duplicated into another queue
--     and the existing "one active run per contact" rule keeps protecting the conversation.
--   * A run that waits keeps status = 'active'. Everything that already ends or pauses active runs (an agent taking over,
--     blocking the contact, the flow being deleted) therefore also cancels the wait: resumption requires status = 'active'.
--   * Resumption is exactly-once: claim_due_flow_waits() hands each due run to ONE worker (FOR UPDATE SKIP LOCKED + a
--     lease + a random token); consume_flow_wait() succeeds only for the holder of the current token and clears the wait in
--     the same statement that moves the run to the next node. A worker that lost its claim (crash, lease expiry) can
--     never continue. This is at-most-once on purpose: after a crash BETWEEN consume and the first send the run stays at
--     the next node and the existing stale-run sweep ends it; it is never resumed twice.
--   * No new node type: the durable wait is a `delay` node whose config also carries { amount, unit }. The node_type CHECK
--     is untouched, so this migration cannot conflict with E4.2's 058 (which recreates that constraint).
--   * Executing waits is OFF by default. The database refuses to activate a flow that contains a durable wait (and to add
--     one to an active flow) unless the session sets app.allow_durable_wait_activation = 'on'. PostgREST sessions cannot set
--     it, so enabling execution is a deliberate operator step (a later migration or ALTER ROLE), exactly like execute_flow.
--
-- Additive: four nullable columns, one CHECK, one partial index, three functions, two triggers with WHEN clauses.
-- Existing rows and flows keep working unchanged.
-- ============================================================

ALTER TABLE public.flow_runs
  ADD COLUMN IF NOT EXISTS wait_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS wait_node_key TEXT,
  ADD COLUMN IF NOT EXISTS wait_claim_token UUID,
  ADD COLUMN IF NOT EXISTS wait_claimed_at TIMESTAMPTZ;

ALTER TABLE public.flow_runs DROP CONSTRAINT IF EXISTS flow_runs_wait_shape;
ALTER TABLE public.flow_runs ADD CONSTRAINT flow_runs_wait_shape CHECK (
  (wait_until IS NULL) = (wait_node_key IS NULL)
  AND (wait_claim_token IS NULL) = (wait_claimed_at IS NULL)
  AND (wait_until IS NOT NULL OR wait_claim_token IS NULL)
);

-- The scheduler only ever asks "which active runs are due?".
CREATE INDEX IF NOT EXISTS idx_flow_runs_waiting_due
  ON public.flow_runs (wait_until)
  WHERE wait_until IS NOT NULL AND status = 'active';

-- ------------------------------------------------------------
-- schedule_flow_wait: park an ACTIVE run at its delay node until p_wait_until.
-- Returns false (and changes nothing) when the run is not active (cancelled / paused / ended), does not belong to the
-- account, or is already waiting.
-- ------------------------------------------------------------
CREATE FUNCTION public.schedule_flow_wait(p_account_id UUID, p_run_id UUID, p_node_key TEXT, p_wait_until TIMESTAMPTZ)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE v_rows INTEGER;
BEGIN
  IF p_account_id IS NULL OR p_run_id IS NULL OR p_node_key IS NULL OR btrim(p_node_key) = '' OR p_wait_until IS NULL
     OR p_wait_until > clock_timestamp() + interval '31 days' THEN
    RAISE EXCEPTION 'invalid flow wait request' USING ERRCODE = '22023';
  END IF;
  UPDATE public.flow_runs r
     SET wait_until = p_wait_until, wait_node_key = p_node_key, current_node_key = p_node_key,
         wait_claim_token = NULL, wait_claimed_at = NULL, last_advanced_at = clock_timestamp()
   WHERE r.id = p_run_id AND r.account_id = p_account_id AND r.status = 'active' AND r.wait_until IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

-- ------------------------------------------------------------
-- claim_due_flow_waits: hand due runs to ONE worker. Only runs of the listed accounts are considered (an empty or NULL list
-- claims nothing). A claim older than p_lease_seconds is considered abandoned and can be taken over; the previous holder's
-- token stops working at that moment.
-- ------------------------------------------------------------
CREATE FUNCTION public.claim_due_flow_waits(p_account_ids UUID[], p_limit INTEGER DEFAULT 25, p_lease_seconds INTEGER DEFAULT 300)
RETURNS TABLE (run_id UUID, account_id UUID, flow_id UUID, node_key TEXT, claim_token UUID, due_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 3600 THEN
    RAISE EXCEPTION 'invalid flow wait claim request' USING ERRCODE = '22023';
  END IF;
  IF p_account_ids IS NULL OR cardinality(p_account_ids) = 0 THEN RETURN; END IF;
  RETURN QUERY
  WITH due AS (
    SELECT r.id FROM public.flow_runs r
     WHERE r.status = 'active' AND r.wait_until IS NOT NULL AND r.wait_until <= clock_timestamp()
       AND r.account_id = ANY (p_account_ids)
       AND (r.wait_claim_token IS NULL OR r.wait_claimed_at <= clock_timestamp() - make_interval(secs => p_lease_seconds))
     ORDER BY r.wait_until, r.id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.flow_runs r
     SET wait_claim_token = gen_random_uuid(), wait_claimed_at = clock_timestamp()
    FROM due
   WHERE r.id = due.id
  RETURNING r.id, r.account_id, r.flow_id, r.wait_node_key, r.wait_claim_token, r.wait_until;
END;
$$;

-- ------------------------------------------------------------
-- consume_flow_wait: the single moment a wait ends. True only for the current token holder while the run is still active and
-- due; the run moves to the next node and the wait is cleared in the same statement.
-- ------------------------------------------------------------
CREATE FUNCTION public.consume_flow_wait(p_account_id UUID, p_run_id UUID, p_claim_token UUID, p_next_node_key TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE v_rows INTEGER;
BEGIN
  IF p_account_id IS NULL OR p_run_id IS NULL OR p_claim_token IS NULL OR p_next_node_key IS NULL OR btrim(p_next_node_key) = '' THEN
    RAISE EXCEPTION 'invalid flow wait request' USING ERRCODE = '22023';
  END IF;
  UPDATE public.flow_runs r
     SET current_node_key = p_next_node_key, wait_until = NULL, wait_node_key = NULL, wait_claim_token = NULL, wait_claimed_at = NULL,
         last_advanced_at = clock_timestamp()
   WHERE r.id = p_run_id AND r.account_id = p_account_id AND r.status = 'active'
     AND r.wait_claim_token = p_claim_token AND r.wait_until IS NOT NULL AND r.wait_until <= clock_timestamp();
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

-- Supabase's default privileges hand EXECUTE to anon / authenticated / service_role at CREATE time; name every role.
REVOKE ALL ON FUNCTION public.schedule_flow_wait(UUID, UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_due_flow_waits(UUID[], INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_flow_wait(UUID, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_flow_wait(UUID, UUID, TEXT, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_due_flow_waits(UUID[], INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_flow_wait(UUID, UUID, UUID, TEXT) TO service_role;

-- ------------------------------------------------------------
-- Guards. A durable wait is a delay node whose config has `unit`.
--   * the node must be well formed: integer amount >= 1, unit in seconds|minutes|hours|days, total <= 30 days (22023);
--   * it cannot be added to an ACTIVE flow, and a flow holding one cannot become active (0A000), unless the session
--     sets app.allow_durable_wait_activation = 'on' (operator / test sessions only; PostgREST cannot).
-- Both triggers carry WHEN clauses, so every other write never calls them.
-- ------------------------------------------------------------
CREATE FUNCTION public.guard_durable_wait_node()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
  v_amount NUMERIC;
  v_mult INTEGER;
  v_unit TEXT := NEW.config->>'unit';
BEGIN
  IF jsonb_typeof(NEW.config) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'durable wait config must be an object' USING ERRCODE = '22023';
  END IF;
  IF v_unit IS NULL OR v_unit NOT IN ('seconds', 'minutes', 'hours', 'days') THEN
    RAISE EXCEPTION 'durable wait unit must be seconds, minutes, hours or days' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(NEW.config->'amount') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'durable wait amount must be a number' USING ERRCODE = '22023';
  END IF;
  v_amount := (NEW.config->>'amount')::numeric;
  v_mult := CASE v_unit WHEN 'seconds' THEN 1 WHEN 'minutes' THEN 60 WHEN 'hours' THEN 3600 ELSE 86400 END;
  IF v_amount < 1 OR v_amount <> trunc(v_amount) OR v_amount * v_mult > 2592000 THEN
    RAISE EXCEPTION 'durable wait must be a whole amount between 1 second and 30 days' USING ERRCODE = '22023';
  END IF;
  SELECT f.status INTO v_status FROM public.flows f WHERE f.id = NEW.flow_id;
  IF v_status = 'active' AND current_setting('app.allow_durable_wait_activation', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'durable waits cannot be added to an active flow: waiting is not enabled' USING ERRCODE = '0A000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER flow_nodes_guard_durable_wait
  BEFORE INSERT OR UPDATE ON public.flow_nodes
  FOR EACH ROW
  WHEN (NEW.node_type = 'delay' AND NEW.config ? 'unit')
  EXECUTE FUNCTION public.guard_durable_wait_node();

CREATE FUNCTION public.guard_durable_wait_activation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_setting('app.allow_durable_wait_activation', true) IS DISTINCT FROM 'on'
     AND EXISTS (SELECT 1 FROM public.flow_nodes n WHERE n.flow_id = NEW.id AND n.node_type = 'delay' AND n.config ? 'unit') THEN
    RAISE EXCEPTION 'flows with durable waits cannot be activated: waiting is not enabled' USING ERRCODE = '0A000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER flows_guard_durable_wait_activation
  BEFORE INSERT OR UPDATE OF status ON public.flows
  FOR EACH ROW
  WHEN (NEW.status = 'active')
  EXECUTE FUNCTION public.guard_durable_wait_activation();

REVOKE ALL ON FUNCTION public.guard_durable_wait_node() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_durable_wait_activation() FROM PUBLIC, anon, authenticated;
