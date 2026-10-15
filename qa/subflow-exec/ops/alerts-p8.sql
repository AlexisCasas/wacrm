-- READ-ONLY alerts for the P6-P8 machinery. Writes nothing. Not scheduled; run by hand or from a monitor.
--   psql -At -F '|' -v hours=24 -v ignore_runs="''" -f alerts-p8.sql        (ignore_runs: SQL list of run ids already documented, e.g. "'d3408025-…'")
-- Output: one line per alert: CODE|count|sample ids. Every count should be 0.
WITH p AS (SELECT now() - make_interval(hours => :hours) AS since)
SELECT 'A1_send_outcome_unknown' AS alert, count(*)::int AS n, coalesce(string_agg(left(r.id::text, 8), ',' ORDER BY r.ended_at DESC) FILTER (WHERE true), '') AS sample
  FROM public.flow_runs r, p WHERE r.end_reason = 'send_outcome_unknown' AND r.ended_at > p.since AND r.id::text NOT IN (:ignore_runs)
UNION ALL
SELECT 'A2_recovery_not_safe', count(*)::int, coalesce(string_agg(left(r.id::text, 8), ','), '')
  FROM public.flow_runs r, p WHERE r.end_reason = 'recovery_not_safe' AND r.ended_at > p.since AND r.id::text NOT IN (:ignore_runs)
UNION ALL
-- a wait is overdue when it has been due for more than 5 minutes and nobody holds a live claim on it (the scheduler runs every minute, lease 300 s)
SELECT 'A3_overdue_wait_not_resumed', count(*)::int, coalesce(string_agg(left(r.id::text, 8), ','), '')
  FROM public.flow_runs r WHERE r.status = 'active' AND r.wait_until IS NOT NULL AND r.wait_until < now() - interval '5 minutes'
   AND (r.wait_claim_token IS NULL OR r.wait_claimed_at < now() - interval '10 minutes') AND r.id::text NOT IN (:ignore_runs)
UNION ALL
SELECT 'A4_frames_on_ended_runs', count(*)::int, coalesce(string_agg(DISTINCT left(f.flow_run_id::text, 8), ','), '')
  FROM public.flow_run_subflow_frames f JOIN public.flow_runs r ON r.id = f.flow_run_id WHERE r.status <> 'active' AND r.id::text NOT IN (:ignore_runs)
UNION ALL
-- active, not waiting, quiet for 30 minutes, standing on a node that advances by itself: a run a dead process left behind that recovery did not take
SELECT 'A5_stranded_run_not_recovered', count(*)::int, coalesce(string_agg(left(r.id::text, 8), ','), '')
  FROM public.flow_runs r JOIN public.flow_nodes n ON n.flow_id = coalesce(r.current_flow_id, r.flow_id) AND n.node_key = r.current_node_key
 WHERE r.status = 'active' AND r.wait_until IS NULL AND r.last_advanced_at < now() - interval '30 minutes'
   AND n.node_type IN ('start', 'send_message', 'send_media', 'condition', 'set_tag', 'set_contact_field', 'execute_flow') AND r.id::text NOT IN (:ignore_runs)
UNION ALL
SELECT 'A6_run_inside_flow_that_is_not_active', count(*)::int, coalesce(string_agg(left(r.id::text, 8), ','), '')
  FROM public.flow_runs r JOIN public.flows f ON f.id = r.current_flow_id WHERE r.status = 'active' AND f.status <> 'active' AND r.id::text NOT IN (:ignore_runs)
ORDER BY 1;
