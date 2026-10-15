#!/bin/sh
# READ-ONLY. Prints every alert and exits 1 if any count is above zero. NOT scheduled.
# Usage: alerts-p8.sh [hours] [known run id ...]     e.g.  alerts-p8.sh 24 d3408025-6191-4a6d-95c4-574bfe71e0e7
HOURS="${1:-24}"; shift 2>/dev/null
IGN="''"; for id in "$@"; do IGN="$IGN,'$id'"; done
docker exec -i supabase-db psql -U postgres -d postgres -At -F '|' -v hours="$HOURS" -v ignore_runs="$IGN" < "$(dirname "$0")/alerts-p8.sql" | awk -F'|' '{ printf "%-40s %s %s\n", $1, $2, $3; if ($2+0 > 0) bad=1 } END { exit bad }'
