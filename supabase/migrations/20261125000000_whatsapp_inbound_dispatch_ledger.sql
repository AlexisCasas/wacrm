-- F3: durable "intent to dispatch" ledger for inbound WhatsApp messages.
--
-- Problem: the processor stores the inbound message and only afterwards starts Flows / automations / AI reply / public webhooks.
-- If the process dies in between, Meta (or the durable inbox) replays the event, the message insert reports a duplicate and the
-- processor returns early: the message is in the Inbox but nothing was ever dispatched.
--
-- Design: a write-ahead row keyed (account_id, wamid) is created BEFORE the message insert, so "message exists" implies "ledger row
-- exists" for every message handled after this migration. Each dispatch step moves pending -> started -> done. A resume re-runs only
-- steps still `pending`. A step found `started` (the process died mid-step: outcome unknown) is re-run ONLY when the database shows no
-- trace of it; otherwise (or for steps with external effects that cannot be checked: AI reply, public webhooks) it is marked
-- `reconcile` and NEVER repeated automatically.
-- Additive: new table + functions only. Touches no existing object. Service-role only.
CREATE TABLE IF NOT EXISTS public.inbound_dispatch_ledger (
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  wamid text NOT NULL CHECK (length(wamid) BETWEEN 1 AND 256),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'completed', 'needs_reconciliation', 'failed')),
  is_first_inbound boolean NOT NULL,
  contact_created boolean NOT NULL,
  flow_consumed boolean,
  steps jsonb NOT NULL DEFAULT '{"flows":"pending","automations":"pending","ai":"pending","webhook":"pending"}'::jsonb,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_token uuid,
  lease_until timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code) <= 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (account_id, wamid)
);
CREATE INDEX IF NOT EXISTS inbound_dispatch_ledger_open_idx
  ON public.inbound_dispatch_ledger (updated_at) WHERE state IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS inbound_dispatch_ledger_review_idx
  ON public.inbound_dispatch_ledger (updated_at) WHERE state IN ('needs_reconciliation', 'failed');
CREATE INDEX IF NOT EXISTS inbound_dispatch_ledger_done_idx
  ON public.inbound_dispatch_ledger (completed_at) WHERE state = 'completed';

ALTER TABLE public.inbound_dispatch_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inbound_dispatch_ledger FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inbound_dispatch_ledger TO service_role;

-- Create the intent. Returns true when THIS call created it (a message first seen now), false when it already existed.
CREATE OR REPLACE FUNCTION public.inbound_dispatch_begin(p_account uuid, p_wamid text, p_first boolean, p_created boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_rows integer;
BEGIN
  INSERT INTO public.inbound_dispatch_ledger (account_id, wamid, is_first_inbound, contact_created)
  VALUES (p_account, p_wamid, COALESCE(p_first, false), COALESCE(p_created, false))
  ON CONFLICT (account_id, wamid) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END $$;

-- A message that already existed before its ledger row (legacy / replay of an old message): record it as handled, never dispatch.
CREATE OR REPLACE FUNCTION public.inbound_dispatch_skip_legacy(p_account uuid, p_wamid text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  UPDATE public.inbound_dispatch_ledger
  SET state = 'completed', completed_at = now(), updated_at = now(), last_error_code = 'legacy_message',
      steps = '{"flows":"skipped","automations":"skipped","ai":"skipped","webhook":"skipped"}'::jsonb
  WHERE account_id = p_account AND wamid = p_wamid AND state = 'pending' AND attempts = 0;
  RETURN FOUND;
END $$;

-- Take ownership of the fan-out. One row out: outcome = claimed | completed | busy | reconcile | failed | missing.
-- Expired leases are recoverable; after 5 claims the row is parked as failed (visible, never silently retried forever).
CREATE OR REPLACE FUNCTION public.inbound_dispatch_claim(p_account uuid, p_wamid text)
RETURNS TABLE(outcome text, token uuid, steps jsonb, is_first_inbound boolean, contact_created boolean, flow_consumed boolean, attempts integer, created_at timestamptz)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE r public.inbound_dispatch_ledger%ROWTYPE; v_token uuid;
BEGIN
  SELECT * INTO r FROM public.inbound_dispatch_ledger l WHERE l.account_id = p_account AND l.wamid = p_wamid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'missing'::text, NULL::uuid, NULL::jsonb, NULL::boolean, NULL::boolean, NULL::boolean, NULL::integer, NULL::timestamptz; RETURN;
  END IF;
  IF r.state = 'completed' THEN outcome := 'completed';
  ELSIF r.state = 'needs_reconciliation' THEN outcome := 'reconcile';
  ELSIF r.state = 'failed' THEN outcome := 'failed';
  ELSIF r.state = 'processing' AND r.lease_until >= now() THEN outcome := 'busy';
  ELSIF r.attempts >= 5 THEN
    UPDATE public.inbound_dispatch_ledger l SET state = 'failed', claim_token = NULL, lease_until = NULL,
      last_error_code = 'attempts_exhausted', updated_at = now(), completed_at = now()
    WHERE l.account_id = p_account AND l.wamid = p_wamid;
    outcome := 'failed';
  ELSE
    v_token := gen_random_uuid();
    UPDATE public.inbound_dispatch_ledger l SET state = 'processing', attempts = l.attempts + 1, claim_token = v_token,
      lease_until = now() + interval '180 seconds', updated_at = now()
    WHERE l.account_id = p_account AND l.wamid = p_wamid
    RETURNING * INTO r;
    outcome := 'claimed';
  END IF;
  RETURN QUERY SELECT outcome, v_token, r.steps, r.is_first_inbound, r.contact_created, r.flow_consumed, r.attempts, r.created_at;
END $$;

-- Fenced step transition (also extends the lease). Allowed: pending->started, started->done|reconcile, pending->done|skipped.
CREATE OR REPLACE FUNCTION public.inbound_dispatch_step(p_account uuid, p_wamid text, p_token uuid, p_step text, p_status text, p_flow_consumed boolean DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF p_step NOT IN ('flows', 'automations', 'ai', 'webhook') OR p_status NOT IN ('started', 'done', 'skipped', 'reconcile') THEN
    RAISE EXCEPTION 'invalid ledger step' USING ERRCODE = '22023';
  END IF;
  UPDATE public.inbound_dispatch_ledger l
  SET steps = jsonb_set(l.steps, ARRAY[p_step], to_jsonb(p_status)),
      flow_consumed = COALESCE(p_flow_consumed, l.flow_consumed),
      lease_until = now() + interval '180 seconds', updated_at = now()
  WHERE l.account_id = p_account AND l.wamid = p_wamid AND l.claim_token = p_token AND l.state = 'processing';
  RETURN FOUND;
END $$;

-- Close the ledger row. Any step left in `reconcile` makes the row needs_reconciliation (kept, never pruned, never re-run).
CREATE OR REPLACE FUNCTION public.inbound_dispatch_finish(p_account uuid, p_wamid text, p_token uuid)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_state text;
BEGIN
  UPDATE public.inbound_dispatch_ledger l
  SET state = CASE WHEN l.steps::text LIKE '%"reconcile"%' THEN 'needs_reconciliation' ELSE 'completed' END,
      claim_token = NULL, lease_until = NULL, completed_at = now(), updated_at = now()
  WHERE l.account_id = p_account AND l.wamid = p_wamid AND l.claim_token = p_token AND l.state = 'processing'
  RETURNING l.state INTO v_state;
  RETURN v_state;
END $$;

-- Hand the row back after a handled error so the next retry can claim it immediately.
CREATE OR REPLACE FUNCTION public.inbound_dispatch_release(p_account uuid, p_wamid text, p_token uuid, p_error text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  UPDATE public.inbound_dispatch_ledger l
  SET state = 'pending', claim_token = NULL, lease_until = NULL, last_error_code = left(COALESCE(p_error, 'released'), 64), updated_at = now()
  WHERE l.account_id = p_account AND l.wamid = p_wamid AND l.claim_token = p_token AND l.state = 'processing';
  RETURN FOUND;
END $$;

-- Does the database already show a trace of a step that was left `started`? Only Flows and automations can be checked;
-- AI replies and public webhooks cannot, so they always answer true (= reconcile, never repeat).
CREATE OR REPLACE FUNCTION public.inbound_dispatch_has_trace(p_account uuid, p_wamid text, p_contact uuid, p_step text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_since timestamptz;
BEGIN
  SELECT l.created_at INTO v_since FROM public.inbound_dispatch_ledger l WHERE l.account_id = p_account AND l.wamid = p_wamid;
  IF v_since IS NULL THEN RETURN true; END IF;
  IF p_step = 'flows' THEN
    RETURN EXISTS (SELECT 1 FROM public.flow_runs r WHERE r.account_id = p_account AND r.contact_id = p_contact AND (r.started_at >= v_since OR r.last_advanced_at >= v_since))
        OR EXISTS (SELECT 1 FROM public.flow_run_events e JOIN public.flow_runs r ON r.id = e.flow_run_id
                   WHERE r.account_id = p_account AND r.contact_id = p_contact AND e.created_at >= v_since);
  ELSIF p_step = 'automations' THEN
    RETURN EXISTS (SELECT 1 FROM public.automation_logs a WHERE a.account_id = p_account AND a.contact_id = p_contact AND a.created_at >= v_since);
  END IF;
  RETURN true;
END $$;

-- Retention: only finished-and-clean rows expire (14 days). pending / processing / needs_reconciliation / failed are never pruned.
CREATE OR REPLACE FUNCTION public.inbound_dispatch_prune(p_limit integer DEFAULT 200)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  WITH old AS (
    SELECT l.account_id, l.wamid FROM public.inbound_dispatch_ledger l
    WHERE l.state = 'completed' AND l.completed_at < now() - interval '14 days'
    ORDER BY l.completed_at LIMIT LEAST(1000, GREATEST(1, COALESCE(p_limit, 200)))
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.inbound_dispatch_ledger l USING old WHERE l.account_id = old.account_id AND l.wamid = old.wamid;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.inbound_dispatch_begin(uuid,text,boolean,boolean),
  public.inbound_dispatch_skip_legacy(uuid,text),
  public.inbound_dispatch_claim(uuid,text),
  public.inbound_dispatch_step(uuid,text,uuid,text,text,boolean),
  public.inbound_dispatch_finish(uuid,text,uuid),
  public.inbound_dispatch_release(uuid,text,uuid,text),
  public.inbound_dispatch_has_trace(uuid,text,uuid,text),
  public.inbound_dispatch_prune(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inbound_dispatch_begin(uuid,text,boolean,boolean),
  public.inbound_dispatch_skip_legacy(uuid,text),
  public.inbound_dispatch_claim(uuid,text),
  public.inbound_dispatch_step(uuid,text,uuid,text,text,boolean),
  public.inbound_dispatch_finish(uuid,text,uuid),
  public.inbound_dispatch_release(uuid,text,uuid,text),
  public.inbound_dispatch_has_trace(uuid,text,uuid,text),
  public.inbound_dispatch_prune(integer) TO service_role;
