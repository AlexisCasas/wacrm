#!/usr/bin/env bash
# E4.2B1.3 QA (versioned interpreter START -> END): full B1.1 + B1.2 regression, the 056 budget
# SQL tests, and the Node interpreter/store/snapshot tests run against the real database.
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/sql/qa-lib.sh
qa_start
qa_txn_phase "$SQL/e42b11-t01-t09.sql" "$SQL/e42b11-t02-t18.sql" "$SQL/e42b12-suite.sql" "$SQL/e42b13-suite.sql"
qa_commit_fixtures
qa_conc e42b11-t12-t14.sh
qa_conc e42b12-concurrency.sh
qa_vitest src/lib/flows/versioned-interpreter.pg.test.ts
qa_verdict "E4.2B1.3 INTERPRETER" \
  T01 T02 T03 T04 T05 T06 T07 T08 T09 T10 T11 T12 T13 T14 T15 T16 T17 T18 \
  L01 L02 L03 L04 L05 L06 L07 L08 L09 L10 L11 L12 L13 L14 L15 L16 L17 L18 L19 L20 L21 L22 L23 L24 \
  L25 L26 L27 L28 \
  I01 I02 I03 I04 I05 I06 I07 I08 I09 I09b I10 I11 I12 I13 I14 I15 I16 I17 I18 I19 I20 I21
