-- Dumps meta_ads_range_metrics for the 7/30/90 windows x account/campaign/adset/ad as the agent of A, as ONE jsonb document.
\set ON_ERROR_STOP on
CREATE FUNCTION qa.range_json(n int, lvl text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(to_jsonb(p) - 'synced_at'), '[]'::jsonb) FROM public.meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', n, DATE '2026-11-10' - n, DATE '2026-11-10' - 1, lvl) p
$$;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-0000000000a1', false);
SELECT jsonb_build_object('range', jsonb_build_object(
  '7', jsonb_build_object('account', qa.range_json(7,'account'), 'campaign', qa.range_json(7,'campaign'), 'adset', qa.range_json(7,'adset'), 'ad', qa.range_json(7,'ad')),
  '30', jsonb_build_object('account', qa.range_json(30,'account'), 'campaign', qa.range_json(30,'campaign'), 'adset', qa.range_json(30,'adset'), 'ad', qa.range_json(30,'ad')),
  '90', jsonb_build_object('account', qa.range_json(90,'account'), 'campaign', qa.range_json(90,'campaign'), 'adset', qa.range_json(90,'adset'), 'ad', qa.range_json(90,'ad'))));
RESET ROLE;
