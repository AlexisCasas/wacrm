-- ============================================================
-- 20261111000000_meta_capi_ad_results
--
-- Ad -> order attribution + Meta Conversions API (Business Messaging) queue + ad results report.
-- PURELY ADDITIVE: new tables and functions only. No existing table, column, policy, trigger or function is touched, so the previous
-- application image keeps working (image-only rollback; the new tables are then unused). Reversible with docs/integrations/meta-capi/ROLLBACK.sql.
--
-- NOTHING IS SENT TO META until (1) the process env META_CAPI_ENABLED=true AND (2) meta_capi_settings.enabled = TRUE for the account.
-- Both are OFF by default; no settings row is created for any existing account.
--
--   1. contact_ad_clicks      history of every Click-to-WhatsApp click that carried a ctwa_clid (contact_ad_attributions keeps only the FIRST one and is NOT changed).
--   2. meta_capi_settings     per-account switch + dataset/WABA/token. Token is stored encrypted (same AES-GCM scheme as whatsapp_config).
--   3. meta_capi_events       persistent queue, one row per (account, order, event). event_id is deterministic => no duplicates.
--   4. meta_capi_attempts     one row per send attempt: HTTP status, error code, sanitized detail. No tokens, no personal data.
--   5. order_ad_attribution() evidence-based order -> ad resolution (shared by the queue and the report).
--   6. meta_capi_enqueue / claim / finish / disable (service role only), ads_results_report (account members, RLS-respecting).
--
-- Events: only OrderCreated (order confirmed in WACRM) can be enabled. Purchase and OrderCanceled are locked OFF by CHECK constraints because
-- InkaClick does not yet expose a reliable paid/delivered/cancelled state (order_status is the constant 'Pedido confirmado').
-- ============================================================

-- 1) Click history ---------------------------------------------------------
CREATE TABLE public.contact_ad_clicks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL,
  ctwa_clid TEXT NOT NULL,
  source_id TEXT,
  source_url TEXT,
  headline TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT contact_ad_clicks_contact_fk
    FOREIGN KEY (contact_id, account_id) REFERENCES public.contacts (id, account_id) ON DELETE CASCADE,
  CONSTRAINT contact_ad_clicks_unique UNIQUE (account_id, contact_id, ctwa_clid)
);
CREATE INDEX idx_contact_ad_clicks_contact ON public.contact_ad_clicks (account_id, contact_id, captured_at DESC);

-- 2) Settings (OFF by default; no row for anyone) ---------------------------
CREATE TABLE public.meta_capi_settings (
  account_id UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  dataset_id TEXT,
  waba_id TEXT,
  access_token_enc TEXT,
  api_version TEXT NOT NULL DEFAULT 'v27.0',
  partner_agent TEXT NOT NULL DEFAULT 'wacrm',
  -- Events Manager "Test events" code. While set, every event is sent with it (test traffic, not counted as production). Clear it to go live.
  test_event_code TEXT,
  currency TEXT NOT NULL DEFAULT 'PEN',
  send_order_created BOOLEAN NOT NULL DEFAULT FALSE,
  send_purchase BOOLEAN NOT NULL DEFAULT FALSE,
  send_order_canceled BOOLEAN NOT NULL DEFAULT FALSE,
  max_click_age_days INTEGER NOT NULL DEFAULT 7,
  hourly_limit INTEGER NOT NULL DEFAULT 200,
  activated_at TIMESTAMPTZ,
  disabled_reason TEXT,
  disabled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT meta_capi_settings_ids CHECK (
    (dataset_id IS NULL OR dataset_id ~ '^[0-9]{6,25}$') AND (waba_id IS NULL OR waba_id ~ '^[0-9]{6,25}$')
  ),
  CONSTRAINT meta_capi_settings_version CHECK (api_version ~ '^v[0-9]{2}\.[0-9]$'),
  CONSTRAINT meta_capi_settings_test_code CHECK (test_event_code IS NULL OR test_event_code ~ '^[A-Za-z0-9_-]{1,64}$'),
  CONSTRAINT meta_capi_settings_currency CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT meta_capi_settings_limits CHECK (max_click_age_days BETWEEN 1 AND 90 AND hourly_limit BETWEEN 1 AND 2000),
  -- Switching on requires complete credentials and an explicit activation instant (only orders confirmed after it are ever reported).
  CONSTRAINT meta_capi_settings_complete CHECK (
    NOT enabled OR (dataset_id IS NOT NULL AND waba_id IS NOT NULL AND access_token_enc IS NOT NULL AND activated_at IS NOT NULL)
  ),
  -- Locked until InkaClick provides a reliable paid / delivered / cancelled status. Relaxing needs a new migration.
  CONSTRAINT meta_capi_settings_locked_events CHECK (NOT send_purchase AND NOT send_order_canceled)
);

-- 3) Queue ------------------------------------------------------------------
CREATE TABLE public.meta_capi_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  order_id UUID NOT NULL,
  contact_id UUID,
  event_name TEXT NOT NULL,
  event_id TEXT NOT NULL,
  ctwa_clid TEXT NOT NULL,
  source_id TEXT,
  event_time TIMESTAMPTZ NOT NULL,
  value NUMERIC(12,2),
  currency TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ,
  last_error_code TEXT,
  last_http_status INTEGER,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT meta_capi_events_order_fk FOREIGN KEY (order_id, account_id)
    REFERENCES public.order_confirmations (id, account_id) ON DELETE CASCADE,
  CONSTRAINT meta_capi_events_name CHECK (event_name IN ('OrderCreated', 'Purchase', 'OrderCanceled')),
  CONSTRAINT meta_capi_events_status CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'dead')),
  CONSTRAINT meta_capi_events_event_id UNIQUE (account_id, event_id),
  CONSTRAINT meta_capi_events_once UNIQUE (account_id, order_id, event_name)
);
CREATE INDEX idx_meta_capi_events_due ON public.meta_capi_events (next_attempt_at) WHERE status IN ('pending', 'sending');

CREATE TABLE public.meta_capi_attempts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_row_id UUID NOT NULL REFERENCES public.meta_capi_events(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  http_status INTEGER,
  error_code TEXT,
  detail TEXT CHECK (detail IS NULL OR char_length(detail) <= 300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_meta_capi_attempts_event ON public.meta_capi_attempts (event_row_id, attempt);
CREATE INDEX idx_meta_capi_attempts_account_time ON public.meta_capi_attempts (account_id, created_at);

-- RLS / grants: admins read settings (the encrypted token column is NOT granted to authenticated), agents read events; only service_role writes.
ALTER TABLE public.contact_ad_clicks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_capi_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_capi_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_capi_attempts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.contact_ad_clicks, public.meta_capi_settings, public.meta_capi_events, public.meta_capi_attempts FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.contact_ad_clicks, public.meta_capi_settings, public.meta_capi_events, public.meta_capi_attempts TO service_role;
GRANT SELECT ON TABLE public.contact_ad_clicks, public.meta_capi_events, public.meta_capi_attempts TO authenticated;
GRANT SELECT (account_id, enabled, dataset_id, waba_id, api_version, partner_agent, currency, send_order_created, send_purchase, send_order_canceled,
              test_event_code, max_click_age_days, hourly_limit, activated_at, disabled_reason, disabled_at, updated_at)
  ON public.meta_capi_settings TO authenticated;

CREATE POLICY contact_ad_clicks_select ON public.contact_ad_clicks FOR SELECT USING (public.is_account_member(account_id, 'agent'));
CREATE POLICY meta_capi_settings_select ON public.meta_capi_settings FOR SELECT USING (public.is_account_member(account_id, 'admin'));
CREATE POLICY meta_capi_events_select ON public.meta_capi_events FOR SELECT USING (public.is_account_member(account_id, 'admin'));
CREATE POLICY meta_capi_attempts_select ON public.meta_capi_attempts FOR SELECT USING (public.is_account_member(account_id, 'admin'));

-- 5) Evidence-based order -> ad resolution ------------------------------------
-- For each order with a contact: the most recent click (history, or the legacy first attribution) captured AT OR BEFORE the confirmation, optionally
-- no older than p_max_age_days. Orders with no such evidence are NOT returned (they are "sin atribución comprobable"). SECURITY INVOKER: RLS applies.
CREATE FUNCTION public.order_ad_attribution(p_account UUID, p_max_age_days INTEGER DEFAULT NULL)
RETURNS TABLE (order_id UUID, contact_id UUID, source_id TEXT, ctwa_clid TEXT, click_at TIMESTAMPTZ, basis TEXT)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT o.id, o.contact_id, c.source_id, c.ctwa_clid, c.captured_at, c.basis
  FROM public.order_confirmations o
  JOIN LATERAL (
    SELECT x.source_id, x.ctwa_clid, x.captured_at, x.basis FROM (
      SELECT k.source_id, k.ctwa_clid, k.captured_at, 'click_history'::TEXT AS basis
        FROM public.contact_ad_clicks k WHERE k.account_id = o.account_id AND k.contact_id = o.contact_id
      UNION ALL
      SELECT a.source_id, a.ctwa_clid, a.captured_at, 'first_attribution'::TEXT
        FROM public.contact_ad_attributions a WHERE a.account_id = o.account_id AND a.contact_id = o.contact_id
    ) x
    WHERE x.captured_at <= o.confirmed_at
      AND (p_max_age_days IS NULL OR x.captured_at >= o.confirmed_at - make_interval(days => p_max_age_days))
    ORDER BY x.captured_at DESC, (x.basis = 'click_history') DESC
    LIMIT 1
  ) c ON TRUE
  WHERE o.account_id = p_account AND o.contact_id IS NOT NULL;
$$;

-- 6) Queue functions (service role only) ---------------------------------------
CREATE FUNCTION public.meta_capi_enqueue(p_account UUID DEFAULT NULL, p_limit INTEGER DEFAULT 200)
RETURNS INTEGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  s RECORD;
  v_n INTEGER := 0;
  v_k INTEGER;
BEGIN
  FOR s IN SELECT * FROM public.meta_capi_settings
           WHERE enabled AND send_order_created AND activated_at IS NOT NULL AND (p_account IS NULL OR account_id = p_account)
  LOOP
    INSERT INTO public.meta_capi_events (account_id, order_id, contact_id, event_name, event_id, ctwa_clid, source_id, event_time, value, currency)
    SELECT o.account_id, o.id, o.contact_id, 'OrderCreated', 'wacrm:' || o.account_id || ':' || o.id || ':OrderCreated',
           a.ctwa_clid, a.source_id, o.confirmed_at, o.price, s.currency
    FROM public.order_confirmations o
    JOIN public.order_ad_attribution(s.account_id, s.max_click_age_days) a ON a.order_id = o.id
    WHERE o.account_id = s.account_id AND o.confirmed_at >= s.activated_at AND a.ctwa_clid IS NOT NULL
    ORDER BY o.confirmed_at
    LIMIT GREATEST(p_limit, 0)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_k = ROW_COUNT;
    v_n := v_n + v_k;
  END LOOP;
  RETURN v_n;
END $$;

CREATE FUNCTION public.meta_capi_claim(p_limit INTEGER DEFAULT 20, p_lease_seconds INTEGER DEFAULT 120, p_max_attempts INTEGER DEFAULT 6)
RETURNS TABLE (id UUID, account_id UUID, event_name TEXT, event_id TEXT, ctwa_clid TEXT, event_time TIMESTAMPTZ, value NUMERIC, currency TEXT,
               attempts INTEGER, dataset_id TEXT, waba_id TEXT, access_token_enc TEXT, api_version TEXT, partner_agent TEXT, test_event_code TEXT)
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH cand AS (
    SELECT e.id AS eid, e.account_id AS acc, e.created_at AS cat
    FROM public.meta_capi_events e
    JOIN public.meta_capi_settings s ON s.account_id = e.account_id AND s.enabled
         AND ((e.event_name = 'OrderCreated' AND s.send_order_created))
    WHERE ((e.status = 'pending') OR (e.status = 'sending' AND e.locked_until < NOW()))
      AND e.next_attempt_at <= NOW() AND e.attempts < p_max_attempts
    ORDER BY e.next_attempt_at
    LIMIT p_limit
    FOR UPDATE OF e SKIP LOCKED
  ), ranked AS (
    SELECT c.eid,
           ROW_NUMBER() OVER (PARTITION BY c.acc ORDER BY c.cat) AS rn,
           GREATEST(0, s.hourly_limit - (SELECT COUNT(*) FROM public.meta_capi_attempts t
                                          WHERE t.account_id = c.acc AND t.created_at > NOW() - INTERVAL '1 hour'))::INTEGER AS room
    FROM cand c JOIN public.meta_capi_settings s ON s.account_id = c.acc
  ), picked AS (
    SELECT r.eid FROM ranked r WHERE r.rn <= r.room
  ), upd AS (
    UPDATE public.meta_capi_events e
       SET status = 'sending', attempts = e.attempts + 1, locked_until = NOW() + make_interval(secs => p_lease_seconds), updated_at = NOW()
     WHERE e.id IN (SELECT eid FROM picked)
    RETURNING e.*
  )
  SELECT u.id, u.account_id, u.event_name, u.event_id, u.ctwa_clid, u.event_time, u.value, u.currency, u.attempts,
         s.dataset_id, s.waba_id, s.access_token_enc, s.api_version, s.partner_agent, s.test_event_code
  FROM upd u JOIN public.meta_capi_settings s ON s.account_id = u.account_id;
END $$;

-- p_outcome: sent | retry | rejected | auth. Stale leases (p_attempt <> attempts) are ignored. 'auth' (invalid/expired token) retries the event AND
-- switches the account off (circuit breaker) so a bad token cannot hammer Meta.
CREATE FUNCTION public.meta_capi_finish(
  p_event UUID, p_attempt INTEGER, p_outcome TEXT, p_http INTEGER, p_code TEXT, p_detail TEXT, p_retry_at TIMESTAMPTZ, p_max_attempts INTEGER DEFAULT 6
) RETURNS TEXT LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  e public.meta_capi_events%ROWTYPE;
  v_status TEXT;
BEGIN
  SELECT * INTO e FROM public.meta_capi_events WHERE id = p_event FOR UPDATE;
  IF NOT FOUND OR e.status <> 'sending' OR e.attempts <> p_attempt THEN RETURN 'stale'; END IF;

  INSERT INTO public.meta_capi_attempts (event_row_id, account_id, attempt, outcome, http_status, error_code, detail)
  VALUES (e.id, e.account_id, p_attempt, p_outcome, p_http, p_code, LEFT(p_detail, 300));

  IF p_outcome = 'sent' THEN v_status := 'sent';
  ELSIF p_outcome = 'rejected' THEN v_status := 'failed';
  ELSIF e.attempts >= p_max_attempts THEN v_status := 'dead';
  ELSE v_status := 'pending';
  END IF;

  UPDATE public.meta_capi_events SET
    status = v_status, locked_until = NULL, updated_at = NOW(),
    last_http_status = p_http, last_error_code = CASE WHEN p_outcome = 'sent' THEN NULL ELSE p_code END,
    sent_at = CASE WHEN v_status = 'sent' THEN NOW() ELSE sent_at END,
    next_attempt_at = CASE WHEN v_status = 'pending' THEN COALESCE(p_retry_at, NOW() + INTERVAL '5 minutes') ELSE next_attempt_at END
  WHERE id = e.id;

  IF p_outcome = 'auth' THEN PERFORM public.meta_capi_disable(e.account_id, 'auth_error'); END IF;
  RETURN v_status;
END $$;

-- Immediate kill switch for one account (also used by the circuit breaker). Queued events stay as they are.
CREATE FUNCTION public.meta_capi_disable(p_account UUID, p_reason TEXT DEFAULT 'manual')
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  UPDATE public.meta_capi_settings SET enabled = FALSE, disabled_reason = LEFT(p_reason, 100), disabled_at = NOW(), updated_at = NOW()
   WHERE account_id = p_account AND enabled;
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION public.meta_capi_enqueue(UUID, INTEGER), public.meta_capi_claim(INTEGER, INTEGER, INTEGER),
  public.meta_capi_finish(UUID, INTEGER, TEXT, INTEGER, TEXT, TEXT, TIMESTAMPTZ, INTEGER), public.meta_capi_disable(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.meta_capi_enqueue(UUID, INTEGER), public.meta_capi_claim(INTEGER, INTEGER, INTEGER),
  public.meta_capi_finish(UUID, INTEGER, TEXT, INTEGER, TEXT, TEXT, TIMESTAMPTZ, INTEGER), public.meta_capi_disable(UUID, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.order_ad_attribution(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.order_ad_attribution(UUID, INTEGER) TO authenticated, service_role;

-- 7) Ad results report ---------------------------------------------------------
-- One row per ad (source_id) plus ONE row with source_id NULL = confirmed orders with no verifiable ad evidence (never mixed into any ad).
-- contacts  = contacts whose first attribution was captured in [p_from, p_to)
-- orders    = distinct confirmed orders (confirmed_at in the period) resolved to the ad by order_ad_attribution (an order counts once)
-- buyers    = contacts of that ad's cohort that placed one of those orders
-- Amounts are ORDER totals (confirmed orders), NOT collected sales: there is no paid-status source yet.
CREATE FUNCTION public.ads_results_report(p_account UUID, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS TABLE (source_id TEXT, headline TEXT, contacts BIGINT, buyers BIGINT, orders BIGINT, order_amount NUMERIC, units BIGINT, products JSONB)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH guard AS (SELECT public.is_account_member(p_account, 'agent') AS ok),
  cohort AS (
    SELECT a.contact_id, COALESCE(a.source_id, '(sin id de anuncio)') AS source_id, a.headline FROM public.contact_ad_attributions a, guard
    WHERE guard.ok AND a.account_id = p_account AND a.captured_at >= p_from AND a.captured_at < p_to
  ),
  ords AS (
    SELECT o.id, o.contact_id, o.price,
           CASE WHEN att.order_id IS NULL THEN NULL ELSE COALESCE(att.source_id, '(sin id de anuncio)') END AS source_id
    FROM public.order_confirmations o
    LEFT JOIN public.order_ad_attribution(p_account) att ON att.order_id = o.id, guard
    WHERE guard.ok AND o.account_id = p_account AND o.confirmed_at >= p_from AND o.confirmed_at < p_to
  ),
  lines AS (
    SELECT i.order_id, i.product_name AS name, i.quantity AS qty FROM public.order_confirmation_items i WHERE i.account_id = p_account
    UNION ALL
    SELECT o.id, o.product, o.quantity FROM public.order_confirmations o
    WHERE o.account_id = p_account AND NOT EXISTS (SELECT 1 FROM public.order_confirmation_items i WHERE i.order_id = o.id)
  ),
  prod AS (
    SELECT x.source_id, jsonb_agg(jsonb_build_object('name', x.name, 'units', x.u) ORDER BY x.u DESC) AS products, SUM(x.u) AS units FROM (
      SELECT od.source_id, l.name, SUM(l.qty) AS u FROM ords od JOIN lines l ON l.order_id = od.id GROUP BY od.source_id, l.name
    ) x GROUP BY x.source_id
  ),
  ord_agg AS (
    SELECT od.source_id, COUNT(*) AS orders, SUM(od.price) AS amount FROM ords od GROUP BY od.source_id
  ),
  coh_agg AS (
    SELECT c.source_id, COUNT(DISTINCT c.contact_id) AS contacts, (array_agg(c.headline ORDER BY c.headline) FILTER (WHERE c.headline IS NOT NULL))[1] AS headline,
           COUNT(DISTINCT c.contact_id) FILTER (WHERE EXISTS (
             SELECT 1 FROM ords od WHERE od.contact_id = c.contact_id AND od.source_id IS NOT DISTINCT FROM c.source_id)) AS buyers
    FROM cohort c GROUP BY c.source_id
  )
  SELECT COALESCE(c.source_id, o.source_id), c.headline, COALESCE(c.contacts, 0), COALESCE(c.buyers, 0), COALESCE(o.orders, 0),
         COALESCE(o.amount, 0), COALESCE(p.units, 0)::BIGINT, COALESCE(p.products, '[]'::JSONB)
  FROM coh_agg c
  FULL OUTER JOIN ord_agg o ON COALESCE(o.source_id, '') = COALESCE(c.source_id, '')
  LEFT JOIN prod p ON COALESCE(p.source_id, '') = COALESCE(c.source_id, o.source_id, '')
  ORDER BY 6 DESC, 3 DESC;
$$;
REVOKE ALL ON FUNCTION public.ads_results_report(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ads_results_report(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;
