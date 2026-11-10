#!/usr/bin/env bash
# Real PostgreSQL QA of the Meta Ads migrations on a DISPOSABLE, ISOLATED database. Nothing here touches production.
#   * a throw-away container from an image that already exists locally (no pull), NO network at all (--network none: no published port, no route),
#     no volume (tmpfs data dir), hard CPU/RAM/pids limits and the lowest CPU share, removed on exit;
#   * round 1: 20261116 -> phase-1 -> 20261117 -> phase-2 -> JSON export -> 20261118 -> phase-3 -> range JSON export -> rollback drills (118, then 117) -> re-apply both -> phase 2 and 3 again;
#   * the container is DESTROYED, a second empty one is created and the whole sequence is replayed from scratch (migration replay).
# Usage: qa/meta-ads/run-sql-qa.sh [outdir]       (needs: docker, the postgres:15-alpine image)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${1:-$(mktemp -d)}"
IMAGE="${QA_PG_IMAGE:-postgres:15-alpine}"
M1="$ROOT/supabase/migrations/20261116000000_meta_ads_catalog.sql"
M2="$ROOT/supabase/migrations/20261117000000_meta_ads_insights.sql"
M3="$ROOT/supabase/migrations/20261118000000_meta_ads_extended_metrics.sql"
RB="$ROOT/docs/integrations/meta-ads/ROLLBACK-insights.sql"
RB3="$ROOT/docs/integrations/meta-ads/ROLLBACK-extended.sql"
mkdir -p "$OUT"
case "$IMAGE" in postgres:*) ;; *) echo "refusing unexpected image: $IMAGE" >&2; exit 2 ;; esac
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "image $IMAGE not present locally (this script never pulls)"; exit 2; }

CTR=""
cleanup() { [ -n "$CTR" ] && docker rm -f "$CTR" >/dev/null 2>&1 || true; CTR=""; }
trap cleanup EXIT

start_db() { # $1 = round
  CTR="wacrm-sqlqa-$1-$$"
  docker run -d --rm --name "$CTR" --network none --cpus 0.3 --cpu-shares 2 --memory 256m --memory-swap 256m --pids-limit 100 \
    --tmpfs /var/lib/postgresql/data:rw,size=192m -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_PASSWORD=unused \
    "$IMAGE" -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c shared_buffers=16MB -c max_connections=10 -c autovacuum=off >/dev/null
  for _ in $(seq 1 90); do # 127.0.0.1 only answers once the FINAL server is up (the init server listens on the socket only)
    docker exec "$CTR" pg_isready -q -h 127.0.0.1 -U postgres 2>/dev/null && return 0
    sleep 1
  done
  echo "database did not start" >&2; return 1
}
psql_() { docker exec -i "$CTR" psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 "$@" 2>&1; }

run_round() { # $1 = round number
  local r="$1" log="$OUT/round$1.log"
  start_db "$r"
  {
    echo "== round $r: container isolation"; docker inspect "$CTR" --format 'network={{.HostConfig.NetworkMode}} ports={{json .NetworkSettings.Ports}} mounts={{len .Mounts}} cpus={{.HostConfig.NanoCpus}} mem={{.HostConfig.Memory}}'
    echo "== prerequisites"; psql_ < "$HERE/prereq.sql"
    echo "== apply 20261116"; psql_ -1 < "$M1"; echo "APPLY_20261116_OK"
    echo "== phase 1 checks"; psql_ < "$HERE/test-phase1.sql"
    echo "== apply 20261117"; psql_ -1 < "$M2"; echo "APPLY_20261117_OK"
    echo "== phase 2 checks"; psql_ < "$HERE/test-phase2.sql"
    echo "== json export (after 20261117)"; psql_ < "$HERE/export-json.sql" | grep '^{' > "$OUT/round$r.json"; echo "EXPORT_OK $(wc -c < "$OUT/round$r.json") bytes"
    echo "== apply 20261118"; psql_ -1 < "$M3"; echo "APPLY_20261118_OK"
    echo "== phase 3 checks"; psql_ < "$HERE/test-phase3.sql"
    echo "== json export (range)"; psql_ < "$HERE/export-range-json.sql" | grep '^{' > "$OUT/round$r-range.json"; echo "EXPORT_RANGE_OK $(wc -c < "$OUT/round$r-range.json") bytes"
    echo "== rollback drill: 20261118 only"; psql_ < "$RB3"; psql_ < "$HERE/drill118-assert.sql"
    echo "== rollback drill: 20261117 too"; psql_ < "$RB"; psql_ < "$HERE/drill-assert.sql"
    echo "== re-apply 20261117 + 20261118 after the drill"; psql_ -1 < "$M2"; echo "REAPPLY_20261117_OK"; psql_ < "$HERE/test-phase2.sql"; psql_ -1 < "$M3"; echo "REAPPLY_20261118_OK"; psql_ < "$HERE/test-phase3.sql"
  } 2>&1 | grep -v "^$" | tee "$log"
  # no failure marker and the OK markers present
  ! grep -q '^ERROR\|FAIL:' "$log" || { echo "ROUND $r FAILED"; return 1; }
  for m in APPLY_20261116_OK APPLY_20261117_OK APPLY_20261118_OK EXPORT_OK EXPORT_RANGE_OK REAPPLY_20261117_OK REAPPLY_20261118_OK; do grep -q "$m" "$log" || { echo "ROUND $r missing $m"; return 1; }; done
  echo "ROUND $r PASS: $(grep -c 'PASS:' "$log") checks"
  cleanup
  ! docker ps -a --format '{{.Names}}' | grep -q '^wacrm-sqlqa-' || { echo "container still present"; return 1; }
  echo "ROUND $r container destroyed"
}

run_round 1
run_round 2
cmp "$OUT/round1.json" "$OUT/round2.json" && cmp "$OUT/round1-range.json" "$OUT/round2-range.json" && echo "REPLAY_IDENTICAL_OUTPUT"
echo "OUTDIR=$OUT"
