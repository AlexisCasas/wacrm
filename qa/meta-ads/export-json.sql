-- Dumps meta_ads_performance for 7/30/90 x campaign/adset/ad as the agent of A, as ONE json document (numeric stays a JSON number, like PostgREST).
\set ON_ERROR_STOP on
CREATE FUNCTION qa.perf_json(n int, lvl text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(p), '[]'::jsonb) FROM public.meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', DATE '2026-11-10' - n, DATE '2026-11-10' - 1, lvl) p
$$;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-0000000000a1', false);
SELECT jsonb_build_object(
  'today', '2026-11-10',
  'windows', jsonb_build_object('7', jsonb_build_object('since', DATE '2026-11-10' - 7, 'until', DATE '2026-11-10' - 1), '30', jsonb_build_object('since', DATE '2026-11-10' - 30, 'until', DATE '2026-11-10' - 1), '90', jsonb_build_object('since', DATE '2026-11-10' - 90, 'until', DATE '2026-11-10' - 1)),
  'perf', jsonb_build_object(
    '7', jsonb_build_object('campaign', qa.perf_json(7,'campaign'), 'adset', qa.perf_json(7,'adset'), 'ad', qa.perf_json(7,'ad')),
    '30', jsonb_build_object('campaign', qa.perf_json(30,'campaign'), 'adset', qa.perf_json(30,'adset'), 'ad', qa.perf_json(30,'ad')),
    '90', jsonb_build_object('campaign', qa.perf_json(90,'campaign'), 'adset', qa.perf_json(90,'adset'), 'ad', qa.perf_json(90,'ad'))));
RESET ROLE;
