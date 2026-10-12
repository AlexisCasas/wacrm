-- E4.2B1.2: lease, fencing and CAS for versioned flow runs. Additive only.
-- Server-only (service_role) primitives; no interpreter, no external sends.
--
-- Reused from 053: versioned_lease is the monotonic fencing token (bumped by
-- every acquire/reclaim, never by renew/release) and versioned_checkpoint is
-- the persisted cursor + step. New: lease owner, lease expiry (PostgreSQL
-- server clock) and versioned_revision, the CAS counter.
ALTER TABLE public.flow_runs
  ADD COLUMN versioned_lease_owner TEXT,
  ADD COLUMN versioned_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN versioned_revision BIGINT NOT NULL DEFAULT 0;

ALTER TABLE public.flow_runs
  ADD CONSTRAINT flow_runs_versioned_lease_shape CHECK (
    (versioned_lease_owner IS NULL) = (versioned_lease_expires_at IS NULL)
    AND (versioned_lease_owner IS NULL OR (execution_mode = 'versioned' AND length(versioned_lease_owner) BETWEEN 1 AND 200))
  ),
  ADD CONSTRAINT flow_runs_versioned_counters_check CHECK (versioned_lease >= 0 AND versioned_revision >= 0);

-- Defense in depth against buggy service-role writes: the fencing token and
-- revision never move backwards, and a versioned run that left 'active'
-- (paused, failed, completed...) can never be reactivated.
CREATE FUNCTION public.guard_versioned_run_integrity()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
BEGIN
  IF NEW.versioned_lease < OLD.versioned_lease OR NEW.versioned_revision < OLD.versioned_revision THEN
    RAISE EXCEPTION 'versioned fencing token and revision are monotonic' USING ERRCODE = '55000';
  END IF;
  IF OLD.execution_mode = 'versioned' AND OLD.status <> 'active' AND NEW.status = 'active' THEN
    RAISE EXCEPTION 'a non-active versioned run cannot be reactivated' USING ERRCODE = '55000';
  END IF;
  IF OLD.execution_mode IS DISTINCT FROM NEW.execution_mode THEN
    RAISE EXCEPTION 'execution_mode is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER flow_runs_versioned_integrity
  BEFORE UPDATE OF status, execution_mode, versioned_lease, versioned_revision ON public.flow_runs
  FOR EACH ROW EXECUTE FUNCTION public.guard_versioned_run_integrity();
REVOKE ALL ON FUNCTION public.guard_versioned_run_integrity() FROM PUBLIC;

-- Shared by the lease RPCs: validates arguments and locks the run row.
-- Versioned runs of the given account only; anything else (missing, other
-- account, legacy) is indistinguishable "not found".
CREATE FUNCTION public.lock_versioned_run(p_account_id UUID, p_run_id UUID)
RETURNS public.flow_runs LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE v_run public.flow_runs%ROWTYPE;
BEGIN
  IF p_account_id IS NULL OR p_run_id IS NULL THEN
    RAISE EXCEPTION 'invalid versioned run request' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_run FROM public.flow_runs
   WHERE id = p_run_id AND account_id = p_account_id AND execution_mode = 'versioned' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'versioned run not found' USING ERRCODE = 'P0002'; END IF;
  RETURN v_run;
END;
$$;
REVOKE ALL ON FUNCTION public.lock_versioned_run(UUID, UUID) FROM PUBLIC;

-- Acquire a lease on a run that has none. A lease that exists, live or
-- expired, is never taken here: live -> lease_held, expired -> use reclaim.
CREATE FUNCTION public.acquire_versioned_run_lease(
  p_account_id UUID, p_run_id UUID, p_owner TEXT, p_ttl_seconds INTEGER
)
RETURNS TABLE (acquired BOOLEAN, fencing_token INTEGER, lease_expires_at TIMESTAMPTZ, revision BIGINT, reason TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_run public.flow_runs%ROWTYPE; v_now TIMESTAMPTZ := clock_timestamp(); v_exp TIMESTAMPTZ;
BEGIN
  IF p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 200 OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'invalid versioned run request' USING ERRCODE = '22023';
  END IF;
  v_run := public.lock_versioned_run(p_account_id, p_run_id);
  IF v_run.status <> 'active' THEN
    RETURN QUERY SELECT false, v_run.versioned_lease, NULL::timestamptz, v_run.versioned_revision, 'run_not_active'; RETURN;
  END IF;
  IF v_run.versioned_lease_owner IS NOT NULL THEN
    RETURN QUERY SELECT false, v_run.versioned_lease, v_run.versioned_lease_expires_at, v_run.versioned_revision,
      CASE WHEN v_run.versioned_lease_expires_at > v_now THEN 'lease_held' ELSE 'lease_expired' END;
    RETURN;
  END IF;
  v_exp := v_now + make_interval(secs => p_ttl_seconds);
  UPDATE public.flow_runs SET versioned_lease = versioned_lease + 1, versioned_lease_owner = p_owner, versioned_lease_expires_at = v_exp
   WHERE id = v_run.id RETURNING versioned_lease INTO fencing_token;
  RETURN QUERY SELECT true, fencing_token, v_exp, v_run.versioned_revision, NULL::text;
END;
$$;

-- Take over an expired lease. Bumps the fencing token, so the previous owner's
-- token can no longer renew, release or commit.
CREATE FUNCTION public.reclaim_versioned_run_lease(
  p_account_id UUID, p_run_id UUID, p_owner TEXT, p_ttl_seconds INTEGER
)
RETURNS TABLE (acquired BOOLEAN, fencing_token INTEGER, lease_expires_at TIMESTAMPTZ, revision BIGINT, reason TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_run public.flow_runs%ROWTYPE; v_now TIMESTAMPTZ := clock_timestamp(); v_exp TIMESTAMPTZ;
BEGIN
  IF p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 200 OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'invalid versioned run request' USING ERRCODE = '22023';
  END IF;
  v_run := public.lock_versioned_run(p_account_id, p_run_id);
  IF v_run.status <> 'active' THEN
    RETURN QUERY SELECT false, v_run.versioned_lease, NULL::timestamptz, v_run.versioned_revision, 'run_not_active'; RETURN;
  END IF;
  IF v_run.versioned_lease_owner IS NULL THEN
    RETURN QUERY SELECT false, v_run.versioned_lease, NULL::timestamptz, v_run.versioned_revision, 'no_lease'; RETURN;
  END IF;
  IF v_run.versioned_lease_expires_at > v_now THEN
    RETURN QUERY SELECT false, v_run.versioned_lease, v_run.versioned_lease_expires_at, v_run.versioned_revision, 'lease_held'; RETURN;
  END IF;
  v_exp := v_now + make_interval(secs => p_ttl_seconds);
  UPDATE public.flow_runs SET versioned_lease = versioned_lease + 1, versioned_lease_owner = p_owner, versioned_lease_expires_at = v_exp
   WHERE id = v_run.id RETURNING versioned_lease INTO fencing_token;
  RETURN QUERY SELECT true, fencing_token, v_exp, v_run.versioned_revision, NULL::text;
END;
$$;

-- Extend a live lease. Requires the current owner and fencing token; an
-- expired lease cannot be renewed (it must be reclaimed).
CREATE FUNCTION public.renew_versioned_run_lease(
  p_account_id UUID, p_run_id UUID, p_owner TEXT, p_fencing_token INTEGER, p_ttl_seconds INTEGER
)
RETURNS TABLE (renewed BOOLEAN, lease_expires_at TIMESTAMPTZ, reason TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_run public.flow_runs%ROWTYPE; v_now TIMESTAMPTZ := clock_timestamp(); v_exp TIMESTAMPTZ;
BEGIN
  IF p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 200 OR p_fencing_token IS NULL OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'invalid versioned run request' USING ERRCODE = '22023';
  END IF;
  v_run := public.lock_versioned_run(p_account_id, p_run_id);
  IF v_run.status <> 'active' THEN RETURN QUERY SELECT false, NULL::timestamptz, 'run_not_active'; RETURN; END IF;
  IF v_run.versioned_lease_owner IS DISTINCT FROM p_owner OR v_run.versioned_lease <> p_fencing_token THEN
    RETURN QUERY SELECT false, NULL::timestamptz, 'stale_lease'; RETURN;
  END IF;
  IF v_run.versioned_lease_expires_at <= v_now THEN RETURN QUERY SELECT false, NULL::timestamptz, 'lease_expired'; RETURN; END IF;
  v_exp := v_now + make_interval(secs => p_ttl_seconds);
  UPDATE public.flow_runs SET versioned_lease_expires_at = v_exp WHERE id = v_run.id;
  RETURN QUERY SELECT true, v_exp, NULL::text;
END;
$$;

-- Give the lease up. Requires the current owner and token (live or lapsed but
-- not yet reclaimed). The fencing token is kept so it keeps growing. Works on
-- non-active runs too, so a paused run's lease can still be cleaned up.
CREATE FUNCTION public.release_versioned_run_lease(
  p_account_id UUID, p_run_id UUID, p_owner TEXT, p_fencing_token INTEGER
)
RETURNS TABLE (released BOOLEAN, reason TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_run public.flow_runs%ROWTYPE;
BEGIN
  IF p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 200 OR p_fencing_token IS NULL THEN
    RAISE EXCEPTION 'invalid versioned run request' USING ERRCODE = '22023';
  END IF;
  v_run := public.lock_versioned_run(p_account_id, p_run_id);
  IF v_run.versioned_lease_owner IS DISTINCT FROM p_owner OR v_run.versioned_lease <> p_fencing_token THEN
    RETURN QUERY SELECT false, 'stale_lease'; RETURN;
  END IF;
  UPDATE public.flow_runs SET versioned_lease_owner = NULL, versioned_lease_expires_at = NULL WHERE id = v_run.id;
  RETURN QUERY SELECT true, NULL::text;
END;
$$;

-- Commit one transition atomically: cursor columns, checkpoint, revision and
-- (optionally) a terminal status change in a single UPDATE. The cursor is
-- taken from p_checkpoint->'cursor' so cursor and checkpoint cannot diverge.
-- Conflict checks run in a fixed order and return a reason without writing:
-- run_not_active, stale_lease, lease_expired, revision_conflict. A terminal
-- p_status also releases the lease (the token is kept).
CREATE FUNCTION public.commit_versioned_run_transition(
  p_account_id UUID, p_run_id UUID, p_owner TEXT, p_fencing_token INTEGER,
  p_expected_revision BIGINT, p_checkpoint JSONB,
  p_status TEXT DEFAULT 'active', p_end_reason TEXT DEFAULT NULL
)
RETURNS TABLE (committed BOOLEAN, revision BIGINT, reason TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_run public.flow_runs%ROWTYPE; v_now TIMESTAMPTZ := clock_timestamp();
  v_ver UUID; v_node TEXT; v_def JSONB; v_new BIGINT; v_terminal BOOLEAN;
BEGIN
  IF p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 200 OR p_fencing_token IS NULL OR p_expected_revision IS NULL
     OR jsonb_typeof(p_checkpoint) IS DISTINCT FROM 'object' OR jsonb_typeof(p_checkpoint->'cursor') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_checkpoint->'step') IS DISTINCT FROM 'number'
     OR p_status IS NULL OR p_status NOT IN ('active', 'completed', 'handed_off', 'failed') THEN
    RAISE EXCEPTION 'invalid versioned run request' USING ERRCODE = '22023';
  END IF;
  v_run := public.lock_versioned_run(p_account_id, p_run_id);
  IF v_run.status <> 'active' THEN RETURN QUERY SELECT false, v_run.versioned_revision, 'run_not_active'; RETURN; END IF;
  IF v_run.versioned_lease_owner IS DISTINCT FROM p_owner OR v_run.versioned_lease <> p_fencing_token THEN
    RETURN QUERY SELECT false, v_run.versioned_revision, 'stale_lease'; RETURN;
  END IF;
  IF v_run.versioned_lease_expires_at <= v_now THEN RETURN QUERY SELECT false, v_run.versioned_revision, 'lease_expired'; RETURN; END IF;
  IF v_run.versioned_revision <> p_expected_revision THEN
    RETURN QUERY SELECT false, v_run.versioned_revision, 'revision_conflict'; RETURN;
  END IF;

  -- The target cursor must be a real node of a published version of this account.
  BEGIN
    v_ver := (p_checkpoint #>> '{cursor,flow_version_id}')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'invalid versioned run request' USING ERRCODE = '22023';
  END;
  v_node := p_checkpoint #>> '{cursor,node_key}';
  IF v_ver IS NULL OR v_node IS NULL OR (p_checkpoint->>'step')::numeric < 0 OR (p_checkpoint->>'step')::numeric <> trunc((p_checkpoint->>'step')::numeric) THEN
    RAISE EXCEPTION 'invalid versioned run request' USING ERRCODE = '22023';
  END IF;
  SELECT definition INTO v_def FROM public.flow_versions WHERE id = v_ver AND account_id = p_account_id;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_def->'nodes', '[]'::jsonb)) n WHERE n->>'node_key' = v_node) THEN
    RAISE EXCEPTION 'checkpoint cursor is not a node of a published version' USING ERRCODE = '22023';
  END IF;

  v_terminal := p_status <> 'active';
  UPDATE public.flow_runs SET
      versioned_checkpoint = p_checkpoint,
      current_flow_version_id = v_ver,
      versioned_node_key = v_node,
      current_node_key = v_node,
      versioned_revision = versioned_revision + 1,
      status = p_status,
      ended_at = CASE WHEN v_terminal THEN v_now ELSE ended_at END,
      end_reason = CASE WHEN v_terminal THEN p_end_reason ELSE end_reason END,
      versioned_lease_owner = CASE WHEN v_terminal THEN NULL ELSE versioned_lease_owner END,
      versioned_lease_expires_at = CASE WHEN v_terminal THEN NULL ELSE versioned_lease_expires_at END,
      last_advanced_at = v_now
    WHERE id = v_run.id RETURNING versioned_revision INTO v_new;
  RETURN QUERY SELECT true, v_new, NULL::text;
END;
$$;

DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.acquire_versioned_run_lease(UUID,UUID,TEXT,INTEGER)',
    'public.reclaim_versioned_run_lease(UUID,UUID,TEXT,INTEGER)',
    'public.renew_versioned_run_lease(UUID,UUID,TEXT,INTEGER,INTEGER)',
    'public.release_versioned_run_lease(UUID,UUID,TEXT,INTEGER)',
    'public.commit_versioned_run_transition(UUID,UUID,TEXT,INTEGER,BIGINT,JSONB,TEXT,TEXT)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
