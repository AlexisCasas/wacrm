#!/usr/bin/env bash
# E4.2B1.1 QA (create_versioned_flow_run): T01-T18 on a clean throwaway PostgreSQL 17.
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/sql/qa-lib.sh
qa_start
qa_txn_phase "$SQL/e42b11-t01-t09.sql" "$SQL/e42b11-t02-t18.sql"   # T01-T11, T15-T18
qa_commit_fixtures
qa_conc e42b11-t12-t14.sh                                             # T12-T14, two real sessions
qa_verdict "E4.2B1.1 FULL SQL QA" T01 T02 T03 T04 T05 T06 T07 T08 T09 T10 T11 T12 T13 T14 T15 T16 T17 T18
