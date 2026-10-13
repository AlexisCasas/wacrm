#!/usr/bin/env bash
# PR #30 audit round 2 (migrations 063 + 064): each new control must catch the failure it was written to prevent. Every
# mutant must make the targeted checks FAIL; sources and functions are restored. Usage: scripts/sql/mutation-e42pr30-round2.sh
#   Z09 a throttle code on HTTP 5xx / 408 is retryable again   Z10 the late Inbox repair stores A at repair time
#   Z11 the late repair replaces the preview unconditionally   Z12 an equal timestamp replaces the preview
#   Z13 Retry-After is clamped to a day again (adapter)        Z14 the database honours only up to a day again
#   Z15 an over-long Retry-After falls back to the backoff     Z16 the interpreter no longer fails an over-long Retry-After
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
UNIT="npx vitest run src/lib/flows/versioned-meta-sender.test.ts"
PGT() { QA_PG_CONTAINER="$NAME" npx vitest run "$1" -t "$2"; }
SUITE() { { echo 'BEGIN;'; cat scripts/sql/e42b11-fixtures.sql scripts/sql/e42pr30-defer-suite.sql scripts/sql/e42pr30-audit2-suite.sql; echo 'ROLLBACK;'; } | psql_ -o /dev/null; }
CONC() { "$SQL/e42pr30-audit2-concurrency.sh" "$NAME"; }

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
  echo "QA-RESULT $id PASS mutant killed: $label ($(grep -cE '^ FAIL|×|ERROR:|FAIL' /tmp/mutant.out) failing check(s))"; }

PERSIST='public.persist_versioned_effect_message(uuid)'
DEFER='public.defer_versioned_effect(uuid,uuid,text,integer,uuid,uuid,integer,text)'
A2=src/lib/flows/versioned-pr30-audit2.pg.test.ts; RT=src/lib/flows/versioned-pr30-retry.pg.test.ts

# Z09: a throttle code on any status is retryable again
mutate_ts "$SENDER" "$B_SENDER" "const definitiveVerdict = status >= 400 && status < 500 && status !== 408" "const definitiveVerdict = true"
expect_failure "a throttle code on HTTP 5xx / 408 is retryable again (unit)" Z09 $UNIT
expect_failure "a throttle code on HTTP 5xx / 408 is retryable again (database)" Z09b PGT "$RT" "R21/R22"
cp "$B_SENDER" "$SENDER"

# Z10 / Z11 / Z12: the late Inbox repair
mutate_sql "$PERSIST" "e.provider_message_id, 'sent', e.finished_at)" "e.provider_message_id, 'sent', clock_timestamp())"
expect_failure "A is stored at repair time (sorts after B)" Z10 SUITE
expect_failure "A is stored at repair time (Meta simulation)" Z10b PGT "$A2" "R23"; restore_sql
mutate_sql "$PERSIST" "AND (c.last_message_at IS NULL OR c.last_message_at < e.finished_at)" "AND true"
expect_failure "the late repair replaces the preview unconditionally" Z11 SUITE
expect_failure "the late repair replaces the preview unconditionally (races)" Z11b CONC
expect_failure "the late repair replaces the preview unconditionally (Meta simulation)" Z11c PGT "$A2" "R23"; restore_sql
mutate_sql "$PERSIST" "c.last_message_at < e.finished_at)" "c.last_message_at <= e.finished_at)"
expect_failure "an equal timestamp replaces the existing preview" Z12 SUITE; restore_sql

# Z13: the adapter clamps Retry-After to a day again
mutate_ts "$SENDER" "$B_SENDER" "return Math.min(seconds, MAX_INT32_SECONDS)" "return Math.min(seconds, 86400)"
expect_failure "Retry-After is clamped to a day again (unit)" Z13 $UNIT
expect_failure "Retry-After is clamped to a day again (database)" Z13b PGT "$A2" "R24/R25"
cp "$B_SENDER" "$SENDER"

# Z14 / Z15: the database function
mutate_sql "$DEFER" "p_retry_after_seconds BETWEEN 1 AND 604800" "p_retry_after_seconds BETWEEN 1 AND 86400"
expect_failure "the database honours only up to a day again" Z14 SUITE; restore_sql
mutate_sql "$DEFER" "IF p_retry_after_seconds > 604800 THEN" "IF false THEN"
expect_failure "an over-long Retry-After silently falls back to the short backoff" Z15 SUITE
restore_sql   # (no Node-level mutant: the interpreter's own pre-check (Z16) masks this guard on that path, which is deliberate defence in depth)

# Z16: the interpreter's own limit
mutate_ts "$INTERP" "$B_INTERP" "else if (outcome.retryAfterSeconds !== undefined && outcome.retryAfterSeconds > MAX_DEFER_SECONDS) {" "else if (false) {"
expect_failure "the interpreter no longer fails an over-long Retry-After" Z16 PGT "$A2" "R24/R25"
cp "$B_INTERP" "$INTERP"
echo "mutation check complete: every mutant was detected and the sources and functions were restored"
