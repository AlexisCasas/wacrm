#!/usr/bin/env bash
# E4.2C2 mutation check: proves the suite notices (1) a duplicate send after an abandoned claim, (2) an advance
# past an AMBIGUOUS effect (interpreter bug combined with the SQL guard removed), (3) an automatic resend after
# an ambiguous answer. Each mutant must make the targeted tests FAIL; the sources are restored afterwards.
# Usage: scripts/sql/mutation-e42c2.sh   (starts its own throwaway container)
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/sql/qa-lib.sh
INTERP=src/lib/flows/versioned-interpreter.ts
BACKUP="$(mktemp)"; cp "$INTERP" "$BACKUP"
restore() { cp "$BACKUP" "$INTERP"; rm -f "$BACKUP" "$LOG"; docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap restore EXIT
qa_start >/dev/null
qa_commit_fixtures
psql_q() { psql_ -At "$@"; }
TEST=src/lib/flows/versioned-messaging.pg.test.ts

mutate_interp() { # <from> <to>
  cp "$BACKUP" "$INTERP"
  python3 - "$INTERP" "$1" "$2" <<'PY'
import sys
p, a, b = sys.argv[1:4]
s = open(p).read()
assert a in s, "mutation anchor not found: " + a
open(p, 'w').write(s.replace(a, b, 1))
PY
}
expect_failure() { # <label> <test name pattern>
  if QA_PG_CONTAINER="$NAME" npx vitest run "$TEST" -t "$2" >/tmp/mutant.out 2>&1; then
    echo "MUTANT SURVIVED: $1"; exit 1
  else
    echo "QA-RESULT $3 PASS mutant killed: $1 ($(grep -cE '^ FAIL|×' /tmp/mutant.out) failing test(s))"
  fi
}

# 1. a claim left by someone else is treated as ours, so the interpreter sends again
mutate_interp "const mine = effect.claimed_owner === owner && effect.claimed_fencing_token === token && !!effect.attempt_id" "const mine = !!effect.attempt_id"
expect_failure "send of a claim that belongs to someone else" "M22" X01

# 3. an ambiguous answer is treated like not_dispatched: automatic resolve(not_sent) and resend
mutate_interp "if (outcome.kind === 'not_dispatched') {" "if (outcome.kind === 'not_dispatched' || outcome.kind === 'ambiguous') {"
expect_failure "automatic resend after an ambiguous answer" "M05/M06/M07" X03

# 2. advance past an ambiguous effect: the interpreter treats it as confirmed AND the SQL guard is removed
SQL_DEF="$(psql_q -c "select pg_get_functiondef('public.commit_versioned_effect_step(uuid,uuid,text,integer,bigint,uuid,jsonb)'::regprocedure)")"
mutate_interp "        case 'ambiguous':
          return exit({ ...base, steps, kind: 'awaiting_effect_resolution'" "        case 'confirmed_by_mutant':
          return exit({ ...base, steps, kind: 'awaiting_effect_resolution'"
python3 - "$INTERP" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
a = "        case 'confirmed': {"
assert a in s
open(p, 'w').write(s.replace(a, "        case 'ambiguous':\n        case 'confirmed': {", 1))
PY
printf '%s' "$SQL_DEF" | python3 -c "
import sys
s = sys.stdin.read(); a = \"IF v_eff.state <> 'confirmed' THEN\"
assert a in s
open('/tmp/mut_step.sql', 'w').write(s.replace(a, 'IF false THEN', 1))"
psql_ -q < /tmp/mut_step.sql >/dev/null
expect_failure "advance past an ambiguous effect (interpreter + SQL guard both broken)" "M05/M06/M07" X02
printf '%s' "$SQL_DEF" | psql_ -q >/dev/null
echo "mutation check complete: every mutant was detected and the sources were restored"
