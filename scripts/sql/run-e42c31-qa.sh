#!/usr/bin/env bash
# E4.2C3.1 QA (offline Meta adapter + Inbox persistence, migration 060): the complete B1.1-C2 regression plus P01-P12
# (SQL) and N01-N18 (interpreter + adapter + scripted HTTP transport). For the mutation proof run mutation-e42c3.sh.
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/sql/qa-lib.sh
qa_start
qa_txn_phase "$SQL/e42b11-t01-t09.sql" "$SQL/e42b11-t02-t18.sql" "$SQL/e42b12-suite.sql" "$SQL/e42b13-suite.sql" "$SQL/e42b21-suite.sql" "$SQL/e42c1-suite.sql" "$SQL/e42c31-suite.sql"
qa_commit_fixtures
qa_conc e42b11-t12-t14.sh
qa_conc e42b12-concurrency.sh
qa_conc e42b21-concurrency.sh
qa_conc e42c1-concurrency.sh
qa_conc e42c31-concurrency.sh
qa_vitest src/lib/flows/versioned-interpreter.pg.test.ts src/lib/flows/versioned-subflow.pg.test.ts src/lib/flows/versioned-effects.pg.test.ts src/lib/flows/versioned-messaging.pg.test.ts src/lib/flows/versioned-meta-sender.pg.test.ts
qa_verdict "E4.2C3.1 META ADAPTER OFFLINE" \
  T01 T02 T03 T04 T05 T06 T07 T08 T09 T10 T11 T12 T13 T14 T15 T16 T17 T18 \
  L01 L02 L03 L04 L05 L06 L07 L08 L09 L10 L11 L12 L13 L14 L15 L16 L17 L18 L19 L20 L21 L22 L23 L24 L25 L26 L27 L28 \
  I01 I02 I03 I04 I05 I06 I07 I08 I09 I09b I10 I11 I12 I13 I14 I15 I16 I17 I18 I19 I20 I21 \
  S01 S02 S03 S04 S05 S06 S07 S08 S09 S10 S11 S12 S13 S14 S15 S16 S17 S18 S19 S20 S21 S22 S23 S24 S25 \
  I22 I23 I24 I25 I26 I27 I28 I29 I30 I31 I32 I33 I34 I35 \
  E01 E02 E03 E04 E05 E06 E07 E08 E09 E10 E11 E12 E13 E14 E15 E16 E17 E18 E19 E20 E21 E22 E23 E24 \
  M01 M02 M03 M04 M05 M06 M07 M08 M09 M10 M11 M12 M13 M14 M15 M16 M17 M18 M19 M20 M21 M22 \
  P01 P02 P03 P04 P05 P06 P07 P08 P09 P10 P11 P12 \
  N01 N02 N03 N04 N05 N06 N07 N08 N09 N10 N11 N12 N13 N14 N15 N16 N17 N18
