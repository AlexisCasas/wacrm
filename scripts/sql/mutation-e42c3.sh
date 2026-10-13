#!/usr/bin/env bash
# E4.2C3.1 mutation check: the suite must notice (Y01) a timeout classified as not_dispatched, (Y02) an altered recipient
# number tried after a rejection, (Y03) Inbox persistence switched off, (Y04) a non-idempotent persist, and
# (Y05) an accepted message shown as delivered. Each mutant must make the targeted tests FAIL; sources are restored.
# Usage: scripts/sql/mutation-e42c3.sh   (starts its own throwaway container)
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/sql/qa-lib.sh
SENDER=src/lib/flows/versioned-meta-sender.ts
BACKUP="$(mktemp)"; cp "$SENDER" "$BACKUP"
restore() { cp "$BACKUP" "$SENDER"; rm -f "$BACKUP" "$LOG"; docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap restore EXIT
qa_start >/dev/null
qa_commit_fixtures
psql_q() { psql_ -At "$@"; }

mutate_sender() { # <from> <to>
  cp "$BACKUP" "$SENDER"
  python3 - "$SENDER" "$1" "$2" <<'PY'
import sys
p, a, b = sys.argv[1:4]
s = open(p).read()
assert a in s, "mutation anchor not found: " + a
open(p, 'w').write(s.replace(a, b, 1))
PY
}
expect_failure() { # <label> <id> <cmd...>
  local label="$1" id="$2"; shift 2
  if "$@" >/tmp/mutant.out 2>&1; then echo "MUTANT SURVIVED: $label"; exit 1; fi
  echo "QA-RESULT $id PASS mutant killed: $label ($(grep -cE '^ FAIL|×|ERROR:' /tmp/mutant.out) failing check(s))"
}
UNIT="npx vitest run src/lib/flows/versioned-meta-sender.test.ts"
PGT() { QA_PG_CONTAINER="$NAME" npx vitest run src/lib/flows/versioned-meta-sender.pg.test.ts -t "$1"; }
SQLSUITE() { { echo 'BEGIN;'; cat scripts/sql/e42b11-fixtures.sql scripts/sql/e42c31-suite.sql; echo 'ROLLBACK;'; } | psql_ -o /dev/null; }

# Y01: an in-flight transport failure (timeout, reset, lost response) is declared "never sent"
mutate_sender "      return { kind: 'ambiguous', errorCode: code.slice(0, 60) }" "      return { kind: 'not_dispatched', errorCode: code.slice(0, 60) }"
expect_failure "timeout / lost response classified as not_dispatched" Y01 $UNIT

# Y02: after a rejection of the original number an ALTERED number is tried (the unsafe legacy variant behaviour)
mutate_sender "      return attemptOnce(http, base)" "      { const first = await attemptOnce(http, base); if (first.kind === 'rejected' && first.errorCode === 'recipient_not_allowed') return attemptOnce({ ...http, body: JSON.stringify({ ...JSON.parse(http.body), to: '0' + to }) }, base); return first }"
expect_failure "an altered recipient number is tried after a rejection" Y02 $UNIT
cp "$BACKUP" "$SENDER"

# Y03: Inbox persistence switched off
psql_ -q -c "ALTER TABLE public.flow_run_effects DISABLE TRIGGER flow_run_effects_persist_message"
expect_failure "confirmed effects no longer reach the Inbox (SQL suite)" Y03 SQLSUITE
expect_failure "confirmed effects no longer reach the Inbox (interpreter + adapter)" Y03b PGT "N01/N02"
psql_ -q -c "ALTER TABLE public.flow_run_effects ENABLE TRIGGER flow_run_effects_persist_message"

# Y04: persist is not idempotent (the "already persisted" early return is removed)
DEF="$(psql_q -c "select pg_get_functiondef('public.persist_versioned_effect_message(uuid)'::regprocedure)")"
printf '%s' "$DEF" | python3 -c "
import sys
s = sys.stdin.read(); a = 'IF FOUND THEN RETURN v_existing; END IF;'
assert a in s
open('/tmp/mut_persist.sql', 'w').write(s.replace(a, '', 1))"
psql_ -q < /tmp/mut_persist.sql >/dev/null
expect_failure "persist is not idempotent" Y04 SQLSUITE
printf '%s' "$DEF" | psql_ -q >/dev/null

# Y05: an accepted message is shown as delivered
printf '%s' "$DEF" | python3 -c "
import sys
s = sys.stdin.read(); a = \"e.provider_message_id, 'sent')\"
assert a in s
open('/tmp/mut_persist.sql', 'w').write(s.replace(a, \"e.provider_message_id, 'delivered')\", 1))"
psql_ -q < /tmp/mut_persist.sql >/dev/null
expect_failure "accepted message shown as delivered" Y05 SQLSUITE
printf '%s' "$DEF" | psql_ -q >/dev/null
echo "mutation check complete: every mutant was detected and the sources were restored"
