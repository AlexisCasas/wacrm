#!/usr/bin/env bash
# E4.2B2.1 QA (subflow call frames: push/pop RPCs of migration 057): the complete B1.1-B1.3
# regression (SQL suites, real-session concurrency, Node interpreter on PostgreSQL) plus S01-S23.
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/sql/qa-lib.sh
qa_start
qa_txn_phase "$SQL/e42b11-t01-t09.sql" "$SQL/e42b11-t02-t18.sql" "$SQL/e42b12-suite.sql" "$SQL/e42b13-suite.sql" "$SQL/e42b21-suite.sql"
qa_commit_fixtures
qa_conc e42b11-t12-t14.sh
qa_conc e42b12-concurrency.sh
qa_conc e42b21-concurrency.sh
qa_vitest src/lib/flows/versioned-interpreter.pg.test.ts
qa_verdict "E4.2B2.1 CALL FRAME" \
  T01 T02 T03 T04 T05 T06 T07 T08 T09 T10 T11 T12 T13 T14 T15 T16 T17 T18 \
  L01 L02 L03 L04 L05 L06 L07 L08 L09 L10 L11 L12 L13 L14 L15 L16 L17 L18 L19 L20 L21 L22 L23 L24 L25 L26 L27 L28 \
  I01 I02 I03 I04 I05 I06 I07 I08 I09 I09b I10 I11 I12 I13 I14 I15 I16 I17 I18 I19 I20 I21 \
  S01 S02 S03 S04 S05 S06 S07 S08 S09 S10 S11 S12 S13 S14 S15 S16 S17 S18 S19 S20 S21 S22 S23 S24 S25
