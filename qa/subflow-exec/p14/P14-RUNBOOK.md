# P14 runbook: general availability of connected-flow execution

## What "enabled for everyone" means
Execution of subflows and durable waits needs **both** keys:
1. **Environment**: `FLOW_EXECUTION_SCOPE=all` (app environment file; changing it needs the app container to be recreated).
2. **Database**: the single row of `flow_execution_defaults` = `true/true`, changed only by a privileged operator.
A row in `flow_execution_enablement` for a company overrides the default **in both directions** (an explicit "off" row switches one company off; an "on" row switches it on even if the default is off). Authoring is separate: `FLOW_AUTHORING_SCOPE=all`.

## Enable (done 2026-10-15)
1. Back up the database and the environment file; record flows, nodes and run baselines.
2. Environment: add `FLOW_EXECUTION_SCOPE=all`, remove the two old per-company execution lists, recreate only the app container. Execution is still off at this point (database default false).
3. Database: `psql ... -1 -f p14/enable-p14.sql`.
4. Check: both cron endpoints answer 200 with `enabled:true`; no runs or messages appear; flows and nodes unchanged; the alert monitor stays at zero.

## Roll back (fastest first)
1. **Database, immediate, no restart:** `psql ... -v ON_ERROR_STOP=1 -1 -f p14/rollback-p14.sql`. It switches the default off, deletes "on" rows, **cancels every active run that uses the P6-P8 machinery** (waits, call stacks) without sending anything, and prints the ACTIVE flows that use the features (it never edits flows). Plain legacy runs are not touched. Deleting a row alone would NOT stop runs already parked.
2. **Kill switch for the environment (optional):** set `FLOW_EXECUTION_SCOPE=off` in the environment file and recreate the app container. The previous file is kept in the private backup folder.
3. Active flows that use the features stay active; while the switches are off each new trigger fails closed and ends as "not enabled". Review them by hand.
Rehearsed on a restored copy of production data: 3001 P8 runs cancelled, the call frame archived, flows, nodes, messages and 5 legacy active runs byte-identical before and after.

## Known limits / risks
- The one-minute scheduler resumes up to 25 due waits per pass (each pass is bounded by a 45 s budget). Many waits due at the same second drain over several minutes; the monitor alert A3 fires if a wait is overdue more than 5 minutes.
- The recovery job now also covers **legacy** runs: a run left on an automatic node by a crashed process is resumed after 5 minutes (before, it waited for the 24 h timeout). It never resends a message whose send was recorded as started but not confirmed; plain legacy flows record no such marker.
- Restarting the app strands runs that are mid-flight; deploy at a quiet moment.
