-- CALL-03B2.6 manual QA-only historical projection.
-- Read-only aggregate, no row payloads. NOT part of the empty-DB CI.
-- Before QA migration, compare with the original phase2b/hist.sql verbatim.
-- New nullable reservation columns alter to_jsonb(s) even without any data
-- change. Drop ONLY those new keys before applying the original MD5 formula.

WITH historical AS (
  SELECT *
  FROM public.whatsapp_call_sessions
  ORDER BY created_at ASC, id ASC
  LIMIT 18
),
canonical AS (
  SELECT s.id,
    (to_jsonb(s) - ARRAY[
      'terminal_request_id', 'terminal_action', 'terminal_actor_user_id',
      'terminal_status', 'terminal_reserved_at', 'terminal_updated_at',
      'signal_request_id', 'signal_action', 'signal_status',
      'signal_actor_user_id', 'signal_claimed_at', 'signal_reserved_at',
      'signal_updated_at'
    ]::text[])::text AS row_json
  FROM historical s
),
aggregate AS (
  SELECT count(*)::integer AS historical_count,
    md5(string_agg(row_json, '|' ORDER BY id)) AS historical_md5
  FROM canonical
)
SELECT historical_count, historical_md5,
  CASE WHEN historical_count=18
    AND historical_md5='2c0040780134cab5a7c807b6063ee090'
    THEN 'PASS'
    ELSE 'BLOCKED_VERIFY_CANONICALIZATION_AGAINST_PHASE2B_HIST_SQL'
  END AS qa_historical_integrity
FROM aggregate;
