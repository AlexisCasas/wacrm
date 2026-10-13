#!/usr/bin/env bash
# E4.2B1.2 QA (lease / fencing / CAS): the full B1.1 suite as regression plus
# L01-L24 on a clean throwaway PostgreSQL 17 with migrations 001..055.
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/sql/qa-lib.sh
qa_start
qa_txn_phase "$SQL/e42b11-t01-t09.sql" "$SQL/e42b11-t02-t18.sql" "$SQL/e42b12-suite.sql"
qa_commit_fixtures
qa_conc e42b11-t12-t14.sh
qa_conc e42b12-concurrency.sh
qa_verdict "E4.2B1.2 LEASE CAS" \
  T01 T02 T03 T04 T05 T06 T07 T08 T09 T10 T11 T12 T13 T14 T15 T16 T17 T18 \
  L01 L02 L03 L04 L05 L06 L07 L08 L09 L10 L11 L12 L13 L14 L15 L16 L17 L18 L19 L20 L21 L22 L23 L24
