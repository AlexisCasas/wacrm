-- SYNC-03A · Canonical financial snapshot for WACRM.
-- READ MODEL ONLY. No business writes, no triggers, no HTTP and no event emission.
-- IMPORTANT: no order_financials row means NOT TRACKED, not "paid = 0".
CREATE OR REPLACE VIEW public.order_sync_financial_snapshot AS
SELECT
  o.id AS canonical_order_id,
  'wacrm'::text AS source_system,
  o.price::numeric(12,2) AS total,
  f.paid_confirmed::numeric(12,2) AS paid_confirmed,
  CASE
    WHEN f.order_id IS NULL THEN NULL
    ELSE GREATEST(o.price - f.paid_confirmed, 0)::numeric(12,2)
  END AS balance,
  CASE
    WHEN f.order_id IS NULL THEN 'not_tracked'::text
    ELSE f.financial_status
  END AS financial_status,
  (f.order_id IS NOT NULL) AS tracked
FROM public.order_confirmations o
LEFT JOIN public.order_financials f ON f.order_id = o.id AND f.account_id = o.account_id;

REVOKE ALL ON public.order_sync_financial_snapshot FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.order_sync_financial_snapshot TO service_role;
