-- READ-ONLY health of the order delivery to InkaClick. Only SELECTs. One line per check: <code> <count> <meaning>. A count > 0 on an alert line (O*) is a problem.
-- Thresholds (minutes) can be overridden with psql -v, e.g. -v late_min=10.
\set ON_ERROR_STOP on
\if :{?late_min}
\else
  \set late_min 5
\endif
\if :{?sending_min}
\else
  \set sending_min 5
\endif
\if :{?sent_min}
\else
  \set sent_min 10
\endif
\pset tuples_only on
\pset format unaligned
\pset fieldsep ' '
SELECT 'O1_failed', count(*), 'rejected by InkaClick (4xx): needs a person' FROM order_confirmations WHERE delivery_status = 'failed'
UNION ALL
SELECT 'O2_dead', count(*), 'attempts exhausted: needs a person' FROM order_confirmations WHERE delivery_status = 'dead'
UNION ALL
SELECT 'O3_pending_late', count(*), 'pending and due for more than ' || :late_min || ' min: is the cron running?'
  FROM order_confirmations WHERE delivery_status = 'pending' AND next_attempt_at < now() - make_interval(mins => :late_min)
UNION ALL
SELECT 'O4_sending_stuck', count(*), 'sending with a lease expired for more than ' || :sending_min || ' min'
  FROM order_confirmations WHERE delivery_status = 'sending' AND locked_until < now() - make_interval(mins => :sending_min)
UNION ALL
SELECT 'O5_sent_not_acknowledged', count(*), 'sent but not confirmed by InkaClick after ' || :sent_min || ' min'
  FROM order_confirmations WHERE delivery_status = 'sent' AND sent_at < now() - make_interval(mins => :sent_min)
UNION ALL
SELECT 'O6_held_touched', count(*), 'a held order that has attempts, a send time or deliveries: held orders must never be sent'
  FROM order_confirmations o WHERE o.delivery_status = 'held' AND (o.attempts > 0 OR o.sent_at IS NOT NULL OR EXISTS (SELECT 1 FROM order_confirmation_deliveries d WHERE d.order_id = o.id))
UNION ALL
SELECT 'O7_open_attempts_stale', count(*), 'delivery attempts still "started" for more than ' || :sending_min || ' min'
  FROM order_confirmation_deliveries WHERE outcome = 'started' AND started_at < now() - make_interval(mins => :sending_min)
UNION ALL
SELECT 'I_' || delivery_status, count(*), 'orders in this state (information, not an alert)' FROM order_confirmations GROUP BY delivery_status
UNION ALL
SELECT 'I_accounts_delivery_on', count(*), 'accounts with delivery enabled (information)' FROM order_integration_settings WHERE enabled
ORDER BY 1;
