#!/usr/bin/env bash
# PR #30 audit fixes: each new control must catch the failure it was written to prevent. Every mutant must make the
# targeted checks FAIL; sources and functions are restored. Usage: scripts/sql/mutation-e42pr30.sh (own throwaway container)
#   Z01 repair needs an active run again          Z02 repair touches the run it repairs
#   Z03 altered number tried after a rejection    Z04 maxVariants > 1 brings the variants back
#   Z05 HTTP 429 is a definitive rejection again  Z06 claim ignores the persisted retry time
#   Z07 the backoff is 1 second (immediate retry) Z08 the interpreter stops deferring a retryable rejection
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/sql/qa-lib.sh
SENDER=src/lib/flows/versioned-meta-sender.ts; INTERP=src/lib/flows/versioned-interpreter.ts
B_SENDER="$(mktemp)"; B_INTERP="$(mktemp)"; cp "$SENDER" "$B_SENDER"; cp "$INTERP" "$B_INTERP"
restore() { cp "$B_SENDER" "$SENDER"; cp "$B_INTERP" "$INTERP"; rm -f "$B_SENDER" "$B_INTERP" "$LOG"; docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap restore EXIT
qa_start >/dev/null
qa_commit_fixtures
psql_q() { psql_ -At "$@"; }
PG=src/lib/flows/versioned-pr30-retry.pg.test.ts
UNIT="npx vitest run src/lib/flows/versioned-meta-sender.test.ts"
PGT() { QA_PG_CONTAINER="$NAME" npx vitest run "$PG" -t "$1"; }
SUITE() { { echo 'BEGIN;'; cat scripts/sql/e42b11-fixtures.sql scripts/sql/e42pr30-inbox-suite.sql scripts/sql/e42pr30-defer-suite.sql; echo 'ROLLBACK;'; } | psql_ -o /dev/null; }

mutate_ts() { # <file> <backup> <from> <to>
  cp "$2" "$1"
  python3 - "$1" "$3" "$4" <<'PY'
import sys
p, a, b = sys.argv[1:4]; s = open(p).read()
assert a in s, "mutation anchor not found: " + a
open(p, 'w').write(s.replace(a, b, 1))
PY
}
mutate_sql() { # <function signature regprocedure> <from> <to> -> installs the mutant, saves the original in /tmp/orig_fn.sql
  psql_q -c "select pg_get_functiondef('$1'::regprocedure)" > /tmp/orig_fn.sql
  python3 - "$2" "$3" <<'PY'
import sys
a, b = sys.argv[1:3]; s = open('/tmp/orig_fn.sql').read()
assert a in s, "SQL anchor not found: " + a
open('/tmp/mut_fn.sql', 'w').write(s.replace(a, b, 1))
PY
  psql_ -q < /tmp/mut_fn.sql >/dev/null
}
restore_sql() { psql_ -q < /tmp/orig_fn.sql >/dev/null; }
expect_failure() { local label="$1" id="$2"; shift 2
  if "$@" >/tmp/mutant.out 2>&1; then echo "MUTANT SURVIVED: $label"; exit 1; fi
  echo "QA-RESULT $id PASS mutant killed: $label ($(grep -cE '^ FAIL|×|ERROR:' /tmp/mutant.out) failing check(s))"; }

# Z01 / Z02: the repair
mutate_sql 'public.repair_versioned_run_inbox(uuid,uuid)' "v_run := public.lock_versioned_run(p_account_id, p_run_id);   -- FOR UPDATE on the run row; any status" "v_run := public.lock_versioned_run(p_account_id, p_run_id); IF v_run.status <> 'active' THEN RETURN; END IF;"
expect_failure "repair refuses runs that are no longer active" Z01 SUITE; restore_sql
mutate_sql 'public.repair_versioned_run_inbox(uuid,uuid)' "v_run := public.lock_versioned_run(p_account_id, p_run_id);   -- FOR UPDATE on the run row; any status" "v_run := public.lock_versioned_run(p_account_id, p_run_id); UPDATE public.flow_runs SET last_advanced_at = clock_timestamp() WHERE id = v_run.id;"
expect_failure "repair modifies the run it repairs" Z02 SUITE; restore_sql

# Z03 / Z04: recipients
mutate_ts "$SENDER" "$B_SENDER" "      return attemptOnce(http, base)" "      { const first = await attemptOnce(http, base); if (first.kind === 'rejected' && first.errorCode === 'recipient_not_allowed') return attemptOnce({ ...http, body: JSON.stringify({ ...JSON.parse(http.body), to: '0' + to }) }, base); return first }"
expect_failure "an altered number is tried after a rejection" Z03 $UNIT
mutate_ts "$SENDER" "$B_SENDER" "      return attemptOnce(http, base)" "      { const first = await attemptOnce(http, base); if ((options.maxVariants ?? 1) > 1 && first.kind === 'rejected') return attemptOnce({ ...http, body: JSON.stringify({ ...JSON.parse(http.body), to: to.slice(0, 2) + '0' + to.slice(2) }) }, base); return first }"
expect_failure "maxVariants > 1 re-enables alternative numbers" Z04 $UNIT
cp "$B_SENDER" "$SENDER"

# Z05: 429 fails the run again
mutate_ts "$SENDER" "$B_SENDER" "if (status === 429) return true" "if (status === 429) return false"
expect_failure "HTTP 429 is classified as a definitive rejection again" Z05 $UNIT
expect_failure "HTTP 429 fails the run (interpreter + Inbox + ledger)" Z05b PGT "R09/R10/R11"
cp "$B_SENDER" "$SENDER"

# Z06 / Z07: the persisted wait
mutate_sql 'public.claim_versioned_effect(uuid,uuid,text,integer,uuid)' "IF v_eff.retry_not_before IS NOT NULL AND v_eff.retry_not_before > clock_timestamp() THEN" "IF false AND v_eff.retry_not_before > clock_timestamp() THEN"
expect_failure "claim ignores the persisted retry time" Z06 SUITE
expect_failure "claim ignores the persisted retry time (interpreter)" Z06b PGT "R09/R10/R11"; restore_sql
mutate_sql 'public.defer_versioned_effect(uuid,uuid,text,integer,uuid,uuid,integer,text)' "v_wait := LEAST(900, 30 * (2 ^ LEAST(v_eff.attempt - 1, 5))::integer); v_source := 'backoff';" "v_wait := 1; v_source := 'backoff';"
expect_failure "the backoff collapses to one second" Z07 SUITE; restore_sql

# Z08: the interpreter stops deferring a retryable rejection (it falls into the generic settle mapping)
mutate_ts "$INTERP" "$B_INTERP" "if (outcome.kind === 'retryable_rejection') {" "if (false) {"
expect_failure "the interpreter no longer defers a retryable rejection" Z08 PGT "R09/R10/R11"
cp "$B_INTERP" "$INTERP"
echo "mutation check complete: every mutant was detected and the sources and functions were restored"
